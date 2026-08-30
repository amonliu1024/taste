import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPreview, readImageDimensions } from "./preview.js";
import { exportAssetFile, exportAssetFilesToDirectory } from "./export.js";
import { ensureRuntime, getRuntimePaths, type RuntimePaths } from "./runtime.js";

// 画布尺寸上限：双击还原原始尺寸时，长边上万像素的原图也要能完整落到画布上。
const MAX_CANVAS_SIZE = 12000;

export type AssetKind = "image" | "html";
export type AssetState = "active" | "staged" | "trash";
export type ItemState = "active" | "trash";

export interface AssetRecord {
  id: string;
  itemId: string | null;
  previousItemId: string | null;
  name: string;
  kind: AssetKind;
  state: AssetState;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  x: number;
  y: number;
  canvasWidth: number;
  canvasHeight: number;
  hasPreview: boolean;
  createdAt: string;
  updatedAt: string;
  originalUrl: string;
  previewUrl: string;
  htmlUrl: string | null;
}

export interface ItemRecord {
  id: string;
  title: string;
  note: string;
  tags: string[];
  state: ItemState;
  coverAssetId: string | null;
  assets: AssetRecord[];
  createdAt: string;
  updatedAt: string;
}

interface ImportSource {
  path: string;
  name: string;
  removeAfter: boolean;
}

interface PreparedAsset {
  id: string;
  source: ImportSource;
  kind: AssetKind;
  sha256: string;
  size: number;
  incomingFile: string;
  incomingPreview: string | null;
  finalDir: string;
  finalFile: string;
  finalPreview: string | null;
  width: number | null;
  height: number | null;
  x: number;
  y: number;
  canvasWidth: number;
  canvasHeight: number;
}

type DbRow = Record<string, unknown>;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

function now(): string {
  return new Date().toISOString();
}

function cleanName(name: string): string {
  const value = basename(name).replace(/[\u0000-\u001f]/g, "").trim();
  return value || "untitled";
}

function kindFor(name: string): AssetKind {
  const extension = extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  throw new Error(`不支持的文件：${name}。Taste 只接收图片和单体 HTML。`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export class LibraryStore {
  readonly paths: RuntimePaths;
  private readonly db: DatabaseSync;

  constructor(homeOverride?: string) {
    this.paths = ensureRuntime(getRuntimePaths(homeOverride));
    this.db = new DatabaseSync(this.paths.db);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL CHECK (state IN ('active', 'trash')) DEFAULT 'active',
        cover_asset_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        previous_item_id TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'html')),
        state TEXT NOT NULL CHECK (state IN ('active', 'staged', 'trash')) DEFAULT 'active',
        storage_path TEXT NOT NULL,
        preview_path TEXT,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        width INTEGER,
        height INTEGER,
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        canvas_width REAL NOT NULL DEFAULT 420,
        canvas_height REAL NOT NULL DEFAULT 300,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        name TEXT PRIMARY KEY COLLATE NOCASE
      );
      CREATE TABLE IF NOT EXISTS item_tags (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        tag_name TEXT NOT NULL REFERENCES tags(name) ON DELETE CASCADE,
        PRIMARY KEY (item_id, tag_name)
      );
      CREATE INDEX IF NOT EXISTS idx_items_state_updated ON items(state, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assets_item_state ON assets(item_id, state);
      CREATE INDEX IF NOT EXISTS idx_assets_state_updated ON assets(state, updated_at DESC);
    `);
    const itemColumns = this.db.prepare("PRAGMA table_info(items)").all() as DbRow[];
    if (!itemColumns.some((column) => String(column.name) === "title")) {
      this.db.exec("ALTER TABLE items ADD COLUMN title TEXT NOT NULL DEFAULT ''");
      this.db.exec(`
        UPDATE items SET title = COALESCE(
          NULLIF(trim(note), ''),
          (SELECT name FROM assets WHERE assets.item_id = items.id AND assets.state = 'active' ORDER BY created_at LIMIT 1),
          '未命名内容组'
        )
      `);
    }
    if (!itemColumns.some((column) => String(column.name) === "sort_order")) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE items ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
        this.normalizeSortOrder();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } else {
      const orderState = this.db.prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT sort_order) AS distinct_count FROM items").get() as DbRow;
      if (Number(orderState.total) !== Number(orderState.distinct_count)) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.normalizeSortOrder();
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  }

  listItems(query = "", state: ItemState = "active"): ItemRecord[] {
    const needle = query.trim().toLowerCase();
    const rows = this.db.prepare(`
      SELECT DISTINCT i.* FROM items i
      LEFT JOIN item_tags it ON it.item_id = i.id
      WHERE i.state = ?
        AND (? = '' OR lower(i.note) LIKE ? OR lower(it.tag_name) LIKE ?)
      ORDER BY i.sort_order DESC, i.updated_at DESC
    `).all(state, needle, `%${needle}%`, `%${needle}%`) as DbRow[];
    return rows.map((row) => this.hydrateItem(row));
  }

  getItem(id: string): ItemRecord {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("内容组不存在。 ");
    return this.hydrateItem(row);
  }

  listStaged(): AssetRecord[] {
    return (this.db.prepare("SELECT * FROM assets WHERE state = 'staged' ORDER BY updated_at DESC").all() as DbRow[])
      .map((row) => this.hydrateAsset(row));
  }

  listTrash(): { items: ItemRecord[]; assets: AssetRecord[] } {
    return {
      items: this.listItems("", "trash"),
      assets: (this.db.prepare("SELECT * FROM assets WHERE state = 'trash' ORDER BY updated_at DESC").all() as DbRow[])
        .map((row) => this.hydrateAsset(row)),
    };
  }

  importPaths(paths: string[], options: { title?: string; note?: string; tags?: string[]; mode?: "move" | "copy"; itemId?: string } = {}): ItemRecord {
    if (paths.length === 0) throw new Error("至少需要一个文件。 ");
    const mode = options.mode ?? "move";
    const sources = paths.map((path) => {
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`文件不存在：${path}`);
      return { path, name: cleanName(path), removeAfter: mode === "move" };
    });
    return this.importSources(sources, options);
  }

  importUploads(files: Array<{ name: string; data: string }>, options: { title?: string; note?: string; tags?: string[]; itemId?: string } = {}): ItemRecord {
    if (files.length === 0) throw new Error("至少需要一个文件。 ");
    const uploadDir = join(this.paths.incoming, `upload-${randomUUID()}`);
    mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    try {
      const sources = files.map((file, index) => {
        const name = cleanName(file.name);
        const path = join(uploadDir, `${index}-${name}`);
        writeFileSync(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
        return { path, name, removeAfter: true };
      });
      return this.importSources(sources, options);
    } finally {
      rmSync(uploadDir, { recursive: true, force: true });
    }
  }

  createItem(title = "", note = "", tags: string[] = []): ItemRecord {
    const id = randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO items (id, title, note, state, cover_asset_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'active', NULL, ?, ?, ?)")
        .run(id, title.trim() || "未命名内容组", note, this.nextSortOrder(), timestamp, timestamp);
      this.replaceTags(id, tags);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getItem(id);
  }

  updateItem(id: string, patch: { title?: string; note?: string; tags?: string[] }): ItemRecord {
    this.getItem(id);
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (patch.title !== undefined) {
        this.db.prepare("UPDATE items SET title = ?, updated_at = ? WHERE id = ?").run(patch.title.trim() || "未命名内容组", timestamp, id);
      }
      if (patch.note !== undefined) {
        this.db.prepare("UPDATE items SET note = ?, updated_at = ? WHERE id = ?").run(patch.note, timestamp, id);
      }
      if (patch.tags !== undefined) this.replaceTags(id, patch.tags);
      this.db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(timestamp, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getItem(id);
  }

  bringItemToFront(id: string): ItemRecord[] {
    const item = this.getItem(id);
    if (item.state !== "active") throw new Error("只能调整内容库中的内容组。 ");
    this.db.prepare("UPDATE items SET sort_order = ? WHERE id = ?").run(this.nextSortOrder(), id);
    return this.listItems();
  }

  moveItemBefore(id: string, beforeItemId: string): ItemRecord[] {
    const item = this.getItem(id);
    const target = this.getItem(beforeItemId);
    if (item.state !== "active" || target.state !== "active") throw new Error("只能调整内容库中的内容组。 ");
    if (id === beforeItemId) return this.listItems();
    const ids = (this.db.prepare("SELECT id FROM items WHERE state = 'active' ORDER BY sort_order DESC, updated_at DESC").all() as DbRow[])
      .map((row) => String(row.id))
      .filter((candidate) => candidate !== id);
    const targetIndex = ids.indexOf(beforeItemId);
    if (targetIndex < 0) throw new Error("目标内容组不存在。 ");
    ids.splice(targetIndex, 0, id);
    const trashIds = (this.db.prepare("SELECT id FROM items WHERE state = 'trash' ORDER BY sort_order DESC, updated_at DESC").all() as DbRow[])
      .map((row) => String(row.id));
    const orderedIds = [...ids, ...trashIds];
    const update = this.db.prepare("UPDATE items SET sort_order = ? WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      orderedIds.forEach((itemId, index) => update.run(orderedIds.length - index, itemId));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listItems();
  }

  reorderItems(orderedIds: string[]): ItemRecord[] {
    const activeIds = (this.db.prepare("SELECT id FROM items WHERE state = 'active' ORDER BY sort_order DESC, updated_at DESC").all() as DbRow[])
      .map((row) => String(row.id));
    if (orderedIds.length !== activeIds.length || new Set(orderedIds).size !== activeIds.length || activeIds.some((id) => !orderedIds.includes(id))) {
      throw new Error("排序内容组必须与当前内容库完全一致。 ");
    }
    const trashIds = (this.db.prepare("SELECT id FROM items WHERE state = 'trash' ORDER BY sort_order DESC, updated_at DESC").all() as DbRow[])
      .map((row) => String(row.id));
    const allIds = [...orderedIds, ...trashIds];
    const update = this.db.prepare("UPDATE items SET sort_order = ? WHERE id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      allIds.forEach((itemId, index) => update.run(allIds.length - index, itemId));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listItems();
  }

  updateLayout(assetId: string, layout: { x: number; y: number; width: number; height: number }): AssetRecord {
    const asset = this.getAsset(assetId);
    if (asset.state !== "active") throw new Error("只有内容组中的素材可以保存画布布局。 ");
    const width = Math.max(120, Math.min(MAX_CANVAS_SIZE, layout.width));
    const height = Math.max(90, Math.min(MAX_CANVAS_SIZE, layout.height));
    this.db.prepare(`
      UPDATE assets SET x = ?, y = ?, canvas_width = ?, canvas_height = ?, updated_at = ? WHERE id = ?
    `).run(layout.x, layout.y, width, height, now(), assetId);
    return this.getAsset(assetId);
  }

  moveAsset(assetId: string, targetItemId: string | null): AssetRecord {
    const asset = this.getAsset(assetId);
    const sourceItemId = asset.itemId;
    if (targetItemId && targetItemId === sourceItemId) return asset;
    let position = { x: 0, y: 0 };
    if (targetItemId) {
      const target = this.getItem(targetItemId);
      if (target.state !== "active") throw new Error("目标内容组不可用。 ");
      position = nextUnusedPosition(target.assets, target.assets.length);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE assets SET item_id = ?, previous_item_id = ?, state = ?, x = ?, y = ?, updated_at = ? WHERE id = ?
      `).run(targetItemId, sourceItemId, targetItemId ? "active" : "staged", position.x, position.y, now(), assetId);
      if (targetItemId) this.touchItem(targetItemId);
      if (sourceItemId && sourceItemId !== targetItemId) this.removeEmptyItem(sourceItemId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAsset(assetId);
  }

  createItemFromStaged(assetIds: string[], title = "", note = "", tags: string[] = []): ItemRecord {
    if (assetIds.length === 0) throw new Error("至少选择一个暂存素材。 ");
    const assets = assetIds.map((id) => this.getAsset(id));
    if (assets.some((asset) => asset.state !== "staged")) throw new Error("只能使用暂存区素材创建内容组。 ");
    const id = randomUUID();
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO items (id, title, note, state, cover_asset_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)")
        .run(id, title.trim() || basename(assets[0].name, extname(assets[0].name)), note, assetIds[0], this.nextSortOrder(), timestamp, timestamp);
      assetIds.forEach((assetId, index) => {
        const position = initialPosition(index);
        this.db.prepare(`UPDATE assets SET item_id = ?, state = 'active', x = ?, y = ?, updated_at = ? WHERE id = ?`)
          .run(id, position.x, position.y, timestamp, assetId);
      });
      this.replaceTags(id, tags);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getItem(id);
  }

  trashItem(id: string): ItemRecord {
    const item = this.getItem(id);
    if (item.state === "trash") return item;
    this.db.prepare("UPDATE items SET state = 'trash', updated_at = ? WHERE id = ?").run(now(), id);
    return this.getItem(id);
  }

  restoreItem(id: string): ItemRecord {
    this.getItem(id);
    this.db.prepare("UPDATE items SET state = 'active', updated_at = ? WHERE id = ?").run(now(), id);
    return this.getItem(id);
  }

  trashAsset(id: string): AssetRecord {
    const asset = this.getAsset(id);
    const sourceItemId = asset.itemId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE assets SET item_id = NULL, previous_item_id = ?, state = 'trash', updated_at = ? WHERE id = ?")
        .run(sourceItemId, now(), id);
      if (sourceItemId) this.removeEmptyItem(sourceItemId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAsset(id);
  }

  restoreAsset(id: string): AssetRecord {
    const asset = this.getAsset(id);
    if (asset.state !== "trash") return asset;
    const previous = asset.previousItemId
      ? this.db.prepare("SELECT id FROM items WHERE id = ? AND state = 'active'").get(asset.previousItemId)
      : undefined;
    return this.moveAsset(id, previous ? asset.previousItemId : null);
  }

  emptyTrash(confirm: string): { deletedItems: number; deletedAssets: number } {
    if (confirm !== "DELETE") throw new Error("永久删除需要明确确认。 ");
    const itemRows = this.db.prepare("SELECT id FROM items WHERE state = 'trash'").all() as DbRow[];
    const assetRows = this.db.prepare(`
      SELECT DISTINCT a.* FROM assets a
      LEFT JOIN items i ON i.id = a.item_id
      WHERE a.state = 'trash' OR i.state = 'trash'
    `).all() as DbRow[];
    const purgeDir = join(this.paths.incoming, `purge-${randomUUID()}`);
    mkdirSync(purgeDir, { recursive: true, mode: 0o700 });
    const moved: Array<{ from: string; to: string }> = [];
    try {
      for (const row of assetRows) {
        const storageDir = dirname(String(row.storage_path));
        if (existsSync(storageDir)) {
          const target = join(purgeDir, `${row.id}-files`);
          renameSync(storageDir, target);
          moved.push({ from: storageDir, to: target });
        }
        if (row.preview_path && existsSync(String(row.preview_path))) {
          const target = join(purgeDir, `${row.id}-preview.jpg`);
          renameSync(String(row.preview_path), target);
          moved.push({ from: String(row.preview_path), to: target });
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("DELETE FROM assets WHERE state = 'trash' OR item_id IN (SELECT id FROM items WHERE state = 'trash')").run();
        this.db.prepare("DELETE FROM items WHERE state = 'trash'").run();
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      rmSync(purgeDir, { recursive: true, force: true });
    } catch (error) {
      for (const entry of moved.reverse()) {
        if (existsSync(entry.to) && !existsSync(entry.from)) renameSync(entry.to, entry.from);
      }
      rmSync(purgeDir, { recursive: true, force: true });
      throw error;
    }
    return { deletedItems: itemRows.length, deletedAssets: assetRows.length };
  }

  getAsset(id: string): AssetRecord {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("文件不存在。 ");
    return this.hydrateAsset(row);
  }

  resolveAssetPath(id: string, variant: "original" | "preview"): { path: string; kind: AssetKind; name: string } {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) throw new Error("文件不存在。 ");
    const original = String(row.storage_path);
    const preview = row.preview_path ? String(row.preview_path) : original;
    return { path: variant === "preview" ? preview : original, kind: String(row.kind) as AssetKind, name: String(row.name) };
  }

  // 导出素材：把原文件复制一份到目标地址；未传 targetPath 时弹原生对话框选择。
  // 返回 { path } 成功，{ cancelled: true } 用户取消。
  exportAsset(id: string, targetPath?: string): { path: string } | { cancelled: true } {
    const row = this.db.prepare("SELECT name, storage_path FROM assets WHERE id = ? AND state = 'active'").get(id) as DbRow | undefined;
    if (!row) throw new Error("素材不存在。 ");
    const written = exportAssetFile(String(row.storage_path), String(row.name), targetPath);
    return written ? { path: written } : { cancelled: true };
  }

  // 多选导出：一次只弹一个“选择文件夹”对话框，把选中的原文件都复制进去。
  exportAssets(ids: string[], targetDirectory?: string): { paths: string[] } | { cancelled: true } {
    const sources = ids.map((id) => {
      const row = this.db.prepare("SELECT name, storage_path FROM assets WHERE id = ? AND state = 'active'").get(id) as DbRow | undefined;
      if (!row) throw new Error("素材不存在。 ");
      return { path: String(row.storage_path), name: String(row.name) };
    });
    if (sources.length === 0) throw new Error("没有可导出的素材。 ");
    const written = exportAssetFilesToDirectory(sources, targetDirectory);
    return written ? { paths: written } : { cancelled: true };
  }

  private importSources(sources: ImportSource[], options: { title?: string; note?: string; tags?: string[]; itemId?: string }): ItemRecord {
    const existingItem = options.itemId ? this.getItem(options.itemId) : null;
    if (existingItem && existingItem.state !== "active") throw new Error("目标内容组不可用。 ");
    const positionOffset = existingItem?.assets.length ?? 0;
    const positioned: Array<{ x: number; y: number }> = [...(existingItem?.assets ?? [])];
    const prepared: PreparedAsset[] = [];
    try {
      sources.forEach((source, index) => {
        const asset = this.prepareAsset(source, index + positionOffset);
        const position = nextUnusedPosition(positioned, index + positionOffset);
        asset.x = position.x;
        asset.y = position.y;
        positioned.push(asset);
        prepared.push(asset);
      });
      const hashes = new Set<string>();
      for (const asset of prepared) {
        if (hashes.has(asset.sha256)) throw new Error(`本次导入包含重复文件：${asset.source.name}`);
        hashes.add(asset.sha256);
        const duplicate = this.db.prepare("SELECT id, item_id FROM assets WHERE sha256 = ?").get(asset.sha256) as DbRow | undefined;
        if (duplicate) throw new Error(`重复文件已存在：${asset.source.name}（文件 ${duplicate.id}）`);
      }
    } catch (error) {
      for (const asset of prepared) {
        rmSync(asset.incomingFile, { force: true });
        if (asset.incomingPreview) rmSync(asset.incomingPreview, { force: true });
      }
      throw error;
    }

    const itemId = options.itemId ?? randomUUID();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const timestamp = now();
        if (!options.itemId) {
          const title = options.title?.trim() || basename(prepared[0].source.name, extname(prepared[0].source.name));
          this.db.prepare("INSERT INTO items (id, title, note, state, cover_asset_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)")
            .run(itemId, title || "未命名内容组", options.note ?? "", prepared[0].id, this.nextSortOrder(), timestamp, timestamp);
          this.replaceTags(itemId, options.tags ?? []);
        }
        for (const asset of prepared) {
          mkdirSync(asset.finalDir, { recursive: true, mode: 0o700 });
          renameSync(asset.incomingFile, asset.finalFile);
          if (asset.incomingPreview && asset.finalPreview) renameSync(asset.incomingPreview, asset.finalPreview);
          this.db.prepare(`
            INSERT INTO assets (
              id, item_id, previous_item_id, name, kind, state, storage_path, preview_path,
              size, sha256, width, height, x, y, canvas_width, canvas_height, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            asset.id, itemId, asset.source.name, asset.kind, asset.finalFile, asset.finalPreview,
            asset.size, asset.sha256, asset.width, asset.height, asset.x, asset.y,
            asset.canvasWidth, asset.canvasHeight, timestamp, timestamp,
          );
        }
        this.touchItem(itemId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      for (const asset of prepared) {
        rmSync(asset.finalDir, { recursive: true, force: true });
        if (asset.finalPreview) rmSync(asset.finalPreview, { force: true });
        rmSync(asset.incomingFile, { force: true });
        if (asset.incomingPreview) rmSync(asset.incomingPreview, { force: true });
      }
      throw error;
    }
    const cleanupFailures: string[] = [];
    for (const asset of prepared) {
      if (!asset.source.removeAfter) continue;
      try {
        unlinkSync(asset.source.path);
      } catch {
        cleanupFailures.push(asset.source.path);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`内容已安全导入，但未能移除以下源文件：${cleanupFailures.join("、")}`);
    }
    return this.getItem(itemId);
  }

  private prepareAsset(source: ImportSource, index: number): PreparedAsset {
    const id = randomUUID();
    const kind = kindFor(source.name);
    const incomingFile = join(this.paths.incoming, `${id}-${source.name}`);
    copyFileSync(source.path, incomingFile);
    const sourceHash = sha256(source.path);
    if (sha256(incomingFile) !== sourceHash) {
      rmSync(incomingFile, { force: true });
      throw new Error(`复制校验失败：${source.name}`);
    }
    const dimensions = kind === "image" ? readImageDimensions(incomingFile) : { width: 1440, height: 900 };
    const aspect = dimensions ? dimensions.width / dimensions.height : 4 / 3;
    const canvasWidth = 420;
    const canvasHeight = Math.max(180, Math.min(720, canvasWidth / aspect));
    const position = initialPosition(index);
    // 预览可能是 .png 或 .jpg，扩展名由 createPreview 根据源文件决定。
    const previewBase = join(this.paths.incoming, `${id}-preview`);
    const createdPreview = createPreview(kind, incomingFile, previewBase, dimensions);
    const finalDir = join(this.paths.files, id);
    return {
      id,
      source,
      kind,
      sha256: sourceHash,
      size: statSync(incomingFile).size,
      incomingFile,
      incomingPreview: createdPreview,
      finalDir,
      finalFile: join(finalDir, source.name),
      finalPreview: createdPreview ? join(this.paths.previews, `${id}${extname(createdPreview)}`) : null,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      x: position.x,
      y: position.y,
      canvasWidth,
      canvasHeight,
    };
  }

  private hydrateItem(row: DbRow): ItemRecord {
    const id = String(row.id);
    const tags = (this.db.prepare("SELECT tag_name FROM item_tags WHERE item_id = ? ORDER BY tag_name COLLATE NOCASE").all(id) as DbRow[])
      .map((tag) => String(tag.tag_name));
    const assets = (this.db.prepare("SELECT * FROM assets WHERE item_id = ? AND state = 'active' ORDER BY created_at").all(id) as DbRow[])
      .map((asset) => this.hydrateAsset(asset));
    return {
      id,
      title: String(row.title || "未命名内容组"),
      note: String(row.note),
      tags,
      state: String(row.state) as ItemState,
      // Legacy cover choices are intentionally ignored: the first active file is always the preview.
      coverAssetId: assets[0]?.id ?? null,
      assets,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private hydrateAsset(row: DbRow): AssetRecord {
    const id = String(row.id);
    return {
      id,
      itemId: row.item_id ? String(row.item_id) : null,
      previousItemId: row.previous_item_id ? String(row.previous_item_id) : null,
      name: String(row.name),
      kind: String(row.kind) as AssetKind,
      state: String(row.state) as AssetState,
      size: Number(row.size),
      sha256: String(row.sha256),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      x: Number(row.x),
      y: Number(row.y),
      canvasWidth: Number(row.canvas_width),
      canvasHeight: Number(row.canvas_height),
      hasPreview: Boolean(row.preview_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      originalUrl: `/media/${id}/original`,
      previewUrl: `/media/${id}/preview`,
      htmlUrl: String(row.kind) === "html" ? `/html/${id}` : null,
    };
  }

  private replaceTags(itemId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(itemId);
    for (const tag of normalizeTags(tags)) {
      this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
      this.db.prepare("INSERT INTO item_tags (item_id, tag_name) VALUES (?, ?)").run(itemId, tag);
    }
  }

  private nextSortOrder(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM items").get() as DbRow;
    return Number(row.value);
  }

  private normalizeSortOrder(): void {
    const rows = this.db.prepare(`
      SELECT id FROM items
      ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, sort_order DESC, updated_at DESC, created_at DESC
    `).all() as DbRow[];
    const update = this.db.prepare("UPDATE items SET sort_order = ? WHERE id = ?");
    rows.forEach((row, index) => update.run(rows.length - index, String(row.id)));
  }

  private touchItem(id: string): void {
    this.db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  private removeEmptyItem(id: string): void {
    const count = this.db.prepare("SELECT count(*) AS count FROM assets WHERE item_id = ? AND state = 'active'").get(id) as DbRow;
    if (Number(count.count) === 0) this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
    else {
      const item = this.db.prepare("SELECT cover_asset_id FROM items WHERE id = ?").get(id) as DbRow | undefined;
      if (item?.cover_asset_id) {
        const cover = this.db.prepare("SELECT id FROM assets WHERE id = ? AND item_id = ? AND state = 'active'").get(String(item.cover_asset_id), id);
        if (!cover) {
          const fallback = this.db.prepare("SELECT id FROM assets WHERE item_id = ? AND state = 'active' ORDER BY created_at LIMIT 1").get(id) as DbRow;
          this.db.prepare("UPDATE items SET cover_asset_id = ?, updated_at = ? WHERE id = ?").run(String(fallback.id), now(), id);
        }
      }
    }
  }

}

function initialPosition(index: number): { x: number; y: number } {
  const column = index % 3;
  const row = Math.floor(index / 3);
  return { x: column * 470 + (row % 2) * 44, y: row * 360 + column * 32 };
}

function nextUnusedPosition(existing: Array<{ x: number; y: number }>, startIndex: number): { x: number; y: number } {
  const used = new Set(existing.map((asset) => `${asset.x},${asset.y}`));
  let index = startIndex;
  let position = initialPosition(index);
  while (used.has(`${position.x},${position.y}`)) position = initialPosition(++index);
  return position;
}
