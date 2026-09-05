# Taste

<img src="app/public/taste-icon-original.png" alt="Taste icon" width="112">

Taste 是一个本机、单人、Agent 友好的视觉内容库。

视觉参考天生留不住：截图散在 `截屏2026-08-25 10.32.15.png` 里，好看的页面存成一堆孤立 HTML，收藏夹里的东西三个月后自己也想不起当初为什么存。找不回来，更没法让 Agent 帮你找。

Taste 把图片和单体 HTML 收进统一 Runtime：用极简素材墙浏览，用无限画布查看和整理内容组，标题、备注、标签、素材归属和画布布局全是真实持久化数据——不是浏览器缓存，也不是一份会飘的 JSON。同一套数据有一个完整的 CLI，所以「帮我把这半年攒的仪表盘参考归到一组、加上标签」是一句话能交出去的活。

本机自用，日常可用。服务与 Vite 只监听回环地址，局域网、登录、同步和多设备访问都不在当前产品边界内；Taste 也不提供内置备份，永久清空废纸篓前请确保重要素材已有系统级备份。

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
cd app && pnpm install --frozen-lockfile && pnpm build && cd ..
./Start\ Taste.command
```

启动脚本会启动或复用 `127.0.0.1:4178` 上的本地服务，并打开默认浏览器。正式数据默认写入 `~/.local/share/taste`；也可以用项目内 CLI 直接操作（`app/bin/taste help`）。

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

实现结构与安全边界见 [Architecture](ARCHITECTURE.md)，版本变化见 [CHANGELOG](CHANGELOG.md)。项目级产品规则与设计标准见外层 [Project Workspace](../README.md)。

## License

[MIT](LICENSE) © Amonliu
