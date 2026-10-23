import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createTasteHttpServer } from "../server/http.js";

const exec = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const REPO = resolve(dirname(CLI), "../../..");
const TOKEN = "local-test-token-".repeat(3);

async function fixture(run: (root: string, env: NodeJS.ProcessEnv, cli: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "taste-client-"));
  const config = join(root, "client.json");
  writeFileSync(config, "{}", { mode: 0o600 });
  const env = { ...process.env, TASTE_CONFIG: config, TASTE_URL: "", TASTE_TOKEN: "", TASTE_HOME: join(root, "must-not-exist") };
  const cli = async (...args: string[]) => {
    try { return { code: 0, ...await exec(process.execPath, [CLI, ...args], { env }) }; }
    catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return result; }
  };
  try { await run(root, env, cli); }
  finally { assert.equal(existsSync(env.TASTE_HOME), false); rmSync(root, { recursive: true, force: true }); }
}

test("remote-only CLI never creates a Runtime on missing config, bad URL, or removed lifecycle commands", async () => {
  await fixture(async (root, env, cli) => {
    for (const command of ["list", "create", "status", "doctor"]) {
      const result = await cli(command);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /客户端不会创建本地库/);
    }
    for (const command of ["start", "stop", "regenerate-previews"]) assert.match((await cli(command)).stderr, /不再提供本地服务模式/);
    env.TASTE_TOKEN = TOKEN;
    for (const url of ["http://remote.example", "https://user:secret@host.test", "https://host.test?secret=abc", "https://host.test/#token", "garbage"]) {
      env.TASTE_URL = url;
      const result = await cli("list");
      assert.equal(result.code, 1);
      assert.ok(!result.stderr.includes("secret"));
    }
    delete env.TASTE_URL; delete env.TASTE_TOKEN;
    writeFileSync(join(root, "client.json"), "{bad");
    assert.match((await cli("config")).stderr, /配置无法读取/);
  });
});

test("config file, field overrides, doctor, auth failure and disconnect report safely", async () => {
  await fixture(async (root, env, cli) => {
    delete env.TASTE_URL; delete env.TASTE_TOKEN;
    const server = createTasteHttpServer({ home: join(root, "server"), clients: { local: TOKEN } });
    const address = await server.listen(0);
    writeFileSync(env.TASTE_CONFIG!, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: TOKEN }), { mode: 0o600 });
    try {
      const inspected = await cli("config");
      assert.equal(inspected.code, 0, inspected.stderr);
      assert.equal(JSON.parse(inspected.stdout).sources.token, env.TASTE_CONFIG);
      assert.ok(!inspected.stdout.includes(TOKEN));
      assert.equal((await cli("doctor")).code, 0);
      env.TASTE_TOKEN = "wrong-token";
      assert.equal(JSON.parse((await cli("config")).stdout).sources.token, "TASTE_TOKEN");
      assert.match((await cli("list")).stderr, /HTTP 401/);
      delete env.TASTE_TOKEN;
      chmodSync(env.TASTE_CONFIG!, 0o644);
      assert.match((await cli("config")).stderr, /600/);
      chmodSync(env.TASTE_CONFIG!, 0o600);
    } finally { await server.close(); }
    assert.match((await cli("status")).stderr, /连不上 Taste 服务/);
    assert.equal((await cli("status")).code, 1);
  });
});

test("client blocks redirects and preserves request ID and source on an ambiguous import", async () => {
  await fixture(async (root, env, cli) => {
    const key = "12345678-1234-1234-1234-123456789abc";
    const source = join(root, "source.png");
    writeFileSync(source, "source-content");
    let observedKey: string | string[] | undefined;
    const server = createServer((req, res) => {
      observedKey = req.headers["idempotency-key"];
      req.resume();
      req.on("end", () => { res.writeHead(302, { location: "http://127.0.0.1:1/leak" }); res.end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    env.TASTE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    env.TASTE_TOKEN = TOKEN;
    try {
      const result = await cli("--request-id", key, "import", source);
      assert.equal(result.code, 1);
      assert.equal(observedKey, key);
      assert.match(result.stderr, /写入结果待核对/);
      assert.match(result.stderr, new RegExp(key));
      assert.equal(readFileSync(source, "utf8"), "source-content");
    } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
  });
});

test("packaged CLI installs outside the workspace without server code, Runtime or dependencies", async () => {
  await fixture(async (root, env) => {
    const bundle = join(root, "client.tar.gz");
    await exec("sh", [join(REPO, "scripts/package-client.sh"), bundle]);
    const listing = (await exec("tar", ["-tzf", bundle])).stdout.trim().split("\n");
    assert.deepEqual(listing, ["app/bin/taste", "app/dist-node/cli/index.js", "app/dist-node/cli/client.js", "scripts/install-client.sh", "docs/operations/client-server.md"]);
    const extracted = join(root, "unpacked");
    mkdirSync(extracted);
    await exec("tar", ["-xzf", bundle, "-C", extracted]);
    const bin = join(root, "bin");
    await exec("sh", [join(extracted, "scripts/install-client.sh")], { env: { ...env, TASTE_CLIENT_DIR: join(root, "installed"), TASTE_BIN_DIR: bin } });
    const help = await exec(join(bin, "taste"), ["help"], { env });
    assert.match(help.stdout, /客户端始终连接服务器/);
    assert.equal(existsSync(join(root, "installed/app/dist-node/server")), false);
    await assert.rejects(exec(join(bin, "taste"), ["create"], { env }), /客户端不会创建本地库/);
    const relativeRoot = join(root, "relative-install");
    mkdirSync(relativeRoot);
    await exec("sh", [join(extracted, "scripts/install-client.sh")], { cwd: relativeRoot,
      env: { ...env, TASTE_CLIENT_DIR: "installed", TASTE_BIN_DIR: "bin" } });
    const relativeHelp = await exec(join(relativeRoot, "bin/taste"), ["help"], { cwd: root, env });
    assert.match(relativeHelp.stdout, /客户端始终连接服务器/);
  });
});
