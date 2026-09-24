// 图片处理子进程：sharp 只有异步接口，而导入链路在同步事务里运行，
// 所以 preview.ts 用 spawnSync 调用本脚本，保持调用方同步且与平台无关。
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const [operation, source, ...rest] = process.argv.slice(2);
const inside = (size: number) => ({ width: size, height: size, fit: "inside" as const, withoutEnlargement: true });

async function main(): Promise<void> {
  if (operation === "dimensions") {
    const { width, height } = await sharp(source).metadata();
    process.stdout.write(JSON.stringify({ width, height }));
    return;
  }
  if (operation === "probe") {
    const [size, destination] = rest;
    const { data, info } = await sharp(source).resize(inside(Number(size))).raw().toBuffer({ resolveWithObject: true });
    writeFileSync(destination, data);
    process.stdout.write(JSON.stringify({ width: info.width, height: info.height, channels: info.channels }));
    return;
  }
  if (operation === "webp") {
    const [destination, size] = rest;
    let image = sharp(source).keepMetadata();
    if (size) image = image.resize(inside(Number(size)));
    await image.webp({ quality: 85 }).toFile(destination);
    return;
  }
  throw new Error(`未知操作：${operation}`);
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
