import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createTasteHttpServer } from "./http.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_OTHER = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");

function requestWithHost(port: number, path: string, host: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: origin ? "POST" : "GET", headers: {
      host,
      ...(origin ? { origin, "content-type": "application/json", "content-length": "2" } : {}),
    } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(origin ? "{}" : undefined);
  });
}

test("HTTP uses the store contract and blocks cross-origin writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "taste-http-"));
  const source = join(root, "source.png");
  writeFileSync(source, PNG);
  const server = createTasteHttpServer({ home: join(root, "runtime"), webRoot: join(root, "web") });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const emptyResponse = await fetch(`${base}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "待补灵感", note: "空内容", tags: ["待补"] }),
    });
    assert.equal(emptyResponse.status, 201);
    const empty = await emptyResponse.json() as { item: { id: string; title: string; assets: unknown[] } };
    assert.equal(empty.item.assets.length, 0);
    assert.equal(empty.item.title, "待补灵感");

    const importedResponse = await fetch(`${base}/api/import/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name: "source.png", data: PNG.toString("base64") }], note: "HTTP 导入", tags: ["测试"] }),
    });
    assert.equal(importedResponse.status, 201);
    const imported = await importedResponse.json() as { item: { id: string; assets: Array<{ id: string }> } };

    const front = await fetch(`${base}/api/items/${empty.item.id}/front`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(front.status, 200);
    assert.equal(((await front.json()) as { items: Array<{ id: string }> }).items[0].id, empty.item.id);

    const reordered = await fetch(`${base}/api/items/${imported.item.id}/before/${empty.item.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(reordered.status, 200);
    const exactOrder = await fetch(`${base}/api/items/reorder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemIds: [empty.item.id, imported.item.id] }) });
    assert.equal(exactOrder.status, 200);
    assert.deepEqual(((await exactOrder.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id), [empty.item.id, imported.item.id]);
    assert.equal(((await reordered.json()) as { items: Array<{ id: string }> }).items[0].id, imported.item.id);

    const listed = await (await fetch(`${base}/api/items?q=${encodeURIComponent("测试")}`)).json() as { items: unknown[] };
    assert.equal(listed.items.length, 1);

    const blocked = await fetch(`${base}/api/items/${imported.item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ note: "不应写入" }),
    });
    assert.equal(blocked.status, 400);

    assert.equal(await requestWithHost(address.port, "/api/health", "evil.example"), 400);
    assert.equal(await requestWithHost(address.port, "/api/trash/empty", "evil.example", "http://evil.example"), 400);

    const staged = await fetch(`${base}/api/assets/${imported.item.assets[0].id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetItemId: null }),
    });
    assert.equal(staged.status, 200);
    const staging = await (await fetch(`${base}/api/staged`)).json() as { assets: unknown[] };
    assert.equal(staging.assets.length, 1);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP manages the forms list", async () => {
  const root = mkdtempSync(join(tmpdir(), "taste-http-"));
  const server = createTasteHttpServer({ home: join(root, "runtime"), webRoot: join(root, "web") });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const listed = await (await fetch(`${base}/api/forms`)).json() as { forms: Array<{ name: string; description: string; count: number }> };
    assert.equal(listed.forms.length, 14);
    assert.equal(listed.forms[0].name, "网页");

    const added = await fetch(`${base}/api/forms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "动效", description: "动效与视频类界面" }),
    });
    assert.equal(added.status, 201);
    assert.equal(((await added.json()) as { forms: unknown[] }).forms.length, 15);

    const duplicate = await fetch(`${base}/api/forms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "动效" }),
    });
    assert.equal(duplicate.status, 400);

    const removed = await fetch(`${base}/api/forms/${encodeURIComponent("动效")}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { forms: unknown[] }).forms.length, 14);

    const missing = await fetch(`${base}/api/forms/${encodeURIComponent("不存在")}`, { method: "DELETE" });
    assert.equal(missing.status, 400);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP exports one asset as the original file and several as one zip", async () => {
  const root = mkdtempSync(join(tmpdir(), "taste-http-"));
  const server = createTasteHttpServer({ home: join(root, "runtime"), webRoot: join(root, "web") });
  const address = await server.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const upload = async (name: string, data: Buffer) => {
    const response = await fetch(`${base}/api/import/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: [{ name, data: data.toString("base64") }] }),
    });
    return ((await response.json()) as { item: { assets: Array<{ id: string }> } }).item.assets[0].id;
  };
  try {
    const first = await upload("参考图.png", PNG);
    const second = await upload("参考图.png", PNG_OTHER);

    const single = await fetch(`${base}/api/export?ids=${first}`);
    assert.equal(single.status, 200);
    assert.match(single.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''%E5%8F%82/);
    assert.deepEqual(Buffer.from(await single.arrayBuffer()), PNG);

    const archive = await fetch(`${base}/api/export?ids=${first},${second}`);
    assert.equal(archive.headers.get("content-type"), "application/zip");
    const zip = join(root, "export.zip");
    writeFileSync(zip, Buffer.from(await archive.arrayBuffer()));
    // 目录区按 UTF-8 标记记录文件名（部分系统 unzip 不按标记解码，这里直接读目录区）；完整性交给系统 unzip 校验。
    const bytes = readFileSync(zip);
    const names: string[] = [];
    for (let offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); offset >= 0; offset = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4)) {
      assert.equal(bytes.readUInt16LE(offset + 8) & 0x0800, 0x0800);
      names.push(bytes.toString("utf8", offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28)));
    }
    assert.deepEqual(names, ["参考图.png", "参考图-1.png"]);
    assert.equal(spawnSync("unzip", ["-tq", zip]).status, 0);

    const missing = await fetch(`${base}/api/export?ids=`);
    assert.equal(missing.status, 400);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP accepts the configured public address and still rejects other origins", async () => {
  const root = mkdtempSync(join(tmpdir(), "taste-http-"));
  const server = createTasteHttpServer({ home: join(root, "runtime"), webRoot: join(root, "web"), publicUrl: "https://lab.example.ts.net" });
  const address = await server.listen(0);
  try {
    assert.equal(await requestWithHost(address.port, "/api/health", "lab.example.ts.net"), 200);
    assert.equal(await requestWithHost(address.port, "/api/items", "lab.example.ts.net", "https://lab.example.ts.net"), 201);
    // 反向代理可能把 Host 改写成回环地址，但浏览器 Origin 仍是公开地址。
    assert.equal(await requestWithHost(address.port, "/api/items", "127.0.0.1", "https://lab.example.ts.net"), 201);
    assert.equal(await requestWithHost(address.port, "/api/health", "evil.example"), 400);
    assert.equal(await requestWithHost(address.port, "/api/items", "lab.example.ts.net", "https://evil.example"), 400);
    assert.equal(await requestWithHost(address.port, "/api/items", "lab.example.ts.net", "http://lab.example.ts.net"), 400);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
