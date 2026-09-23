# Architecture

Taste 是一个部署在服务器上的单人应用：服务只监听回环地址，由反向代理对外提供一个私有 HTTPS 地址，访问控制交给私有网络。React 页面和 `taste` CLI 都通过同一个 HTTP 服务访问 `LibraryStore`；SQLite 和 Runtime 文件不作为公共接口。

## 部署拓扑

```text
使用端（任意私有网络设备）                     服务器
───────────────────────                        ──────────────────────────────────────────────
浏览器 ───────────┐                             tailscale serve（私有 HTTPS 地址）
                  ├── HTTPS ───────────────→         │ 反向代理
taste CLI ────────┘                                  v
  TASTE_URL 指向同一地址                        HTTP service（127.0.0.1:4178）
  import 上传文件内容                              ├─ LibraryStore ─ SQLite
                                                   │        └───── Runtime 文件
                                                   └─ preview ─ image-worker（sharp）
                                                               ├ heif-dec / heif-convert（HEIC）
                                                               └ Chrome（HTML 截图）
```

不设置 `TASTE_URL` 时，CLI 在本机 `127.0.0.1:4178` 启动同一个服务，用于开发；两种形态共用全部代码。

## 模块

- `app/src/`：素材墙、抽屉和无限画布，只消费 HTTP 返回的资源表示；导出通过浏览器下载 `/api/export`。
- `app/cli/`：除本机模式的启动、停止和状态查询外，所有命令都调用 `TASTE_URL` 或本机的 HTTP 服务；导入读取本机文件后上传，入库成功再按模式删除本机源文件。
- `app/server/http.ts`：路由、请求校验和访问边界（回环地址加 `TASTE_PUBLIC_URL`），导出单个原文件或 zip。
- `app/server/zip.ts`：以 STORE 方式打包多选导出，文件名按 UTF-8 标记写入。
- `app/server/library.ts`：内容组、素材、排序、布局、路径与文件生命周期的唯一技术 Owner，也承担预览重建（`regeneratePreviews`）。
- `app/server/preview.ts`：图片尺寸、预览、自动去边检测和 HTML 截图的入口。裁切框由 `library.ts` 的 `setAssetCrop` 统一写入，前端 `app/src/media.tsx` 统一按裁切框显示预览与原图。导入时把 HEIC/HEIF 转为 JPEG 保存，去重仍按来源文件哈希。
- `app/server/image-worker.ts`：sharp 只有异步接口，而导入在同步事务里运行，`preview.ts` 用同步子进程调用它，调用方保持同步且与平台无关。HEIC 使用 HEVC 编码，sharp 自带的 libheif 不含该解码器，交给 Linux 的 `heif-dec`/`heif-convert` 或 macOS 的 `sips`。
- `app/server/runtime.ts`：解析并创建仓库外的 Runtime 目录。

## 配置

| 变量 | 作用于 | 含义 |
| --- | --- | --- |
| `TASTE_HOME` | 服务 | Runtime 根目录，默认 `~/.local/share/taste` |
| `TASTE_PORT` | 服务、本机 CLI | 监听端口，默认 `4178` |
| `TASTE_PUBLIC_URL` | 服务 | 反向代理对外的完整地址（含端口），放行该 Host 与 Origin |
| `TASTE_URL` | CLI | 远程服务地址；设置后 CLI 不在本机启动服务 |

## Runtime

默认 Runtime 位于 `~/.local/share/taste`，可通过 `TASTE_HOME` 覆盖：

```text
db/taste.sqlite
files/<asset-id>/<stored-name>
previews/<asset-id>.<jpg|png>
run/server.json
logs/server.log
```

数据库中的文件路径都相对 Runtime 根保存，Runtime 可以整体搬到另一台机器；打开旧库时自动把绝对路径按固定布局转成相对路径。正式素材、SQLite、预览、PID 和日志都不能进入 Git。测试必须使用临时 `TASTE_HOME`。

## 数据与文件生命周期

内容组拥有标题、备注、标签、人工顺序和零到多个素材。每个素材保存文件状态、所属内容组和画布布局；同一文件哈希全局唯一。

`LibraryStore` 在事务中维护以下不变量：

- 活跃素材必须属于活跃内容组。
- 暂存或独立废弃素材不属于内容组。
- 移走最后一个素材时删除空内容组。
- 完整排序更新必须精确包含全部活跃内容组。
- 上传内容先落到 `.incoming/`，复制后校验哈希，整组素材在同一事务内入库，失败时清理全部中间文件。

服务端只接收上传的文件内容，不读取调用方指定的服务器路径。浏览器上传始终复制；CLI 导入由 CLI 上传，服务端入库成功后默认删除本机来源，删除失败时报告保留下来的文件，显式传入 `--copy` 才保留。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`；Host 只接受回环地址与 `TASTE_PUBLIC_URL`，浏览器写请求的 Origin 必须是回环同源或该公开地址。访问控制由私有网络承担。
- HTML 素材在不同 Origin 的 sandbox iframe 中运行，不能访问 Taste 顶层页面。
- 永久清空废纸篓要求服务端确认字段，CLI 还要求 `--permanently`。
- 导出只接受活跃素材 ID，下载内容来自 Runtime 内的原文件，不接受调用方传入路径。
- 本机模式的 `taste stop` 同时核对 Runtime、健康检查和 PID，避免终止无关进程；远程模式下启停由服务器管理。
- Runtime 目录使用仅当前用户可访问的权限创建。

## 构建与验证

`app/package.json` 是版本源和构建入口。`pnpm test` 先运行 TypeScript 与 Vite 生产构建，再通过隔离 Runtime 覆盖存储状态机、路径迁移、图片处理、HTTP 访问边界与导出、CLI 远程导入和停止保护。CI 在 macOS 与 Ubuntu 上各跑一遍；HEIC 夹具依赖 `sips` 生成，Linux 上跳过该用例。画布和最终 CSS 变化还需要在生产构建上进行真实浏览器验证。
