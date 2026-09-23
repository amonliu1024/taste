# Taste

<img src="app/public/taste-icon.png" alt="Taste icon" width="112">

Taste 是一个单人、Agent 友好的视觉内容库，部署在自己的服务器上，经私有网络从任意设备使用。

视觉参考天生留不住：截图散在 `截屏2026-08-25 10.32.15.png` 里，好看的页面存成一堆孤立 HTML，收藏夹里的东西三个月后自己也想不起当初为什么存。找不回来，更没法让 Agent 帮你找。

Taste 把图片和单体 HTML 收进统一 Runtime：用极简素材墙浏览，用无限画布查看和整理内容组，标题、备注、标签、素材归属和画布布局全是真实持久化数据——不是浏览器缓存，也不是一份会飘的 JSON。同一套数据有一个完整的 CLI，所以「帮我把这半年攒的仪表盘参考归到一组、加上标签」是一句话能交出去的活。

单人自用，日常可用。服务只监听回环地址，由反向代理（如 `tailscale serve`）把一个私有 HTTPS 地址转给它，访问控制交给私有网络，Taste 本身没有账号与登录；Taste 也不提供内置备份，数据只有服务器上一份，请为服务器开启快照。

## 主要能力

- 用无卡片边框的瀑布流浏览图片和单体 HTML，按标题、备注与标签搜索。
- 以内容组管理一个或多个素材，并持久化标题、备注、标签和人工顺序。
- 在无限画布上平移、缩放、多选、框选、对齐、调整尺寸和重新排布素材。
- 在内容组、暂存区和废纸篓之间移动素材；永久删除需要二次确认。
- 通过 `taste` CLI 使用与浏览器相同的导入、查询、编辑和文件生命周期能力。
- 使用 SHA-256 拒绝重复文件，Runtime、SQLite、缩略图和日志始终位于 Git 仓库之外。

## 系统要求

- Linux（生产）或 macOS（开发）
- Node.js 22.13 或更高版本
- pnpm 11
- Google Chrome 或 Chromium（仅生成 HTML 缩略图时需要）
- HEIC 解码：Linux 装 libheif 工具（`heif-dec` 或 `heif-convert`，Ubuntu 为 `libheif-examples` 与 `libheif-plugin-libde265`），macOS 使用自带 `sips`

图片尺寸、预览与自动去边由 sharp 完成，两种系统行为一致。

## 部署与连接

服务器上构建并常驻服务，`TASTE_PUBLIC_URL` 写成浏览器访问的地址，服务据此放行该地址的请求与写入：

```bash
cd app && pnpm install --frozen-lockfile && pnpm build
TASTE_PUBLIC_URL=https://lab.example.ts.net node dist-node/server/index.js   # 生产用 systemd 常驻
tailscale serve --bg http://127.0.0.1:4178
```

正式数据默认写入服务器的 `~/.local/share/taste`。数据库只记录相对 Runtime 根的路径，整个目录可以原样搬到另一台机器。

使用端把 `app/bin/taste` 链接进 PATH，并设置 `TASTE_URL` 指向同一地址后，所有命令都走服务器：`taste` 或 `taste open` 打开浏览器，`taste status` 查看连通性；`start`、`stop`、`regenerate-previews` 需在服务器上执行。不设置 `TASTE_URL` 时 CLI 按原方式在本机 `127.0.0.1:4178` 启动服务，用于开发。完整命令见 `taste help`。

## 典型用法

```bash
taste list
taste search "编辑感"
taste create --title "待补素材" --note "稍后整理" --tag 待整理
taste import ./a.png ./b.png --title "同一组参考" --tag UI
taste import ./demo.html --copy
taste tags
taste update <item-id> --title "新标题" --tags "UI,仪表盘"
taste asset move <asset-id> <item-id|staged>
taste asset rename <asset-id> "新名称"
taste asset crop <asset-id> off
taste layout <asset-id> --x 10 --y 20 --width 420 --height 300
taste trash empty --permanently
```

CLI 导入把文件内容上传给服务，服务端确认入库后默认删除本机源文件；需要保留原文件时传入 `--copy`。浏览器上传始终复制。导出交给浏览器下载，单个素材是原文件，多选打成一个 zip。SQLite 和 Runtime 内部路径不是公共接口。

### 让 Agent 导入

[skills/taste-import/](skills/taste-import/SKILL.md) 是配套的 Agent Skill，规定 Agent 导入或整理素材时如何命名、分组、打形态标签和记录来源。修改后运行部署脚本，把 `skills/` 下的全部 Skill 同步到 cc-switch（`~/.cc-switch/skills`）和 SmartWork（`~/.SmartWork/skills`），目标目录中仓库已删除的文件会一并清理：

```bash
scripts/deploy-skills.sh
```

首次部署后在 cc-switch 中导入该 Skill 并为 Claude Code 启用。

## 架构与技术栈

只监听回环地址、经反向代理对外的单人应用。React 页面和 `taste` CLI 走同一个 HTTP 服务，SQLite 与 Runtime 文件不是公共接口——CLI 除启动、停止和状态查询外的所有命令都调 HTTP，因此两个入口永远看到同一份状态。

`app/server/http.ts` 负责路由、请求校验和访问边界，`app/server/library.ts` 是内容组、素材、排序、布局与文件生命周期的唯一技术 Owner，`app/server/preview.ts` 经 sharp 子进程生成图片预览并在可用时调 Chrome 截 HTML，`app/server/runtime.ts` 解析并创建仓库外的 Runtime 目录。模块关系见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 开发与验证

所有 pnpm 命令从 `app/` 执行：

```bash
cd app
pnpm dev
pnpm test
```

`pnpm test` 会先生成生产构建，再使用临时 `TASTE_HOME` 验证存储状态机、HTTP 接口和 CLI 安全边界，不会读取或修改正式 Runtime。

## 仓库结构

- [app/src/](app/src/)：素材墙、内容组与无限画布前端
- [app/server/](app/server/)：本地服务、SQLite 存储与文件生命周期
- [app/cli/](app/cli/)、[app/bin/taste](app/bin/taste)：与浏览器同能力的 CLI 实现与入口
- [skills/](skills/)、[scripts/deploy-skills.sh](scripts/deploy-skills.sh)：配套的 Agent Skill 与部署脚本
- [ARCHITECTURE.md](ARCHITECTURE.md)：实现结构与安全边界
- [CHANGELOG.md](CHANGELOG.md)：版本变化

## License

[MIT](LICENSE) © Amonliu
