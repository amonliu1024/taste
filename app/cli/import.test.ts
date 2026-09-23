import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createTasteHttpServer } from "../server/http.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");

// 用 TASTE_URL 指向测试服务，走与远程使用完全相同的 CLI 路径。
async function withRemote(run: (taste: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "taste-cli-"));
  const server = createTasteHttpServer({ home: join(root, "runtime"), webRoot: join(root, "web") });
  const address = await server.listen(0);
  const taste = async (...args: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, TASTE_URL: `http://127.0.0.1:${address.port}` } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };
  try {
    await run(taste, root);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("CLI import uploads to the configured service and moves by default", async () => {
  await withRemote(async (taste, root) => {
    const moved = join(root, "moved.png");
    const kept = join(root, "kept.png");
    writeFileSync(moved, PNG_A);
    writeFileSync(kept, PNG_B);

    const first = await taste("import", moved, "--title", "远程导入", "--tag", "UI");
    assert.equal(first.code, 0, first.stderr);
    assert.equal(existsSync(moved), false);
    const item = JSON.parse(first.stdout).item as { id: string; title: string; tags: string[] };
    assert.equal(item.title, "远程导入");
    assert.deepEqual(item.tags, ["UI"]);

    const second = await taste("asset", "add", item.id, kept, "--copy");
    assert.equal(second.code, 0, second.stderr);
    assert.equal(existsSync(kept), true);
    assert.equal(JSON.parse(second.stdout).item.assets.length, 2);

    assert.match((await taste("start")).stderr, /需在那台机器上执行/);
  });
});

test("CLI keeps the source and reports it when the managed copy exists but removal fails", async () => {
  await withRemote(async (taste, root) => {
    const lockedDir = join(root, "locked");
    const locked = join(lockedDir, "locked.png");
    mkdirSync(lockedDir);
    writeFileSync(locked, PNG_A);
    chmodSync(lockedDir, 0o500);
    try {
      const result = await taste("import", locked);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /内容已安全导入/);
      assert.equal(existsSync(locked), true);
      assert.equal(JSON.parse((await taste("list")).stdout).items.length, 1);
    } finally {
      chmodSync(lockedDir, 0o700);
    }
  });
});
