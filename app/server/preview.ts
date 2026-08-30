import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// 预览图最长边的上限。注意：只有原图超过它才压缩，小图绝不放大（放大 = 糊）。
// 画布可以把单张素材放到接近满屏，预览必须留够像素，否则一放大就发虚；
// 调整这个值后需要执行 `taste regenerate-previews` 让既有素材重新生成预览。
export const PREVIEW_CAP = 2400;

export interface Dimensions {
  width: number;
  height: number;
}

export function readImageDimensions(path: string): Dimensions | null {
  const result = spawnSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const width = Number(result.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(result.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function run(args: string[]): boolean {
  const result = spawnSync("/usr/bin/sips", args, { encoding: "utf8" });
  return result.status === 0;
}

// 生成图片预览，返回实际写出的文件路径（扩展名可能是 .png 或 .jpg），失败返回 null。
// 规则：
// - 小图（最长边 <= PREVIEW_CAP）绝不放大，直接保留原始分辨率；
// - PNG 源保留 PNG，守住 UI 截图的锐利边缘、文字和透明通道；
// - JPEG 源保持 JPEG，只有超过上限才压缩，质量 92。
export function createImagePreview(source: string, destinationBase: string, dimensions: Dimensions | null): string | null {
  const extension = extname(source).toLowerCase();
  const isPng = extension === ".png";
  const isJpeg = extension === ".jpg" || extension === ".jpeg";
  const maxDimension = dimensions ? Math.max(dimensions.width, dimensions.height) : Number.POSITIVE_INFINITY;
  const needsDownscale = maxDimension > PREVIEW_CAP;

  if (!needsDownscale) {
    // 保持原始分辨率：能直接复制的就复制，其余（webp/heic 等）转 JPEG 但不缩放。
    if (isPng || isJpeg) {
      const destination = destinationBase + (isPng ? ".png" : ".jpg");
      try {
        copyFileSync(source, destination);
        return destination;
      } catch {
        return null;
      }
    }
    const destination = destinationBase + ".jpg";
    return run(["-s", "format", "jpeg", "-s", "formatOptions", "92", source, "--out", destination]) && existsSync(destination) ? destination : null;
  }

  // 只有超过上限才压缩。
  const destination = destinationBase + (isPng ? ".png" : ".jpg");
  const args = isPng
    ? ["-s", "format", "png", "-Z", String(PREVIEW_CAP), source, "--out", destination]
    : ["-s", "format", "jpeg", "-s", "formatOptions", "92", "-Z", String(PREVIEW_CAP), source, "--out", destination];
  return run(args) && existsSync(destination) ? destination : null;
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

// destinationBase 不带扩展名；返回实际生成的预览路径（图片可能是 .png/.jpg，HTML 是 .jpg）。
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
