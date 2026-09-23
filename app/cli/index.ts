#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { getRuntimePaths, ensureRuntime } from "../server/runtime.js";
import { assertStopTarget } from "./safety.js";
import { LibraryStore } from "../server/library.js";
import { startServer } from "../server/index.js";

const PORT = Number(process.env.TASTE_PORT ?? 4178);
// 设置 TASTE_URL 时连接远程服务（如 https://lab.xxx.ts.net），服务的启停由那台机器管理。
const REMOTE = process.env.TASTE_URL?.replace(/\/+$/, "") || null;
const BASE = REMOTE ?? `http://127.0.0.1:${PORT}`;

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
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? `HTTP ${response.status}`));
  return payload;
}

async function health(): Promise<{ ok: boolean; pid: number; home: string } | null> {
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(REMOTE ? 8000 : 800) });
    return response.ok ? await response.json() as { ok: boolean; pid: number; home: string } : null;
  } catch {
    return null;
  }
}

async function start(openBrowser: boolean): Promise<void> {
  const paths = ensureRuntime(getRuntimePaths());
  const current = await health();
  if (current && current.home !== paths.home) {
    throw new Error(`端口 ${PORT} 已由另一个 Taste Runtime 使用：${current.home}`);
  }
  if (!current) {
    const here = dirname(fileURLToPath(import.meta.url));
    const serverEntry = join(here, "..", "server", "index.js");
    const logFd = openSync(paths.serverLog, "a", 0o600);
    const child = spawn(process.execPath, [serverEntry], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    closeSync(logFd);
    for (let attempt = 0; attempt < 50 && !(await health()); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const started = await health();
    if (!started || started.home !== paths.home) throw new Error(`Taste 启动失败，请查看 ${paths.serverLog}`);
  }
  if (openBrowser) spawnSync("/usr/bin/open", [BASE]);
  console.log(BASE);
}

// 在当前终端前台运行服务并打开浏览器，Ctrl+C 或关闭终端即停止；已有服务在跑时只打开浏览器。
async function serve(): Promise<void> {
  const paths = ensureRuntime(getRuntimePaths());
  const current = await health();
  if (current && current.home !== paths.home) {
    throw new Error(`端口 ${PORT} 已由另一个 Taste Runtime 使用：${current.home}`);
  }
  if (current) {
    spawnSync("/usr/bin/open", [BASE]);
    console.log(`Taste 已在运行（PID ${current.pid}）：${BASE}，用 taste stop 停止。`);
    return;
  }
  await startServer();
  spawnSync("/usr/bin/open", [BASE]);
  console.log("按 Ctrl+C 停止。");
}

async function stop(): Promise<void> {
  const paths = getRuntimePaths();
  if (!existsSync(paths.serverInfo)) {
    console.log("Taste 未运行。");
    return;
  }
  const info = JSON.parse(readFileSync(paths.serverInfo, "utf8")) as { pid: number };
  const live = assertStopTarget(info, await health(), paths.home);
  process.kill(live.pid, "SIGTERM");
  console.log("Taste 已停止。");
}

async function regeneratePreviews(): Promise<void> {
  const store = new LibraryStore();
  try {
    output(store.regeneratePreviews());
  } finally {
    store.close();
  }
}

// 导入统一上传文件内容，本机与远程服务走同一条路径；服务端确认入库后，默认移动模式才删除本机源文件。
async function importFiles(paths: string[], mode: "move" | "copy", fields: { title?: string; note?: string; tags?: string[]; itemId?: string }): Promise<unknown> {
  if (paths.length === 0) throw new Error("至少需要一个文件路径。");
  const files = paths.map((path) => ({ name: basename(path), data: readFileSync(path).toString("base64") }));
  const payload = await request("/api/import/uploads", { method: "POST", body: JSON.stringify({ files, ...fields }) });
  if (mode === "move") {
    const failures: string[] = [];
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        failures.push(path);
      }
    }
    if (failures.length > 0) throw new Error(`内容已安全导入，但未能移除以下源文件：${failures.join("、")}`);
  }
  return payload;
}

function output(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function help(): never {
  console.log(`Taste CLI

  设置 TASTE_URL（如 https://lab.xxx.ts.net）后连接远程服务：taste / taste open 打开浏览器，
  start、stop、regenerate-previews 需在服务所在机器执行；未设置时使用本机 127.0.0.1:${PORT}。

  taste                     前台运行并打开浏览器，Ctrl+C 停止
  taste start [--open]      后台运行
  taste stop | status
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
  taste regenerate-previews      重建图片预览（在服务所在机器执行）

  import 与 asset add 上传文件内容，默认在服务端入库后删除本机源文件，--copy 保留。
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help") help();
  if (REMOTE) {
    if (!command || command === "open") {
      spawnSync("/usr/bin/open", [BASE]);
      console.log(BASE);
      return;
    }
    if (["start", "stop", "regenerate-previews"].includes(command)) throw new Error(`Taste 运行在 ${BASE}，${command} 需在那台机器上执行。`);
    if (command === "status") return output({ running: Boolean(await health()), url: BASE });
    if (!(await health())) throw new Error(`连不上 Taste 服务：${BASE}`);
    return run(command, args);
  }
  if (!command) return serve();
  if (command === "start") return start(args.includes("--open"));
  if (command === "stop") return stop();
  if (command === "status") {
    const current = await health();
    const expectedHome = getRuntimePaths().home;
    output({ running: current?.home === expectedHome, url: BASE, home: expectedHome, occupiedBy: current && current.home !== expectedHome ? current.home : undefined });
    return;
  }
  if (command === "regenerate-previews") return regeneratePreviews();
  const current = await health();
  if (current && current.home !== getRuntimePaths().home) throw new Error(`端口 ${PORT} 已由另一个 Taste Runtime 使用：${current.home}`);
  if (!current) await start(false);
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
