import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LibraryStore } from "./library.js";

const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "taste-test-"));
  const runtime = join(root, "runtime");
  const source = join(root, "source.png");
  const store = new LibraryStore(runtime);
  return {
    root,
    source,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("copy import preserves the source and duplicate hashes are rejected", () => {
  const f = fixture();
  try {
    writeFileSync(f.source, PNG_A);
    const item = f.store.importPaths([f.source], { mode: "copy", note: "参考", tags: ["UI", "UI"] });
    assert.equal(existsSync(f.source), true);
    assert.equal(item.note, "参考");
    assert.deepEqual(item.tags, ["UI"]);
    assert.equal(item.assets.length, 1);
    assert.throws(() => f.store.importPaths([f.source], { mode: "copy" }), /重复文件已存在/);
  } finally {
    f.close();
  }
});

test("an empty content item can be created and later receive a file", () => {
  const f = fixture();
  try {
    const empty = f.store.createItem("待补灵感", "先记想法", ["待补"]);
    assert.equal(empty.assets.length, 0);
    writeFileSync(f.source, PNG_A);
    const updated = f.store.importPaths([f.source], { mode: "copy", itemId: empty.id });
    assert.equal(updated.assets.length, 1);
    assert.equal(updated.title, "待补灵感");
    assert.equal(updated.note, "先记想法");
  } finally {
    f.close();
  }
});

test("content groups can be moved to the front and reordered without metadata updates changing order", () => {
  const f = fixture();
  try {
    const first = f.store.createItem("第一组");
    const second = f.store.createItem("第二组");
    const third = f.store.createItem("第三组");
    assert.deepEqual(f.store.listItems().map((item) => item.id), [third.id, second.id, first.id]);

    f.store.bringItemToFront(first.id);
    assert.deepEqual(f.store.listItems().map((item) => item.id), [first.id, third.id, second.id]);

    f.store.moveItemBefore(second.id, first.id);
    assert.deepEqual(f.store.listItems().map((item) => item.id), [second.id, first.id, third.id]);

    f.store.updateItem(third.id, { note: "更新备注不应改变人工顺序" });
    assert.deepEqual(f.store.listItems().map((item) => item.id), [second.id, first.id, third.id]);

    f.store.trashItem(first.id);
    f.store.moveItemBefore(third.id, second.id);
    f.store.restoreItem(first.id);
    assert.deepEqual(f.store.listItems().map((item) => item.id), [third.id, second.id, first.id]);
    f.store.updateItem(second.id, { note: "恢复后更新备注仍不应改变人工顺序" });
    assert.deepEqual(f.store.listItems().map((item) => item.id), [third.id, second.id, first.id]);
  } finally {
    f.close();
  }
});

test("content groups accept one atomic complete ordering", () => {
  const f = fixture();
  try {
    const first = f.store.createItem("first");
    const second = f.store.createItem("second");
    const third = f.store.createItem("third");
    assert.deepEqual(f.store.reorderItems([first.id, third.id, second.id]).map((item) => item.id), [first.id, third.id, second.id]);
    assert.throws(() => f.store.reorderItems([first.id, second.id]), /完全一致/);
    assert.deepEqual(f.store.listItems().map((item) => item.id), [first.id, third.id, second.id]);
  } finally {
    f.close();
  }
});

test("an interrupted sort migration with duplicate keys is repaired idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "taste-sort-repair-"));
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "db"), { recursive: true });
  const db = new DatabaseSync(join(runtime, "db", "taste.sqlite"));
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      cover_asset_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO items VALUES ('older', '旧组', '', 'active', NULL, 0, '2026-08-14', '2026-08-14');
    INSERT INTO items VALUES ('newer', '新组', '', 'active', NULL, 0, '2026-08-15', '2026-08-15');
  `);
  db.close();
  const store = new LibraryStore(runtime);
  try {
    assert.deepEqual(store.listItems().map((item) => item.id), ["newer", "older"]);
    store.updateItem("older", { note: "不会因为更新时间置顶" });
    assert.deepEqual(store.listItems().map((item) => item.id), ["newer", "older"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-title database is migrated with a usable group title", () => {
  const root = mkdtempSync(join(tmpdir(), "taste-legacy-"));
  const runtime = join(root, "runtime");
  mkdirSync(join(runtime, "db"), { recursive: true });
  const db = new DatabaseSync(join(runtime, "db", "taste.sqlite"));
  db.exec(`
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      cover_asset_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO items VALUES ('legacy', '旧备注', 'active', NULL, '2026-08-15', '2026-08-15');
  `);
  db.close();
  const store = new LibraryStore(runtime);
  try {
    assert.equal(store.getItem("legacy").title, "旧备注");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy manual cover no longer overrides the first active file", () => {
  const f = fixture();
  const second = join(f.root, "second.png");
  try {
    writeFileSync(f.source, PNG_A);
    writeFileSync(second, PNG_B);
    const item = f.store.importPaths([f.source, second], { mode: "copy" });
    const legacyDb = new DatabaseSync(f.store.paths.db);
    legacyDb.prepare("UPDATE items SET cover_asset_id = ? WHERE id = ?").run(item.assets[1].id, item.id);
    legacyDb.close();
    assert.equal(f.store.getItem(item.id).coverAssetId, item.assets[0].id);
  } finally {
    f.close();
  }
});

test("move import removes the source only after the managed copy exists", () => {
  const f = fixture();
  try {
    writeFileSync(f.source, PNG_A);
    const item = f.store.importPaths([f.source], { mode: "move" });
    assert.equal(existsSync(f.source), false);
    assert.equal(existsSync(f.store.resolveAssetPath(item.assets[0].id, "original").path), true);
  } finally {
    f.close();
  }
});

test("a source cleanup failure keeps both the managed file and original source", () => {
  const f = fixture();
  const lockedDir = join(f.root, "locked");
  const lockedSource = join(lockedDir, "locked.png");
  try {
    mkdirSync(lockedDir);
    writeFileSync(lockedSource, PNG_A);
    chmodSync(lockedDir, 0o500);
    assert.throws(() => f.store.importPaths([lockedSource], { mode: "move" }), /内容已安全导入/);
    assert.equal(existsSync(lockedSource), true);
    const items = f.store.listItems();
    assert.equal(items.length, 1);
    assert.equal(existsSync(f.store.resolveAssetPath(items[0].assets[0].id, "original").path), true);
  } finally {
    chmodSync(lockedDir, 0o700);
    f.close();
  }
});

test("moving the last asset to staging removes the empty item and can create a new item", () => {
  const f = fixture();
  try {
    writeFileSync(f.source, PNG_A);
    const item = f.store.importPaths([f.source], { mode: "copy", note: "旧备注" });
    const asset = f.store.moveAsset(item.assets[0].id, null);
    assert.equal(asset.state, "staged");
    assert.throws(() => f.store.getItem(item.id), /不存在/);
    const created = f.store.createItemFromStaged([asset.id], "重新整理", "新备注", ["重新整理"]);
    assert.equal(created.assets[0].id, asset.id);
    assert.equal(created.note, "新备注");
  } finally {
    f.close();
  }
});

test("appended and moved assets receive a free initial position", () => {
  const f = fixture();
  const second = join(f.root, "second.png");
  try {
    writeFileSync(f.source, PNG_A);
    writeFileSync(second, PNG_B);
    const item = f.store.importPaths([f.source], { mode: "copy" });
    const appended = f.store.importPaths([second], { mode: "copy", itemId: item.id });
    assert.notDeepEqual(
      [appended.assets[0].x, appended.assets[0].y],
      [appended.assets[1].x, appended.assets[1].y],
    );
  } finally {
    f.close();
  }
});

test("asset movement, item trash and permanent empty follow one state machine", () => {
  const f = fixture();
  const second = join(f.root, "second.png");
  try {
    writeFileSync(f.source, PNG_A);
    writeFileSync(second, PNG_B);
    const firstItem = f.store.importPaths([f.source], { mode: "copy" });
    const secondItem = f.store.importPaths([second], { mode: "copy" });
    const moved = f.store.moveAsset(secondItem.assets[0].id, firstItem.id);
    assert.equal(moved.itemId, firstItem.id);
    assert.throws(() => f.store.getItem(secondItem.id), /不存在/);

    const trashed = f.store.trashItem(firstItem.id);
    assert.equal(trashed.state, "trash");
    assert.equal(f.store.listTrash().items.length, 1);
    assert.throws(() => f.store.emptyTrash(""), /明确确认/);
    const result = f.store.emptyTrash("DELETE");
    assert.deepEqual(result, { deletedItems: 1, deletedAssets: 2 });
    assert.equal(f.store.listTrash().items.length, 0);
  } finally {
    f.close();
  }
});
