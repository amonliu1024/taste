import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createTasteHttpServer } from "./http.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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

    const importedResponse = await fetch(`${base}/api/import/paths`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [source], mode: "copy", note: "HTTP 导入", tags: ["测试"] }),
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
