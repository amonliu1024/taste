import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readClients(path?: string): Record<string, string> | undefined {
  if (!path) return undefined;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error("服务端凭据文件权限必须为 600。");
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>; }
  catch { throw new Error("无法读取服务端客户端凭据文件。"); }
}

export class Access {
  constructor(private readonly clients?: Record<string, string>) {
    if (clients !== undefined && (!clients || typeof clients !== "object" || Array.isArray(clients) || !Object.keys(clients).length ||
        Object.entries(clients).some(([name, token]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || typeof token !== "string" || token.length < 32 || /\s/.test(token)) ||
        new Set(Object.values(clients)).size !== Object.keys(clients).length)) {
      throw new Error("客户端凭据应为名称到独立 Token 的映射，每个 Token 至少 32 字符。");
    }
  }

  tokenClient(token: string): string | undefined {
    return Object.entries(this.clients ?? {}).find(([, expected]) => equal(token, expected))?.[0];
  }

  authenticate(request: IncomingMessage): string {
    if (!this.clients) return "development";
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const client = this.tokenClient(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (client) return client;
      throw new HttpError(401, "访问凭据无效。");
    }
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("taste_session="))?.slice(14);
    if (cookie) {
      const [client, expires, signature, extra] = cookie.split(".");
      const token = Object.hasOwn(this.clients, client) ? this.clients[client] : undefined;
      if (!extra && token && Number(expires) > Date.now() && equal(signature ?? "", this.signature(client, expires, token))) return client;
    }
    throw new HttpError(401, "请在网页输入访问凭据，或配置客户端 Token。");
  }

  session(token: string, secure: boolean): string {
    const client = this.tokenClient(token);
    if (!client || !this.clients) throw new HttpError(401, "访问凭据无效。");
    const expires = String(Date.now() + 30 * 86400000);
    const value = `${client}.${expires}.${this.signature(client, expires, this.clients[client])}`;
    return `taste_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? "; Secure" : ""}`;
  }

  private signature(client: string, expires: string, token: string): string {
    return createHmac("sha256", token).update(`taste-session:${client}:${expires}`).digest("hex");
  }
}

export const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taste 访问</title>
<style>body{font:16px "Anthropic Serif Text",Georgia,serif;background:#fcfcfb;color:#222;max-width:360px;margin:15vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:16px;border:1px solid #ccc;border-radius:4px}button{background:#222;color:white;cursor:pointer}</style>
<h1>Taste</h1><p>输入访问凭据，连接你的素材库。</p><form method="post" action="/auth"><label for="token">访问凭据</label><input id="token" name="token" type="password" autocomplete="current-password" required><button>进入素材库</button></form></html>`;
