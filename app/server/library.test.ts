import assert from "node:assert/strict";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { LibraryStore } from "./library.js";

const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");

// 测试走与浏览器、CLI 相同的上传入口。
function upload(store: LibraryStore, paths: string[], options: Parameters<LibraryStore["importUploads"]>[1] = {}) {
  return store.importUploads(paths.map((path) => ({ name: basename(path), data: readFileSync(path).toString("base64") })), options);
}

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
    const item = upload(f.store, [f.source], { note: "参考", tags: ["UI", "UI"] });
    assert.equal(existsSync(f.source), true);
    assert.equal(item.note, "参考");
    assert.deepEqual(item.tags, ["UI"]);
    assert.equal(item.assets.length, 1);
    assert.throws(() => upload(f.store, [f.source]), /重复文件已存在/);
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
    const updated = upload(f.store, [f.source], { itemId: empty.id });
    assert.equal(updated.assets.length, 1);
    assert.equal(updated.title, "待补灵感");
    assert.equal(updated.note, "先记想法");
  } finally {
    f.close();
  }
});

test("search matches title, note and tag but not file names", () => {
  const f = fixture();
  try {
    const titled = f.store.createItem("Linear 官网");
    const noted = f.store.createItem("", "linear 风格的配色");
    const tagged = f.store.createItem("", "", ["Linear"]);
    f.store.createItem("其他参考");
    assert.deepEqual(new Set(f.store.listItems("linear").map((item) => item.id)), new Set([titled.id, noted.id, tagged.id]));
    assert.deepEqual(f.store.listItems("官网").map((item) => item.id), [titled.id]);
    assert.deepEqual(f.store.listItems("不存在"), []);
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

test("a restored current snapshot preserves library content, files and receipts across reopening", () => {
  const f = fixture();
  const second = join(f.root, "second.png");
  const restored = join(f.root, "restored");
  try {
    writeFileSync(f.source, PNG_A);
    writeFileSync(second, PNG_B);
    const key = "12345678-1234-1234-1234-123456789abc";
    const receipt = f.store.executeRequest(key, "local", "import-digest", () => ({ status: 201, body: upload(f.store, [f.source, second], { tags: ["保留"] }) }));
    const items = f.store.listItems();
    const forms = f.store.listForms();
    const files = items[0].assets.map((asset) => ({ id: asset.id, original: readFileSync(f.store.resolveAssetPath(asset.id, "original").path), preview: readFileSync(f.store.resolveAssetPath(asset.id, "preview").path) }));
    const database = f.store.paths.db;
    const home = f.store.paths.home;
    f.store.close();

    mkdirSync(join(restored, "db"), { recursive: true });
    copyFileSync(database, join(restored, "db", "taste.sqlite"));
    for (const directory of ["files", "previews"]) cpSync(join(home, directory), join(restored, directory), { recursive: true });

    for (let reopen = 0; reopen < 2; reopen++) {
      const store = new LibraryStore(restored);
      try {
        assert.deepEqual(store.listItems(), items);
        assert.deepEqual(store.listForms(), forms);
        assert.deepEqual(store.executeRequest(key, "local", "import-digest", () => { throw new Error("回执恢复后不得重放写入"); }), receipt);
        assert.throws(() => store.executeRequest(key, "local", "changed-digest", () => receipt), /请求编号已用于/);
        for (const file of files) {
          assert.deepEqual(readFileSync(store.resolveAssetPath(file.id, "original").path), file.original);
          assert.deepEqual(readFileSync(store.resolveAssetPath(file.id, "preview").path), file.preview);
        }
        const created = store.createItem("恢复后可写");
        store.trashItem(created.id);
        assert.deepEqual(store.emptyTrash("DELETE"), { deletedItems: 1, deletedAssets: 0 });
      } finally { store.close(); }
    }
    const restoredDb = new DatabaseSync(join(restored, "db", "taste.sqlite"), { readOnly: true });
    try {
      assert.equal(restoredDb.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
      assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { restoredDb.close(); }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("moving the last asset to staging removes the empty item and can create a new item", () => {
  const f = fixture();
  try {
    writeFileSync(f.source, PNG_A);
    const item = upload(f.store, [f.source], { note: "旧备注" });
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
    const item = upload(f.store, [f.source]);
    const appended = upload(f.store, [second], { itemId: item.id });
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
    const firstItem = upload(f.store, [f.source]);
    const secondItem = upload(f.store, [second]);
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

type Box = { x: number; y: number; width: number; height: number };
const within = (box: Box) => (x: number, y: number) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;

// 用 sharp 从原始 RGB 像素写 PNG：content 覆盖的像素用 fill 色，其余是 border 色。
async function writeFramedPng(path: string, size: { width: number; height: number }, content: Box | ((x: number, y: number) => boolean), border: number[], fill: number[]) {
  const inside = typeof content === "function" ? content : within(content);
  const data = Buffer.alloc(size.width * size.height * 3);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) data.set(inside(x, y) ? fill : border, (y * size.width + x) * 3);
  }
  await sharp(data, { raw: { width: size.width, height: size.height, channels: 3 } }).png().toFile(path);
}

test("colored borders are cropped for display while full-bleed images stay whole", async () => {
  const f = fixture();
  try {
    const framed = join(f.root, "framed.png");
    await writeFramedPng(framed, { width: 400, height: 300 }, { x: 40, y: 30, width: 300, height: 150 }, [230, 40, 90], [20, 20, 20]);
    const asset = upload(f.store, [framed]).assets[0];
    assert.deepEqual(asset.crop, { x: 40, y: 30, width: 300, height: 150 });
    assert.equal(asset.width, 400);
    assert.equal(Math.round(asset.canvasWidth / asset.canvasHeight), 2);

    const bleed = join(f.root, "bleed.png");
    await writeFramedPng(bleed, { width: 400, height: 300 }, { x: 0, y: 0, width: 400, height: 300 }, [255, 255, 255], [20, 120, 200]);
    assert.equal(upload(f.store, [bleed]).assets[0].crop, null);

    // 同底色上的零散内容（十字：外框边上大多仍是底色）回留约 3% 长边的呼吸边距；实心色块则贴边裁。
    const sparse = join(f.root, "sparse.png");
    const bar = (x: number, y: number) => within({ x: 150, y: 145, width: 100, height: 10 })(x, y) || within({ x: 195, y: 120, width: 10, height: 60 })(x, y);
    await writeFramedPng(sparse, { width: 400, height: 300 }, bar, [255, 255, 255], [20, 20, 20]);
    assert.deepEqual(upload(f.store, [sparse]).assets[0].crop, { x: 138, y: 108, width: 124, height: 84 });

    const off = f.store.setAssetCrop(asset.id, false);
    assert.equal(off.crop, null);
    assert.equal(Math.round((off.canvasWidth / off.canvasHeight) * 3), 4);
    f.store.refreshCrops();
    assert.equal(f.store.getAsset(asset.id).crop, null);
    assert.deepEqual(f.store.setAssetCrop(asset.id, true).crop, asset.crop);
  } finally {
    f.close();
  }
});

test("HEIC imports are stored as JPEG and tag usage is listed for reuse", { skip: !existsSync("/usr/bin/sips") && "需要 sips 生成 HEIC 夹具" }, async () => {
  const f = fixture();
  try {
    const png = join(f.root, "photo.png");
    await writeFramedPng(png, { width: 64, height: 48 }, { x: 0, y: 0, width: 64, height: 48 }, [0, 0, 0], [200, 90, 40]);
    const heic = join(f.root, "photo.heic");
    assert.equal(spawnSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", heic]).status, 0);
    const item = upload(f.store, [heic], { tags: ["摄影", "暖色"] });
    assert.equal(item.title, "photo");
    assert.equal(item.assets[0].name, "photo.jpg");
    assert.equal(item.assets[0].width, 64);
    assert.throws(() => upload(f.store, [heic]), /重复文件已存在/);
    writeFileSync(f.source, PNG_A);
    upload(f.store, [f.source], { tags: ["摄影"] });
    assert.deepEqual(f.store.listTags(), [{ name: "摄影", count: 2 }, { name: "暖色", count: 1 }]);
  } finally {
    f.close();
  }
});

test("renaming an asset keeps its real extension and rejects an empty name", () => {
  const f = fixture();
  try {
    writeFileSync(f.source, PNG_A);
    const asset = upload(f.store, [f.source]).assets[0];
    assert.equal(f.store.renameAsset(asset.id, "海报·新名称").name, "海报·新名称.png");
    assert.equal(f.store.renameAsset(asset.id, "海报·再改.PNG").name, "海报·再改.png");
    assert.equal(f.store.renameAsset(asset.id, "版本1.2").name, "版本1.2.png");
    assert.throws(() => f.store.renameAsset(asset.id, "  "), /不能为空/);
    assert.throws(() => f.store.renameAsset(asset.id, ".png"), /不能为空/);
  } finally {
    f.close();
  }
});

test("forms are seeded once, extensible, and removable without touching item tags", () => {
  const root = mkdtempSync(join(tmpdir(), "taste-test-"));
  const runtime = join(root, "runtime");
  const source = join(root, "source.png");
  writeFileSync(source, PNG_A);
  let store = new LibraryStore(runtime);
  try {
    const seeded = store.listForms();
    assert.equal(seeded.length, 11);
    assert.deepEqual([seeded[0].name, seeded[10].name], ["网页", "工业设计"]);
    assert.equal(seeded[0].count, 0);
    assert.notEqual(seeded[0].description, "");

    assert.equal(store.addForm("动效", "动效与视频类界面").length, 12);
    assert.equal(store.listForms()[11].name, "动效");
    assert.throws(() => store.addForm("动效"), /已存在/);
    assert.throws(() => store.addForm("  "), /不能为空/);

    upload(store, [source], { tags: ["动效"] });
    assert.equal(store.listForms().find((form) => form.name === "动效")?.count, 1);

    // 移除只出清单，内容组上的同名标签保留，计数随之归零（形态已不在清单）。
    const remaining = store.removeForm("动效");
    assert.equal(remaining.length, 11);
    assert.equal(store.listItems()[0].tags.includes("动效"), true);
    assert.throws(() => store.removeForm("动效"), /不存在/);

    // 删空清单后重开库不重新播种。
    for (const form of store.listForms()) store.removeForm(form.name);
    assert.equal(store.listForms().length, 0);
    store.close();
    store = new LibraryStore(runtime);
    assert.equal(store.listForms().length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
