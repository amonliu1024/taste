# Taste

<img src="app/public/taste-icon.png" alt="Taste icon" width="112">

Taste 是一个单人、Agent 友好的视觉内容库，部署在自己的服务器上，经私有网络从任意设备使用。

视觉参考天生留不住：截图散在 `截屏2026-08-25 10.32.15.png` 里，好看的页面存成一堆孤立 HTML，收藏夹里的东西三个月后自己也想不起当初为什么存。找不回来，更没法让 Agent 帮你找。

Taste 把图片和单体 HTML 收进统一 Runtime：用极简素材墙浏览，用无限画布查看和整理内容组，标题、备注、标签、素材归属和画布布局全是真实持久化数据——不是浏览器缓存，也不是一份会飘的 JSON。同一套数据有一个完整的 CLI，所以「帮我把这半年攒的仪表盘参考归到一组、加上标签」是一句话能交出去的活。

单人自用，日常可用。服务只监听回环地址，由反向代理（如 `tailscale serve`）把一个私有 HTTPS 地址转给它，访问控制交给私有网络，Taste 本身没有账号与登录。数据只在服务器上保存一份，用 `taste backup` 手动把它拉回本机备份。

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

以 Ubuntu 服务器加 Tailscale 为例。先装系统依赖（Node.js 22 用官方发行包），再在 `app/` 里安装并构建：

```bash
sudo apt install ./google-chrome-stable_current_amd64.deb fonts-noto-cjk libheif-examples libheif-plugin-libde265
cd app && pnpm install --frozen-lockfile && pnpm build
```

用 systemd 常驻服务。`TASTE_PUBLIC_URL` 必须与浏览器实际访问的地址完全一致（含端口），服务据此放行该地址的请求与写入；Tailscale 的私有 HTTPS 地址只支持 443、8443、10000 三个端口：

```ini
[Service]
User=<你的用户>
WorkingDirectory=/path/to/taste/app
Environment=TASTE_PUBLIC_URL=https://lab.example.ts.net:10000
ExecStart=/usr/local/bin/node dist-node/server/index.js
Restart=on-failure
```

```bash
tailscale serve --bg --https=10000 http://127.0.0.1:4178
```

正式数据默认写入服务器的 `~/.local/share/taste`。数据库只记录相对 Runtime 根的路径，整个目录可以原样搬到另一台机器，旧库在首次打开时自动转换。

服务器上的代码直接检出本仓库，更新时拉取、重新构建并重启：

```bash
git pull --ff-only && cd app && pnpm install --frozen-lockfile && pnpm build && sudo systemctl restart taste
```

使用端把 `app/bin/taste` 链接进 PATH，并在 shell 配置里设置 `TASTE_URL` 为同一地址，所有命令就都作用于服务器数据：`taste` 或 `taste open` 打开浏览器，`taste status` 查看连通性；`start`、`stop`、`regenerate-previews` 需在服务器上执行。不设置 `TASTE_URL` 时 CLI 在本机 `127.0.0.1:4178` 启动服务，用于开发。完整命令见 `taste help`，全部配置项见 [ARCHITECTURE.md](ARCHITECTURE.md#配置)。

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

### 备份与恢复

```bash
taste backup lab                      # 默认备份到 ~/Backups/taste
taste backup lab --to /Volumes/Disk/taste
```

`taste backup` 通过 SSH 在服务器上用 SQLite 在线备份生成一致的数据库快照，按本地时间存为 `db/taste-YYYYMMDD-HHMMSS.sqlite`，再用 rsync 增量拉取 `files/` 与 `previews/`。素材与预览只增不删，所以任一快照都能配合同目录的文件恢复到当时的状态：把选中的快照复制为新 Runtime 的 `db/taste.sqlite`，连同 `files/`、`previews/` 放进 `TASTE_HOME` 即可。服务器 Runtime 不在默认位置时用 `--remote-home` 指定。

CLI 导入把文件内容上传给服务，服务端确认入库后默认删除本机源文件；需要保留原文件时传入 `--copy`。浏览器上传始终复制。导出交给浏览器下载，单个素材是原文件，多选打成一个 zip。SQLite 和 Runtime 内部路径不是公共接口。

### 让 Agent 导入

[skills/taste-import/](skills/taste-import/SKILL.md) 是配套的 Agent Skill，规定 Agent 导入或整理素材时如何命名、分组、打形态标签和记录来源。修改后运行部署脚本，把 `skills/` 下的全部 Skill 同步到 cc-switch（`~/.cc-switch/skills`）和 SmartWork（`~/.SmartWork/skills`），目标目录中仓库已删除的文件会一并清理：

```bash
scripts/deploy-skills.sh
```

首次部署后在 cc-switch 中导入该 Skill 并为 Claude Code 启用。

## 架构与技术栈

只监听回环地址、经反向代理对外的单人应用。React 页面和 `taste` CLI 的素材查询、导入与编辑通过同一个 HTTP 服务访问数据；预览重建与备份另走本机或 SSH 路径，见 [ARCHITECTURE.md](ARCHITECTURE.md#模块)。SQLite 与 Runtime 文件不是公共接口。

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
- [app/server/](app/server/)：HTTP 服务、SQLite 存储、文件生命周期与图片处理
- [app/cli/](app/cli/)、[app/bin/taste](app/bin/taste)：与浏览器同能力的 CLI 实现与入口
- [skills/](skills/)、[scripts/deploy-skills.sh](scripts/deploy-skills.sh)：配套的 Agent Skill 与部署脚本
- [ARCHITECTURE.md](ARCHITECTURE.md)：实现结构与安全边界
- [CHANGELOG.md](CHANGELOG.md)：版本变化

## License

[MIT](LICENSE) © Amonliu
