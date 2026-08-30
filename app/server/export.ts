import { copyFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

// 弹出 macOS 原生“存储为”对话框，返回用户选择的绝对路径；用户取消时返回 null。
function chooseExportPath(defaultName: string): string | null {
  const result = spawnSync(
    "/usr/bin/osascript",
    [
      "-e", "on run argv",
      "-e", "set defaultName to item 1 of argv",
      "-e", "try",
      "-e", "POSIX path of (choose file name with prompt \"导出到…\" default name defaultName)",
      "-e", "on error",
      "-e", "return \"\"",
      "-e", "end try",
      "-e", "end run",
      "--",
      defaultName,
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) return null;
  const chosen = result.stdout.trim();
  return chosen ? chosen : null;
}

// 导出素材：把原文件复制一份到 targetPath；未提供 targetPath 时弹原生对话框选择地址。
// 返回实际写出的路径；用户取消返回 null。出错抛异常（目录不存在、无权限等）。
export function exportAssetFile(source: string, defaultName: string, targetPath?: string): string | null {
  const target = targetPath && targetPath.trim() ? targetPath.trim() : chooseExportPath(defaultName);
  if (!target) return null;
  copyFileSync(source, target);
  return target;
}

// 弹出 macOS 原生“选择文件夹”对话框，返回目录绝对路径；用户取消时返回 null。
function chooseExportDirectory(): string | null {
  const result = spawnSync(
    "/usr/bin/osascript",
    [
      "-e", "try",
      "-e", "POSIX path of (choose folder with prompt \"导出到…\")",
      "-e", "on error",
      "-e", "return \"\"",
      "-e", "end try",
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  if (result.status !== 0) return null;
  const chosen = result.stdout.trim();
  return chosen ? chosen : null;
}

// 批量导出：选一个目标文件夹，把每个原文件复制进去。同名文件自动加序号，
// 不覆盖目录里已有的文件。用户取消返回 null。
export function exportAssetFilesToDirectory(sources: Array<{ path: string; name: string }>, targetDirectory?: string): string[] | null {
  const directory = targetDirectory && targetDirectory.trim() ? targetDirectory.trim() : chooseExportDirectory();
  if (!directory) return null;
  const written: string[] = [];
  for (const source of sources) {
    const extension = extname(source.name);
    const base = source.name.slice(0, source.name.length - extension.length) || "素材";
    let target = join(directory, source.name);
    for (let index = 1; existsSync(target); index += 1) target = join(directory, `${base}-${index}${extension}`);
    copyFileSync(source.path, target);
    written.push(target);
  }
  return written;
}
