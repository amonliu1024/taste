export type AssetKind = "image" | "html";
export type AssetState = "active" | "staged" | "trash";

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
  state: "active" | "trash";
  coverAssetId: string | null;
  assets: AssetRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface TrashRecord {
  items: ItemRecord[];
  assets: AssetRecord[];
}
