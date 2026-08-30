import assert from "node:assert/strict";
import test from "node:test";
import { assertStopTarget } from "./safety.js";

test("stop target must match both Runtime home and live PID", () => {
  assert.deepEqual(assertStopTarget({ pid: 42 }, { pid: 42, home: "/expected" }, "/expected"), { pid: 42, home: "/expected" });
  assert.throws(() => assertStopTarget({ pid: 41 }, { pid: 42, home: "/expected" }, "/expected"), /PID.*不一致/);
  assert.throws(() => assertStopTarget({ pid: 42 }, { pid: 42, home: "/other" }, "/expected"), /另一个 Taste Runtime/);
  assert.throws(() => assertStopTarget({ pid: 42 }, null, "/expected"), /运行信息可能已陈旧/);
});
