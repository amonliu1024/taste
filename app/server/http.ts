import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { LibraryStore } from "./library.js";

type Json = Record<string, unknown>;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".json": "application/json; charset=utf-8",
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

async function body(request: IncomingMessage, limit = 90 * 1024 * 1024): Promise<Json> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("请求必须使用 application/json。 ");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new Error("请求内容过大。 ");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
}

function assertLoopbackRequest(request: IncomingMessage): void {
  const host = request.headers.host;
  if (!host) throw new Error("请求缺少 Host。 ");
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new Error("请求 Host 无效。 ");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    throw new Error("Taste 只接受本机回环地址。 ");
  }

  const origin = request.headers.origin;
  if (!origin) return;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error("拒绝无效来源。 ");
  }
  if (parsedOrigin.protocol !== "http:" || parsedOrigin.host !== host) throw new Error("拒绝跨来源写入。 ");
}

function match(path: string, pattern: RegExp): RegExpMatchArray | null {
  return path.match(pattern);
}

function serveFile(response: ServerResponse, path: string, headers: Record<string, string> = {}): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    json(response, 404, { error: "文件不存在。" });
    return;
  }
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": statSync(path).size,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  createReadStream(path).pipe(response);
}

export interface TasteHttpServer {
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
  store: LibraryStore;
}

export function createTasteHttpServer(options: { home?: string; webRoot?: string } = {}): TasteHttpServer {
  const store = new LibraryStore(options.home);
  const webRoot = options.webRoot ?? join(process.cwd(), "dist");
  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    try {
      assertLoopbackRequest(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const path = decodeURIComponent(url.pathname);

      if (method === "GET" && path === "/api/health") {
        json(response, 200, { ok: true, pid: process.pid, home: store.paths.home });
        return;
      }
      if (method === "GET" && path === "/api/items") {
        json(response, 200, { items: store.listItems(url.searchParams.get("q") ?? "") });
        return;
      }
      if (method === "POST" && path === "/api/items") {
        const input = await body(request);
        json(response, 201, { item: store.createItem(
          String(input.title ?? ""),
          String(input.note ?? ""),
          Array.isArray(input.tags) ? input.tags.map(String) : [],
        ) });
        return;
      }
      const itemMatch = match(path, /^\/api\/items\/([^/]+)$/);
      if (method === "GET" && itemMatch) {
        json(response, 200, { item: store.getItem(itemMatch[1]) });
        return;
      }
      if (method === "PATCH" && itemMatch) {
        const input = await body(request);
        json(response, 200, { item: store.updateItem(itemMatch[1], {
          title: input.title === undefined ? undefined : String(input.title),
          note: input.note === undefined ? undefined : String(input.note),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
        }) });
        return;
      }
      const itemFrontMatch = match(path, /^\/api\/items\/([^/]+)\/front$/);
      if (method === "POST" && itemFrontMatch) {
        json(response, 200, { items: store.bringItemToFront(itemFrontMatch[1]) });
        return;
      }
      const itemBeforeMatch = match(path, /^\/api\/items\/([^/]+)\/before\/([^/]+)$/);
      if (method === "POST" && itemBeforeMatch) {
        json(response, 200, { items: store.moveItemBefore(itemBeforeMatch[1], itemBeforeMatch[2]) });
        return;
      }
      if (method === "POST" && path === "/api/items/reorder") {
        const input = await body(request);
        json(response, 200, { items: store.reorderItems(Array.isArray(input.itemIds) ? input.itemIds.map(String) : []) });
        return;
      }
      if (method === "POST" && path === "/api/import/paths") {
        const input = await body(request);
        json(response, 201, { item: store.importPaths(
          Array.isArray(input.paths) ? input.paths.map(String) : [],
          {
            title: input.title === undefined ? undefined : String(input.title),
            note: input.note === undefined ? undefined : String(input.note),
            tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
            mode: input.mode === "copy" ? "copy" : "move",
            itemId: input.itemId ? String(input.itemId) : undefined,
          },
        ) });
        return;
      }
      if (method === "POST" && path === "/api/import/uploads") {
        const input = await body(request);
        const files = Array.isArray(input.files) ? input.files.map((file) => {
          const candidate = file as Json;
          return { name: String(candidate.name ?? ""), data: String(candidate.data ?? "") };
        }) : [];
        json(response, 201, { item: store.importUploads(files, {
          title: input.title === undefined ? undefined : String(input.title),
          note: input.note === undefined ? undefined : String(input.note),
          tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
          itemId: input.itemId ? String(input.itemId) : undefined,
        }) });
        return;
      }
      const itemTrashMatch = match(path, /^\/api\/items\/([^/]+)\/(trash|restore)$/);
      if (method === "POST" && itemTrashMatch) {
        json(response, 200, { item: itemTrashMatch[2] === "trash" ? store.trashItem(itemTrashMatch[1]) : store.restoreItem(itemTrashMatch[1]) });
        return;
      }
      const assetMatch = match(path, /^\/api\/assets\/([^/]+)$/);
      if (method === "PATCH" && assetMatch) {
        const input = await body(request);
        if (["x", "y", "width", "height"].every((key) => typeof input[key] === "number")) {
          json(response, 200, { asset: store.updateLayout(assetMatch[1], {
            x: Number(input.x), y: Number(input.y), width: Number(input.width), height: Number(input.height),
          }) });
        } else {
          const target = input.targetItemId === null || input.targetItemId === "staged" ? null : String(input.targetItemId ?? "");
          json(response, 200, { asset: store.moveAsset(assetMatch[1], target || null) });
        }
        return;
      }
      const assetActionMatch = match(path, /^\/api\/assets\/([^/]+)\/(trash|restore)$/);
      if (method === "POST" && assetActionMatch) {
        json(response, 200, { asset: assetActionMatch[2] === "trash" ? store.trashAsset(assetActionMatch[1]) : store.restoreAsset(assetActionMatch[1]) });
        return;
      }
      if (method === "POST" && path === "/api/assets/export") {
        const input = await body(request);
        const targetDirectory = typeof input.targetDirectory === "string" && input.targetDirectory.trim() ? input.targetDirectory.trim() : undefined;
        json(response, 200, store.exportAssets(Array.isArray(input.assetIds) ? input.assetIds.map(String) : [], targetDirectory));
        return;
      }
      const exportMatch = match(path, /^\/api\/assets\/([^/]+)\/export$/);
      if (method === "POST" && exportMatch) {
        const input = await body(request);
        const targetPath = typeof input.targetPath === "string" && input.targetPath.trim() ? input.targetPath.trim() : undefined;
        json(response, 200, store.exportAsset(exportMatch[1], targetPath));
        return;
      }
      if (method === "GET" && path === "/api/staged") {
        json(response, 200, { assets: store.listStaged() });
        return;
      }
      if (method === "POST" && path === "/api/staged/items") {
        const input = await body(request);
        json(response, 201, { item: store.createItemFromStaged(
          Array.isArray(input.assetIds) ? input.assetIds.map(String) : [],
          String(input.title ?? ""),
          String(input.note ?? ""),
          Array.isArray(input.tags) ? input.tags.map(String) : [],
        ) });
        return;
      }
      if (method === "GET" && path === "/api/trash") {
        json(response, 200, store.listTrash());
        return;
      }
      if (method === "POST" && path === "/api/trash/empty") {
        const input = await body(request);
        json(response, 200, store.emptyTrash(String(input.confirm ?? "")));
        return;
      }

      const mediaMatch = match(path, /^\/media\/([^/]+)\/(original|preview)$/);
      if (method === "GET" && mediaMatch) {
        const file = store.resolveAssetPath(mediaMatch[1], mediaMatch[2] as "original" | "preview");
        serveFile(response, file.path, { "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` });
        return;
      }
      const htmlMatch = match(path, /^\/html\/([^/]+)$/);
      if (method === "GET" && htmlMatch) {
        const file = store.resolveAssetPath(htmlMatch[1], "original");
        if (file.kind !== "html") throw new Error("该文件不是 HTML。 ");
        serveFile(response, file.path, {
          "content-security-policy": "sandbox allow-scripts; default-src 'self' data: blob: https:; style-src 'unsafe-inline' 'self' https:; script-src 'unsafe-inline' 'unsafe-eval' 'self' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:",
          "cache-control": "no-store",
        });
        return;
      }

      if (method === "GET") {
        const relative = path === "/" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
        const candidate = join(webRoot, relative);
        if (candidate.startsWith(webRoot) && existsSync(candidate) && statSync(candidate).isFile()) {
          serveFile(response, candidate, { "cache-control": relative === "index.html" ? "no-store" : "public, max-age=31536000, immutable" });
          return;
        }
        const index = join(webRoot, "index.html");
        if (existsSync(index)) {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(readFileSync(index));
          return;
        }
      }
      json(response, 404, { error: "未找到。" });
    } catch (error) {
      json(response, 400, { error: errorMessage(error) });
    }
  });

  return {
    store,
    listen(port = 4178, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          store.close();
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
