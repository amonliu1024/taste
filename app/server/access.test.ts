import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTasteHttpServer } from "./http.js";

const LOCAL = "local-access-token-".repeat(3);
const CLOUD = "cloud-access-token-".repeat(3);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function fixture(run: (root: string, start: () => Promise<{ server: ReturnType<typeof createTasteHttpServer>; base: string }>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "taste-access-"));
  const servers: Array<ReturnType<typeof createTasteHttpServer>> = [];
  const start = async () => {
    const server = createTasteHttpServer({ home: join(root, "runtime"), clients: { local: LOCAL, cloud: CLOUD } });
    const address = await server.listen(0);
    servers.push(server);
    const close = server.close;
    server.close = async () => {
      servers.splice(servers.indexOf(server), 1);
      return close();
    };
    return { server, base: `http://127.0.0.1:${address.port}` };
  };
  try { await run(root, start); }
  finally { for (const server of [...servers]) { try { await server.close(); } catch { /* explicitly closed for restart */ } } rmSync(root, { recursive: true, force: true }); }
}

function send(base: string, path: string, key: string, input: unknown = {}, token = LOCAL, method = "POST") {
  return fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input) });
}

test("all private routes require credentials; browser cookie cannot bypass origin checks or be forged", async () => {
  await fixture(async (_root, start) => {
    const { base, server } = await start();
    for (const path of ["/api/items", "/api/export?ids=x", "/media/x/original", "/html/x", "/assets/app.js"]) {
      assert.equal((await fetch(base + path)).status, 401, path);
      assert.equal((await fetch(base + path, { headers: { authorization: "Bearer wrong" } })).status, 401);
    }
    assert.deepEqual(await (await fetch(base + "/api/health")).json(), { ok: true });
    assert.match(await (await fetch(base)).text(), /输入访问凭据/);
    assert.equal((await send(base, "/api/items", randomUUID(), {}, "wrong")).status, 401);
    assert.equal(server.store.listItems().length, 0);
    assert.equal((await fetch(base + "/api/health", { headers: { authorization: `Bearer ${CLOUD}` } })).status, 200);
    const login = await fetch(base + "/auth", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ token: LOCAL }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.ok(!cookie.includes(LOCAL));
    const session = cookie.split(";")[0];
    assert.equal((await fetch(base + "/api/items", { headers: { cookie: session } })).status, 200);
    assert.equal((await fetch(base + "/api/items", { method: "POST", headers: { cookie: session, origin: "https://evil.test", "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal((await fetch(base + "/api/items", { headers: { cookie: session + "tampered" } })).status, 401);
    assert.equal((await fetch(base + "/auth", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: LOCAL }) })).status, 400);
  });
});

test("public server refuses missing or duplicate credentials before creating a Runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "taste-config-"));
  const home = join(root, "must-not-exist");
  try {
    assert.throws(() => createTasteHttpServer({ home, publicUrl: "https://lab.example.test" }), /TASTE_CLIENTS_FILE/);
    assert.throws(() => createTasteHttpServer({ home, clients: { a: LOCAL, b: LOCAL } }), /独立 Token/);
    assert.equal(existsSync(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persistent receipts survive restart, concurrent retries share one write, changed body/path/client conflict", async () => {
  await fixture(async (_root, start) => {
    const first = await start();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 4 }, () => send(first.base, "/api/items", key, { title: "只创建一次" })));
    const results = await Promise.all(responses.map((response) => response.json()));
    for (const response of responses) { assert.equal(response.status, 201); assert.equal(response.headers.get("idempotency-key"), key); }
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(first.server.store.listItems().length, 1);
    await first.server.close();
    const { base, server } = await start();
    assert.deepEqual(await (await send(base, "/api/items", key, { title: "只创建一次" })).json(), results[0]);
    assert.equal((await send(base, "/api/items", key, { title: "别的内容" })).status, 409);
    assert.equal((await send(base, "/api/forms", key, { title: "只创建一次" })).status, 409);
    assert.equal((await send(base, "/api/items", key, { title: "只创建一次" }, CLOUD)).status, 409);
    assert.equal(server.store.listItems().length, 1);
    assert.equal((await send(base, "/api/items", "not-a-uuid")).status, 400);
    const failedKey = randomUUID();
    assert.equal((await send(base, "/api/forms", failedKey, { name: "" })).status, 400);
    assert.equal((await send(base, "/api/forms", failedKey, { name: "新形态" })).status, 201);
  });
});

test("receipt failure rolls back database and imported/purged files; replay does not delete newer trash", async () => {
  await fixture(async (root, start) => {
    const { base, server } = await start();
    const db = new DatabaseSync(join(root, "runtime/db/taste.sqlite"));
    const failReceipts = () => db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON request_receipts BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;");
    const allowReceipts = () => db.exec("DROP TRIGGER fail_receipt");
    const input = { files: [{ name: "source.png", data: PNG }] };
    try {
      failReceipts();
      assert.equal((await send(base, "/api/import/uploads", randomUUID(), input)).status, 400);
      assert.equal(server.store.listItems().length, 0);
      assert.equal(readdirSync(join(root, "runtime/files")).length, 0);
      assert.equal(readdirSync(join(root, "runtime/previews")).length, 0);
      allowReceipts();
      const key = randomUUID();
      const imported = await (await send(base, "/api/import/uploads", key, input)).json() as { item: { id: string; assets: Array<{ id: string }> } };
      assert.deepEqual(await (await send(base, "/api/import/uploads", key, input)).json(), imported);
      assert.equal(server.store.listItems().length, 1);
      const assetId = imported.item.assets[0].id;
      const original = server.store.resolveAssetPath(assetId, "original").path;
      server.store.trashItem(imported.item.id);
      failReceipts();
      assert.equal((await send(base, "/api/trash/empty", randomUUID(), { confirm: "DELETE" })).status, 400);
      assert.equal(existsSync(original), true);
      assert.equal(server.store.listTrash().items.length, 1);
      allowReceipts();
      const purgeKey = randomUUID();
      const purged = await (await send(base, "/api/trash/empty", purgeKey, { confirm: "DELETE" })).json();
      assert.equal(existsSync(original), false);
      const later = server.store.createItem("后来的废纸篓");
      server.store.trashItem(later.id);
      assert.deepEqual(await (await send(base, "/api/trash/empty", purgeKey, { confirm: "DELETE" })).json(), purged);
      assert.equal(server.store.listTrash().items.length, 1);
    } finally { db.close(); }
  });
});

test("HTML originals and viewer routes both sandbox active content under authenticated sessions", async () => {
  await fixture(async (_root, start) => {
    const { base } = await start();
    const uploaded = await send(base, "/api/import/uploads", randomUUID(), { files: [{ name: "reference.html", data: Buffer.from("<h1>Reference</h1>").toString("base64") }] });
    const result = await uploaded.json() as { item: { assets: Array<{ id: string }> } };
    assert.equal(uploaded.status, 201);
    for (const path of [`/html/${result.item.assets[0].id}`, `/media/${result.item.assets[0].id}/original`]) {
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${LOCAL}` } });
      assert.equal(response.status, 200);
      const policy = response.headers.get("content-security-policy")!;
      assert.match(policy, /sandbox allow-scripts;/);
      assert.ok(!policy.includes("allow-same-origin"));
    }
  });
});
