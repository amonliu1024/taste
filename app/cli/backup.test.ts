import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");

test("backup rejects host and path arguments that could be read as ssh options or shell code", () => {
  for (const args of [[], ["-oProxyCommand=touch /tmp/x"], ["lab", "--remote-home", "$(rm -rf ~)"], ["lab", "--remote-home", "-x"]]) {
    const result = spawnSync(process.execPath, [CLI, "backup", ...args], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /用法：taste backup|--remote-home 只能/);
  }
});
