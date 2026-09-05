# Taste

<img src="app/public/taste-icon-original.png" alt="Taste icon" width="112">

Taste 是一个运行在 macOS 本机的个人视觉内容库。它把散落的图片和单体 HTML 收进统一 Runtime，让你可以浏览、分组、备注、打标签、搜索，并在无限画布上整理视觉参考。

浏览器与 CLI 使用同一套本地数据和文件生命周期规则，因此“把这些参考图放进同一组并加上标签”既可以手动完成，也可以交给 Agent。所有数据默认留在本机；服务只监听回环地址，不提供账号、云同步或多设备访问。

当前稳定版本为 `1.0.0`。Taste 已适合单人日常使用，但没有内置备份；永久清空废纸篓前，请确保重要素材已有系统级备份。

## 主要能力

- 用无卡片边框的瀑布流浏览图片和单体 HTML，按备注与标签搜索。
- 以内容组管理一个或多个素材，并持久化标题、备注、标签和人工顺序。
- 在无限画布上平移、缩放、多选、框选、对齐、调整尺寸和重新排布素材。
- 在内容组、暂存区和废纸篓之间移动素材；永久删除需要二次确认。
- 通过 `taste` CLI 使用与浏览器相同的导入、查询、编辑和文件生命周期能力。
- 使用 SHA-256 拒绝重复文件，Runtime、SQLite、缩略图和日志始终位于 Git 仓库之外。

## 系统要求

- macOS
- Node.js 22.13 或更高版本
- pnpm 11
- Google Chrome 或 Chromium（仅生成 HTML 缩略图时需要）

Taste 使用 macOS 的 `sips` 生成图片预览，并使用系统浏览器入口和原生文件选择器，因此当前不支持 Linux 或 Windows。

## 安装与启动

```bash
cd app
pnpm install --frozen-lockfile
pnpm build
cd ..
./Start\ Taste.command
```

启动脚本会启动或复用 `127.0.0.1:4178` 上的本地服务，并打开默认浏览器。正式数据默认写入 `~/.local/share/taste`；可以用 `TASTE_HOME` 指定其他 Runtime。

也可以直接使用项目内 CLI：

```bash
app/bin/taste help
app/bin/taste start --open
app/bin/taste status
app/bin/taste stop
```

需要全局命令时，把 `app/bin/taste` 链接到 `PATH` 中的目录即可。

## 典型用法

```bash
taste list
taste search "编辑感"
taste create --title "待补素材" --note "稍后整理" --tag 待整理
taste import ./a.png ./b.png --title "同一组参考" --tag UI
taste import ./demo.html --copy
taste update <item-id> --title "新标题" --tags "UI,仪表盘"
taste asset move <asset-id> <item-id|staged>
taste layout <asset-id> --x 10 --y 20 --width 420 --height 300
taste trash empty --permanently
```

CLI 导入默认移动源文件；需要保留原文件时必须传入 `--copy`。浏览器上传始终复制，不会删除你选择的原文件。SQLite 和 Runtime 内部路径不是公共接口。

## 开发与验证

所有 pnpm 命令从 `app/` 执行：

```bash
cd app
pnpm dev
pnpm test
```

`pnpm test` 会先生成生产构建，再使用临时 `TASTE_HOME` 验证存储状态机、HTTP 接口和 CLI 安全边界，不会读取或修改正式 Runtime。

实现结构与安全边界见 [Architecture](ARCHITECTURE.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。

## 当前边界

Taste 刻意不提供图片识别、OCR、语义搜索、自动分类、文件监听、云同步、账号协作、移动端适配或内置备份。HTML 素材可以运行自身脚本，只在隔离的 iframe 中按需交互。

## License

[MIT](LICENSE) © Amonliu
