import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface ClientConfig {
  url: string;
  token: string;
  path: string;
  sources: { url: string; token: string };
}

export function configuration(): ClientConfig {
  const path = resolve(process.env.TASTE_CONFIG || join(homedir(), ".config", "taste", "client.json"));
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      file = parsed as Record<string, unknown>;
    } catch {
      throw new Error("客户端配置无法读取，请检查 TASTE_CONFIG 指向的 JSON 文件。");
    }
    if (file.token && (statSync(path).mode & 0o077) !== 0) throw new Error("客户端配置含凭据，请将文件权限设置为 600。");
  } else if (process.env.TASTE_CONFIG) {
    throw new Error("TASTE_CONFIG 指定的客户端配置不存在。");
  }
  const url = process.env.TASTE_URL ?? file.url;
  const token = process.env.TASTE_TOKEN ?? file.token;
  if (typeof url !== "string" || !url || typeof token !== "string" || !token.trim()) {
    throw new Error("请配置服务器 url 和 token：使用 ~/.config/taste/client.json，或 TASTE_URL / TASTE_TOKEN。客户端不会创建本地库。");
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Taste 服务地址无效。"); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) {
    throw new Error("Taste 连接必须使用 HTTPS；隔离测试允许回环 HTTP。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("服务地址只填写 URL，凭据请放在 token 字段。");
  if (/[\r\n]/.test(token)) throw new Error("客户端凭据格式无效。");
  return { url: parsed.href.replace(/\/+$/, ""), token, path, sources: {
    url: process.env.TASTE_URL !== undefined ? "TASTE_URL" : path,
    token: process.env.TASTE_TOKEN !== undefined ? "TASTE_TOKEN" : path,
  } };
}

export function describe(config: ClientConfig) {
  return { url: config.url, config: config.path, sources: config.sources, credentialReady: Boolean(config.token) };
}

export async function request(config: ClientConfig, path: string, options: RequestInit = {}, requestId?: string): Promise<Record<string, unknown>> {
  const write = !["GET", "HEAD"].includes(options.method ?? "GET");
  const id = write ? requestId ?? randomUUID() : undefined;
  let response: Response;
  let payload: Record<string, unknown>;
  try {
    response = await fetch(`${config.url}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`,
        ...(id ? { "idempotency-key": id } : {}), ...(options.headers ?? {}) },
    });
    payload = await response.json() as Record<string, unknown>;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    throw new Error(id
      ? `连接未完成，写入结果待核对。请求编号：${id}\n恢复连接后，用 taste --request-id ${id} 重试同一命令；导入源文件已保留。`
      : "连不上 Taste 服务，请检查连接配置和私网连接。");
  }
  if (!response.ok) throw new Error(`${String(payload.error ?? "请求被服务器拒绝")}（HTTP ${response.status}${id ? `，请求编号 ${id}` : ""}）`);
  if (id && response.headers.get("idempotency-key") !== id) {
    throw new Error(`服务器未确认持久化回执，写入结果待核对。请求编号：${id}；请先核对服务器版本，导入源文件已保留。`);
  }
  return payload;
}
