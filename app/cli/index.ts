#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { configuration, describe, request as remoteRequest, type ClientConfig } from "./client.js";

let config: ClientConfig;
let requestId: string | undefined;

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function values(args: string[], name: string): string[] {
  const result: string[] = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1]) result.push(args[index + 1]);
  });
  return result;
}

function positionals(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      if (!["--copy", "--open", "--permanently"].includes(args[index])) index += 1;
    } else result.push(args[index]);
  }
  return result;
}

async function request(path: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  return remoteRequest(config, path, options, requestId);
}

// 导入统一上传文件内容，本机与远程服务走同一条路径；服务端确认入库后，默认移动模式才删除本机源文件。
async function importFiles(paths: string[], mode: "move" | "copy", fields: { title?: string; note?: string; tags?: string[]; itemId?: string }): Promise<unknown> {
  if (paths.length === 0) throw new Error("至少需要一个文件路径。");
  const files = paths.map((path) => ({ name: basename(path), data: readFileSync(path).toString("base64") }));
  const payload = await request("/api/import/uploads", { method: "POST", body: JSON.stringify({ files, ...fields }) });
  if (mode === "move") {
    const failures: string[] = [];
    for (const [index, path] of paths.entries()) {
      try {
        if (readFileSync(path).toString("base64") !== files[index].data) throw new Error("源文件已变化");
        unlinkSync(path);
      } catch {
        failures.push(path);
      }
    }
    if (failures.length > 0) throw new Error(`内容已安全导入，但源文件已变化或未能移除：${failures.join("、")}`);
  }
  return payload;
}

// 服务器端生成一致的数据库快照：SQLite 在线备份不受正在进行的写入影响。
const SNAPSHOT_SCRIPT = `import sqlite3, sys
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close()
source.close()
`;

function sh(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${command} 失败：${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout;
}

// 把服务器上的 Runtime 拉回本机：数据库每次留一份带时间的快照，素材与预览只增不删，
// 所以任一快照配上同一目录下的 files/、previews/ 都能恢复到当时的状态。
async function backup(args: string[]): Promise<void> {
  const [host] = positionals(args);
  const remoteHome = value(args, "--remote-home") ?? ".local/share/taste";
  const destination = resolve(value(args, "--to") ?? join(homedir(), "Backups", "taste"));
  if (!host || !/^[A-Za-z0-9._@-]+$/.test(host) || host.startsWith("-")) throw new Error("用法：taste backup <ssh 主机> [--to <本机目录>] [--remote-home <服务器 Runtime 路径>]");
  if (!/^[A-Za-z0-9._/~-]+$/.test(remoteHome) || remoteHome.startsWith("-")) throw new Error("--remote-home 只能包含字母、数字和 ._/~-");
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const remoteSnapshot = `${remoteHome}/.incoming/backup-${stamp}.sqlite`;
  const ssh = ["-o", "BatchMode=yes", "-o", "LogLevel=ERROR"];
  const rsyncShell = ["-e", `ssh ${ssh.join(" ")}`];
  sh("ssh", [...ssh, host, "python3", "-", `${remoteHome}/db/taste.sqlite`, remoteSnapshot], SNAPSHOT_SCRIPT);
  try {
    for (const directory of ["files", "previews", "db"]) mkdirSync(join(destination, directory), { recursive: true, mode: 0o700 });
    for (const directory of ["files", "previews"]) sh("rsync", ["-a", ...rsyncShell, `${host}:${remoteHome}/${directory}/`, join(destination, directory) + "/"]);
    sh("rsync", ["-a", ...rsyncShell, `${host}:${remoteSnapshot}`, join(destination, "db", `taste-${stamp}.sqlite`)]);
  } finally {
    sh("ssh", [...ssh, host, "rm", "-f", remoteSnapshot]);
  }
  output({
    destination,
    snapshot: join(destination, "db", `taste-${stamp}.sqlite`),
    snapshots: readdirSync(join(destination, "db")).filter((name) => name.endsWith(".sqlite")).length,
    assets: readdirSync(join(destination, "files")).length,
  });
}

function output(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function help(): never {
  console.log(`Taste CLI

  配置 ~/.config/taste/client.json 的 url、token；TASTE_CONFIG 可指定路径，
  TASTE_URL / TASTE_TOKEN 可覆盖字段。客户端始终连接服务器，不启动本地库。

  taste / taste open        打开服务器网页
  taste config              查看连接地址、配置来源与凭据就绪状态（不显示凭据）
  taste doctor | status     验证连接和鉴权
  taste --request-id <UUID> <命令>   用原编号安全重试同一写入
  taste list | search <query> | show <item-id> | tags
  taste create [--title <text>] [--note <text>] [--tag <tag>...]
  taste import <paths...> [--copy] [--title <text>] [--note <text>] [--tag <tag>...]
  taste update <item-id> [--title <text>] [--note <text>] [--tags <a,b>]
  taste asset add <item-id> <paths...> [--copy]
  taste asset move <asset-id> <item-id|staged>
  taste asset rename <asset-id> <name>
  taste asset trash|restore <asset-id>
  taste asset crop <asset-id> auto|off
  taste layout <asset-id> --x <n> --y <n> --width <n> --height <n>
  taste item front <item-id>
  taste item before <item-id> <target-item-id>
  taste item reorder <item-id>...
  taste item trash|restore <item-id>
  taste staged | trash
  taste trash empty --permanently
  taste forms                    形态清单（一级分类）、说明与内容组数
  taste form add <name> [--desc <说明>]
  taste form remove <name>       只移出清单，不动内容组上的同名标签
  taste backup <ssh 主机> [--to <目录>] [--remote-home <路径>]
                                 把服务器 Runtime 拉回本机（默认 ~/Backups/taste）：数据库按时间留快照，素材只增不删

  import 与 asset add 上传文件内容，默认在服务端入库后删除本机源文件，--copy 保留。
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--request-id") {
    requestId = argv[1];
    if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("--request-id 需要 UUID，放在子命令之前。");
    argv.splice(0, 2);
  }
  const [command, ...args] = argv;
  if (command === "help" || command === "--help") help();
  if (command === "backup") return backup(args);
  if (["start", "stop", "regenerate-previews"].includes(command)) throw new Error("客户端不再提供本地服务模式；服务维护请在服务器上执行独立维护入口。");
  config = configuration();
  if (command === "config") return output(describe(config));
  if (!command || command === "open") {
    await request("/api/health");
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const opened = spawnSync(opener, [config.url]);
    console.log(config.url);
    if (opened.error || opened.status !== 0) console.error("请在浏览器中打开以上地址。");
    return;
  }
  if (["doctor", "status"].includes(command)) {
    const health = await request("/api/health");
    return output({ ...describe(config), running: health.ok === true });
  }
  return run(command, args);
}

async function run(command: string, args: string[]): Promise<void> {
  if (command === "list") return output(await request("/api/items"));
  if (command === "search") return output(await request(`/api/items?q=${encodeURIComponent(args.join(" "))}`));
  if (command === "show") return output(await request(`/api/items/${args[0]}`));
  if (command === "create") {
    return output(await request("/api/items", { method: "POST", body: JSON.stringify({
      title: value(args, "--title") ?? "", note: value(args, "--note") ?? "", tags: values(args, "--tag"),
    }) }));
  }
  if (command === "import") {
    return output(await importFiles(positionals(args), args.includes("--copy") ? "copy" : "move", {
      title: value(args, "--title"), note: value(args, "--note") ?? "", tags: values(args, "--tag"),
    }));
  }
  if (command === "update") {
    const id = args[0];
    return output(await request(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({
      title: value(args, "--title"), note: value(args, "--note"), tags: value(args, "--tags")?.split(",").map((tag) => tag.trim()).filter(Boolean),
    }) }));
  }
  if (command === "layout") return output(await request(`/api/assets/${args[0]}`, { method: "PATCH", body: JSON.stringify({
    x: Number(value(args, "--x")), y: Number(value(args, "--y")), width: Number(value(args, "--width")), height: Number(value(args, "--height")),
  }) }));
  if (command === "staged") return output(await request("/api/staged"));
  if (command === "tags") return output(await request("/api/tags"));
  if (command === "forms") return output(await request("/api/forms"));
  if (command === "form" && ["add", "remove"].includes(args[0])) {
    const name = positionals(args.slice(1)).join(" ");
    if (!name) throw new Error(`用法：taste form ${args[0]} <名称>${args[0] === "add" ? " [--desc <说明>]" : ""}`);
    if (args[0] === "add") {
      return output(await request("/api/forms", { method: "POST", body: JSON.stringify({ name, description: value(args, "--desc") ?? "" }) }));
    }
    return output(await request(`/api/forms/${encodeURIComponent(name)}`, { method: "DELETE" }));
  }
  if (command === "trash" && args[0] === "empty") {
    if (!args.includes("--permanently")) throw new Error("永久清空必须传入 --permanently。");
    return output(await request("/api/trash/empty", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) }));
  }
  if (command === "trash") return output(await request("/api/trash"));
  if (command === "item" && args[0] === "front") {
    return output(await request(`/api/items/${args[1]}/front`, { method: "POST", body: "{}" }));
  }
  if (command === "item" && args[0] === "before") {
    return output(await request(`/api/items/${args[1]}/before/${args[2]}`, { method: "POST", body: "{}" }));
  }
  if (command === "item" && args[0] === "reorder") {
    return output(await request("/api/items/reorder", { method: "POST", body: JSON.stringify({ itemIds: args.slice(1) }) }));
  }
  if (command === "item" && ["trash", "restore"].includes(args[0])) {
    return output(await request(`/api/items/${args[1]}/${args[0]}`, { method: "POST", body: "{}" }));
  }
  if (command === "asset") {
    const [action, first, ...rest] = args;
    if (action === "add") {
      return output(await importFiles(positionals(rest), rest.includes("--copy") ? "copy" : "move", { itemId: first }));
    }
    if (action === "move") return output(await request(`/api/assets/${first}`, { method: "PATCH", body: JSON.stringify({ targetItemId: rest[0] === "staged" ? null : rest[0] }) }));
    if (action === "rename" && rest[0]) return output(await request(`/api/assets/${first}`, { method: "PATCH", body: JSON.stringify({ name: rest.join(" ") }) }));
    if (["trash", "restore"].includes(action)) return output(await request(`/api/assets/${first}/${action}`, { method: "POST", body: "{}" }));
    if (action === "crop" && ["auto", "off"].includes(rest[0])) {
      return output(await request(`/api/assets/${first}/crop`, { method: "POST", body: JSON.stringify({ enabled: rest[0] === "auto" }) }));
    }
  }
  throw new Error("未知命令。运行 taste help 查看用法。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
