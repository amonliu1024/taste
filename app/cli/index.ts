#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { getRuntimePaths, ensureRuntime } from "../server/runtime.js";
import { createPreview, readImageDimensions } from "../server/preview.js";
import { assertStopTarget } from "./safety.js";

const PORT = Number(process.env.TASTE_PORT ?? 4178);
const BASE = `http://127.0.0.1:${PORT}`;

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
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
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

// 用当前预览生成逻辑重新生成所有图片素材的预览图，并更新数据库中的 preview_path。
// HTML 素材的预览由 Chromium 截图生成，此命令不动它们（之前的预览规则未变）。
async function regeneratePreviews(): Promise<void> {
  const paths = getRuntimePaths();
  if (!existsSync(paths.db)) throw new Error(`数据库不存在：${paths.db}`);
  const db = new DatabaseSync(paths.db);
  const rows = db.prepare("SELECT id, kind, storage_path, preview_path, width, height FROM assets WHERE state = 'active' AND kind = 'image' ORDER BY created_at").all() as { id: string; kind: string; storage_path: string; preview_path: string | null; width: number | null; height: number | null }[];
  let regenerated = 0;
  let dimensionsBackfilled = 0;
  const unchanged: string[] = [];
  const failed: { id: string; name: string; reason: string }[] = [];
  for (const row of rows) {
    const source = row.storage_path;
    if (!existsSync(source)) { failed.push({ id: row.id, name: source, reason: "原文件缺失" }); continue; }
    const dims = row.width && row.height ? { width: Number(row.width), height: Number(row.height) } : readImageDimensions(source);
    // 缺尺寸的素材会被当成“超大图”压缩预览，也无法按需换原图、无法双击还原原始尺寸，顺手补回来。
    if (!(row.width && row.height) && dims) {
      db.prepare("UPDATE assets SET width = ?, height = ? WHERE id = ?").run(dims.width, dims.height, row.id);
      dimensionsBackfilled += 1;
    }
    const destinationBase = join(paths.previews, row.id);
    const created = createPreview("image", source, destinationBase, dims);
    if (!created) { failed.push({ id: row.id, name: source, reason: "预览生成失败" }); continue; }
    const oldPath = row.preview_path;
    if (oldPath && oldPath !== created && existsSync(oldPath)) rmSync(oldPath, { force: true });
    if (oldPath !== created) {
      db.prepare("UPDATE assets SET preview_path = ? WHERE id = ?").run(created, row.id);
    }
    regenerated += 1;
    unchanged.push(`${row.id.slice(0, 8)} → ${extname(created)}`);
  }
  output({ total: rows.length, regenerated, dimensionsBackfilled, failed, sample: unchanged.slice(0, 5) });
}

function output(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function help(): never {
  console.log(`Taste CLI

  taste start [--open]
  taste stop | status
  taste list | search <query> | show <item-id>
  taste create [--title <text>] [--note <text>] [--tag <tag>...]
  taste import <paths...> [--copy] [--title <text>] [--note <text>] [--tag <tag>...]
  taste update <item-id> [--title <text>] [--note <text>] [--tags <a,b>]
  taste asset add <item-id> <paths...> [--copy]
  taste asset move <asset-id> <item-id|staged>
  taste asset trash|restore <asset-id>
  taste layout <asset-id> --x <n> --y <n> --width <n> --height <n>
  taste item front <item-id>
  taste item before <item-id> <target-item-id>
  taste item reorder <item-id>...
  taste item trash|restore <item-id>
  taste staged | trash
  taste trash empty --permanently
  taste regenerate-previews
`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") help();
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
  if (command === "list") return output(await request("/api/items"));
  if (command === "search") return output(await request(`/api/items?q=${encodeURIComponent(args.join(" "))}`));
  if (command === "show") return output(await request(`/api/items/${args[0]}`));
  if (command === "create") {
    return output(await request("/api/items", { method: "POST", body: JSON.stringify({
      title: value(args, "--title") ?? "", note: value(args, "--note") ?? "", tags: values(args, "--tag"),
    }) }));
  }
  if (command === "import") {
    return output(await request("/api/import/paths", { method: "POST", body: JSON.stringify({
      paths: positionals(args), mode: args.includes("--copy") ? "copy" : "move", title: value(args, "--title"), note: value(args, "--note") ?? "", tags: values(args, "--tag"),
    }) }));
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
      return output(await request("/api/import/paths", { method: "POST", body: JSON.stringify({
        itemId: first, paths: positionals(rest), mode: rest.includes("--copy") ? "copy" : "move",
      }) }));
    }
    if (action === "move") return output(await request(`/api/assets/${first}`, { method: "PATCH", body: JSON.stringify({ targetItemId: rest[0] === "staged" ? null : rest[0] }) }));
    if (["trash", "restore"].includes(action)) return output(await request(`/api/assets/${first}/${action}`, { method: "POST", body: "{}" }));
  }
  throw new Error("未知命令。运行 taste help 查看用法。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
