import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
// HEIC 用 HEVC 编码，sharp 自带的 libheif 不含该解码器，交给系统工具：Linux 用 libheif 的 heif-dec（1.17 及更早叫 heif-convert），macOS 用 sips。
const HEIC_DECODERS: Array<{ command: string; args: (source: string, destination: string) => string[] }> = [
  { command: "/usr/bin/heif-dec", args: (source, destination) => ["-q", "92", source, destination] },
  { command: "/usr/bin/heif-convert", args: (source, destination) => ["-q", "92", source, destination] },
  { command: "/opt/homebrew/bin/heif-dec", args: (source, destination) => ["-q", "92", source, destination] },
  { command: "/usr/bin/sips", args: (source, destination) => ["-s", "format", "jpeg", "-s", "formatOptions", "92", source, "--out", destination] },
];
const IMAGE_WORKER = join(dirname(fileURLToPath(import.meta.url)), "image-worker.js");

function image(args: string[]): string | null {
  const result = spawnSync(process.execPath, [IMAGE_WORKER, ...args], { encoding: "utf8", timeout: 120_000 });
  return result.status === 0 ? result.stdout : null;
}

// 预览图最长边的上限。注意：只有原图超过它才压缩，小图绝不放大（放大 = 糊）。
// 画布可以把单张素材放到接近满屏，预览必须留够像素，否则一放大就发虚；
// 调整这个值后需要执行 `taste regenerate-previews` 让既有素材重新生成预览。
export const PREVIEW_CAP = 2400;

export interface Dimensions {
  width: number;
  height: number;
}

export function readImageDimensions(path: string): Dimensions | null {
  const output = image(["dimensions", path]);
  if (!output) return null;
  const { width, height } = JSON.parse(output) as { width?: number; height?: number };
  return width && height && width > 0 && height > 0 ? { width, height } : null;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 检测时把图缩到这个长边再读像素：足够定位边界，也不拖慢导入。
const PROBE_SIZE = 800;
// 同一条边上的像素与该边主色的最大通道差；容纳 JPEG 噪点，不吞掉阴影和浅色内容。
const EDGE_TOLERANCE = 12;
// 一行（列）里允许不属于边框色的像素比例，容纳零星噪点。
const EDGE_OUTLIER_RATIO = 0.005;
// 检测时可跳过的最外侧杂线行数（按检测图像素计）。
const EDGE_ARTIFACT_LINES = 2;
// 裁切线上仍有这么多像素是边框色时，说明内容是同底色上的零散文字或物体，回留呼吸边距。
const SPARSE_EDGE_RATIO = 0.6;
// 回留的边距（长边比例），不超过该边实际裁掉的宽度。
const BREATHING_RATIO = 0.03;
// 单边裁掉不足长边 0.5% 视为没有边框，避免为几像素抖动产生裁切。
const MIN_TRIM_RATIO = 0.005;
// 裁后内容不足原图 15% 的宽或高时放弃裁切：多半是近乎空白的图，而不是有边框的截图。
const MIN_CONTENT_RATIO = 0.15;

interface Bitmap {
  width: number;
  height: number;
  channels: number;
  pixel(x: number, y: number): number[];
}

// 读取 image-worker 输出的无填充 RGB 原始像素（行序自上而下）。
function rawBitmap(data: Buffer, width: number, height: number, channels: number): Bitmap | null {
  if (width <= 0 || height <= 0 || data.length < width * height * channels) return null;
  return {
    width,
    height,
    channels,
    pixel(x, y) {
      const start = (y * width + x) * channels;
      return Array.from(data.subarray(start, start + channels));
    },
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

type Side = "top" | "bottom" | "left" | "right";

// 从四条边各自向内推进，只要整行（列）仍是该边的主色就继续；每条边独立取色，
// 所以白边、黑边、彩色边、上下黑条或四边不同色都能处理。
// 同时判断每条边的裁切线是否“稀疏”：内容与边框同底色时需要回留边距，实体边缘则贴边裁。
function findContentEdges(bitmap: Bitmap): { edges: Record<Side, number>; sparse: Record<Side, boolean> } {
  const { width, height, channels } = bitmap;
  const line = (index: number, horizontal: boolean, from: number, to: number) => {
    const pixels: number[][] = [];
    for (let position = from; position < to; position += 1) {
      pixels.push(horizontal ? bitmap.pixel(position, index) : bitmap.pixel(index, position));
    }
    return pixels;
  };
  const dominant = (pixels: number[][]) => Array.from({ length: channels }, (_, channel) => median(pixels.map((pixel) => pixel[channel])));
  const matching = (pixels: number[][], reference: number[]) => pixels
    .filter((pixel) => pixel.every((value, channel) => Math.abs(value - reference[channel]) <= EDGE_TOLERANCE)).length;
  const uniform = (pixels: number[][], reference: number[]) => pixels.length - matching(pixels, reference) <= Math.floor(pixels.length * EDGE_OUTLIER_RATIO);
  // 截图最外圈常有 1–2px 的描边或压缩杂色，允许跳过这几行再找边框；取推进最深的起点。
  const scan = (count: number, lineAt: (step: number) => number[][]) => {
    let best = { depth: 0, reference: [] as number[] };
    for (let start = 0; start <= Math.min(EDGE_ARTIFACT_LINES, count - 1); start += 1) {
      const reference = dominant(lineAt(start));
      let step = start;
      while (step < count && uniform(lineAt(step), reference)) step += 1;
      if (step > start && step > best.depth) best = { depth: step, reference };
    }
    return best;
  };
  const top = scan(height, (step) => line(step, true, 0, width));
  if (top.depth >= height) return { edges: { top: 0, bottom: 0, left: 0, right: 0 }, sparse: { top: false, bottom: false, left: false, right: false } };
  const bottom = scan(height - top.depth, (step) => line(height - 1 - step, true, 0, width));
  const left = scan(width, (step) => line(step, false, top.depth, height - bottom.depth));
  const right = scan(width - left.depth, (step) => line(width - 1 - step, false, top.depth, height - bottom.depth));
  // 在内容框范围内看紧贴裁切线的第一行（列）：大多仍是边框色，说明内容是零散文字或非方形物体。
  const box = { x0: left.depth, x1: width - right.depth, y0: top.depth, y1: height - bottom.depth };
  const isSparse = (scanned: { depth: number; reference: number[] }, edge: number[][]) =>
    scanned.depth > 0 && edge.length > 0 && matching(edge, scanned.reference) >= edge.length * SPARSE_EDGE_RATIO;
  return {
    edges: { top: top.depth, bottom: bottom.depth, left: left.depth, right: right.depth },
    sparse: {
      top: isSparse(top, line(box.y0, true, box.x0, box.x1)),
      bottom: isSparse(bottom, line(box.y1 - 1, true, box.x0, box.x1)),
      left: isSparse(left, line(box.x0, false, box.y0, box.y1)),
      right: isSparse(right, line(box.x1 - 1, false, box.y0, box.y1)),
    },
  };
}

// 检测截图四周的纯色边框，返回原图像素坐标下的内容区域；没有明显边框时返回 null。
// 只产出裁切框，原图与预览文件都不改动；GIF 各帧内容不同，不参与检测。
export function detectContentCrop(source: string, dimensions: Dimensions | null, probeBase: string): CropBox | null {
  if (!dimensions || extname(source).toLowerCase() === ".gif") return null;
  const probe = `${probeBase}-probe.raw`;
  try {
    const size = Math.min(PROBE_SIZE, Math.max(dimensions.width, dimensions.height));
    const output = image(["probe", source, String(size), probe]);
    if (!output || !existsSync(probe)) return null;
    const info = JSON.parse(output) as { width: number; height: number; channels: number };
    const bitmap = rawBitmap(readFileSync(probe), info.width, info.height, info.channels);
    if (!bitmap) return null;
    const { edges, sparse } = findContentEdges(bitmap);
    const longSide = Math.max(bitmap.width, bitmap.height);
    const breathing = Math.round(longSide * BREATHING_RATIO);
    const trimmed = Object.fromEntries((Object.keys(edges) as Side[]).map((side) => {
      const depth = edges[side];
      if (depth < longSide * MIN_TRIM_RATIO) return [side, 0];
      return [side, sparse[side] ? Math.max(0, depth - breathing) : depth];
    })) as Record<Side, number>;
    if (!trimmed.top && !trimmed.bottom && !trimmed.left && !trimmed.right) return null;
    const scaleX = dimensions.width / bitmap.width;
    const scaleY = dimensions.height / bitmap.height;
    const x = Math.floor(trimmed.left * scaleX);
    const y = Math.floor(trimmed.top * scaleY);
    const width = Math.min(dimensions.width, Math.ceil((bitmap.width - trimmed.right) * scaleX)) - x;
    const height = Math.min(dimensions.height, Math.ceil((bitmap.height - trimmed.bottom) * scaleY)) - y;
    if (width < dimensions.width * MIN_CONTENT_RATIO || height < dimensions.height * MIN_CONTENT_RATIO) return null;
    return { x, y, width, height };
  } catch {
    return null;
  } finally {
    rmSync(probe, { force: true });
  }
}

// 浏览器无法直接显示的图片格式（如 iPhone 的 HEIC）在导入时转成 JPEG 保存。
export function convertToJpeg(source: string, destination: string): boolean {
  const decoder = HEIC_DECODERS.find((candidate) => existsSync(candidate.command));
  if (!decoder) return false;
  const result = spawnSync(decoder.command, decoder.args(source, destination), { encoding: "utf8", timeout: 120_000 });
  return result.status === 0 && existsSync(destination);
}

// 生成图片预览，返回写出的 .webp 路径，失败返回 null。
// 规则：
// - 小图（最长边 <= PREVIEW_CAP）绝不放大，保留原始分辨率，只转码；
// - 超过上限才压缩到 PREVIEW_CAP；
// - 一律输出 WebP（质量 85）：同样清晰度下体积约为 JPEG/PNG 的三成，透明通道也能保留。
//   复制和导出始终取原图，预览格式不影响用户拿到的文件。
export function createImagePreview(source: string, destinationBase: string, dimensions: Dimensions | null): string | null {
  const maxDimension = dimensions ? Math.max(dimensions.width, dimensions.height) : Number.POSITIVE_INFINITY;
  const destination = destinationBase + ".webp";
  const args = ["webp", source, destination, ...(maxDimension > PREVIEW_CAP ? [String(PREVIEW_CAP)] : [])];
  return image(args) !== null && existsSync(destination) ? destination : null;
}

export function createHtmlPreview(source: string, destination: string): boolean {
  const chrome = CHROME_CANDIDATES.find(existsSync);
  if (!chrome) return false;
  const result = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--hide-scrollbars",
      "--window-size=1440,900",
      `--screenshot=${destination}`,
      `file://${source}`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return result.status === 0 && existsSync(destination);
}

// destinationBase 不带扩展名；返回实际生成的预览路径（图片是 .webp，HTML 是 .jpg）。
export function createPreview(kind: "image" | "html", source: string, destinationBase: string, dimensions: Dimensions | null): string | null {
  try {
    if (kind === "html") {
      const destination = destinationBase + ".jpg";
      if (existsSync(destination)) unlinkSync(destination);
      return createHtmlPreview(source, destination) ? destination : null;
    }
    return createImagePreview(source, destinationBase, dimensions);
  } catch {
    return null;
  }
}
