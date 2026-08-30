import type { AssetRecord, ItemRecord, TrashRecord } from "./types";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json", ...(options.headers ?? {}) } : options.headers,
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? "请求失败。 ");
  return value;
}

export const api = {
  async items(query = ""): Promise<ItemRecord[]> {
    return (await request<{ items: ItemRecord[] }>(`/api/items?q=${encodeURIComponent(query)}`)).items;
  },
  async item(id: string): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>(`/api/items/${id}`)).item;
  },
  async createItem(title: string, note: string, tags: string[]): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>("/api/items", { method: "POST", body: JSON.stringify({ title, note, tags }) })).item;
  },
  async updateItem(id: string, patch: { title?: string; note?: string; tags?: string[] }): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) })).item;
  },
  async frontItem(id: string): Promise<ItemRecord[]> {
    return (await request<{ items: ItemRecord[] }>(`/api/items/${id}/front`, { method: "POST", body: "{}" })).items;
  },
  async moveItemBefore(id: string, beforeItemId: string): Promise<ItemRecord[]> {
    return (await request<{ items: ItemRecord[] }>(`/api/items/${id}/before/${beforeItemId}`, { method: "POST", body: "{}" })).items;
  },
  async reorderItems(itemIds: string[]): Promise<ItemRecord[]> {
    return (await request<{ items: ItemRecord[] }>("/api/items/reorder", { method: "POST", body: JSON.stringify({ itemIds }) })).items;
  },
  updateItemKeepalive(id: string, patch: { title: string; note: string; tags: string[] }): void {
    void fetch(`/api/items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      keepalive: true,
    });
  },
  async upload(files: File[], title: string, note: string, tags: string[], itemId?: string): Promise<ItemRecord> {
    const encoded = await Promise.all(files.map(async (file) => ({ name: file.name, data: await fileToBase64(file) })));
    return (await request<{ item: ItemRecord }>("/api/import/uploads", {
      method: "POST",
      body: JSON.stringify({ files: encoded, title, note, tags, itemId }),
    })).item;
  },
  async layout(assetId: string, layout: { x: number; y: number; width: number; height: number }): Promise<AssetRecord> {
    return (await request<{ asset: AssetRecord }>(`/api/assets/${assetId}`, { method: "PATCH", body: JSON.stringify(layout) })).asset;
  },
  async exportAsset(assetId: string, targetPath?: string): Promise<{ path?: string; cancelled?: boolean }> {
    return request<{ path?: string; cancelled?: boolean }>(`/api/assets/${assetId}/export`, { method: "POST", body: JSON.stringify(targetPath ? { targetPath } : {}) });
  },
  async exportAssets(assetIds: string[]): Promise<{ paths?: string[]; cancelled?: boolean }> {
    return request<{ paths?: string[]; cancelled?: boolean }>("/api/assets/export", { method: "POST", body: JSON.stringify({ assetIds }) });
  },
  async moveAsset(assetId: string, targetItemId: string | null): Promise<AssetRecord> {
    return (await request<{ asset: AssetRecord }>(`/api/assets/${assetId}`, { method: "PATCH", body: JSON.stringify({ targetItemId }) })).asset;
  },
  async trashAsset(assetId: string): Promise<AssetRecord> {
    return (await request<{ asset: AssetRecord }>(`/api/assets/${assetId}/trash`, { method: "POST", body: "{}" })).asset;
  },
  async restoreAsset(assetId: string): Promise<AssetRecord> {
    return (await request<{ asset: AssetRecord }>(`/api/assets/${assetId}/restore`, { method: "POST", body: "{}" })).asset;
  },
  async trashItem(itemId: string): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>(`/api/items/${itemId}/trash`, { method: "POST", body: "{}" })).item;
  },
  async restoreItem(itemId: string): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>(`/api/items/${itemId}/restore`, { method: "POST", body: "{}" })).item;
  },
  async staged(): Promise<AssetRecord[]> {
    return (await request<{ assets: AssetRecord[] }>("/api/staged")).assets;
  },
  async createFromStaged(assetIds: string[], title = ""): Promise<ItemRecord> {
    return (await request<{ item: ItemRecord }>("/api/staged/items", { method: "POST", body: JSON.stringify({ assetIds, title }) })).item;
  },
  async trash(): Promise<TrashRecord> {
    return request<TrashRecord>("/api/trash");
  },
  async emptyTrash(): Promise<{ deletedItems: number; deletedAssets: number }> {
    return request("/api/trash/empty", { method: "POST", body: JSON.stringify({ confirm: "DELETE" }) });
  },
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
