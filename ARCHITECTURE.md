# Architecture

Taste 是一个部署在服务器上的单人应用：服务只监听回环地址，由反向代理对外提供一个私有 HTTPS 地址，访问控制由私有网络和客户端凭据共同承担。React 页面和 `taste` CLI 都通过同一个 HTTP 服务访问 `LibraryStore`；SQLite 和 Runtime 文件不作为公共接口。

## 部署拓扑

```text
使用端（任意私有网络设备）                     服务器
───────────────────────                        ──────────────────────────────────────────────
浏览器 ───────────┐                             tailscale serve（私有 HTTPS 地址）
                  ├── HTTPS ───────────────→         │ 反向代理
taste CLI ────────┘                                  v
  client.json / 环境变量配置同一地址                        HTTP service（127.0.0.1:4178）
  import 上传文件内容                              ├─ LibraryStore ─ SQLite
                                                   │        └───── Runtime 文件
                                                   └─ preview ─ image-worker（sharp）
                                                               ├ heif-dec / heif-convert（HEIC）
                                                               └ Chrome（HTML 截图）
```

CLI 始终连接服务器，缺少连接配置或凭据时直接报错。开发与测试通过独立服务入口显式设置临时 `TASTE_HOME`；客户端仍经 HTTP 访问该隔离服务。本文描述当前代码；正式服务器的配置切换按[维护说明](docs/operations/client-server.md)执行。

## 模块

- `app/src/`：素材墙、抽屉和无限画布，只消费 HTTP 返回的资源表示；导出通过浏览器下载 `/api/export`。
- `app/cli/`：只包含远程客户端、连接配置和 SSH 备份；不导入服务端模块。`client.ts` 统一解析配置、鉴权、超时及重试编号；导入得到持久化回执后，核对本机源文件内容再按模式删除。客户端安装和固定清单分发见[维护说明](docs/operations/client-server.md)。
- `app/server/http.ts`：路由、请求校验和访问边界（回环地址加 `TASTE_PUBLIC_URL`），鉴权通过后导出单个原文件或 zip。
- `app/server/auth.ts`：客户端 Token 校验和签名浏览器会话；对外服务缺少凭据时拒绝启动。
- `app/server/maintenance.ts`：显式指定 Runtime 的预览重建维护入口。
- `app/server/zip.ts`：以 STORE 方式打包多选导出，文件名按 UTF-8 标记写入。
- `app/server/library.ts`：内容组、素材、排序、布局、路径与文件生命周期的唯一技术 Owner，也承担预览重建（`regeneratePreviews`）与持久化请求回执。
- `app/server/preview.ts`：图片尺寸、预览、自动去边检测和 HTML 截图的入口。裁切框由 `library.ts` 的 `setAssetCrop` 统一写入，前端 `app/src/media.tsx` 统一按裁切框显示预览与原图。导入时把 HEIC/HEIF 转为 JPEG 保存，去重仍按来源文件哈希。
- `app/server/image-worker.ts`：sharp 只有异步接口，而导入在同步事务里运行，`preview.ts` 用同步子进程调用它，调用方保持同步且与平台无关。HEIC 使用 HEVC 编码，sharp 自带的 libheif 不含该解码器，交给 Linux 的 `heif-dec`/`heif-convert` 或 macOS 的 `sips`。
- `app/server/runtime.ts`：解析并创建仓库外的 Runtime 目录。

## 配置

| 变量 | 作用于 | 含义 |
| --- | --- | --- |
| `TASTE_HOME` | 服务 | Runtime 根目录，默认 `~/.local/share/taste` |
| `TASTE_PORT` | 服务 | 监听端口，默认 `4178` |
| `TASTE_PUBLIC_URL` | 服务 | 反向代理对外的完整地址（含端口），放行该 Host 与 Origin |
| `TASTE_CLIENTS_FILE` | 服务 | 仓外、权限 600 的客户端名称到独立 Token 的 JSON 映射 |
| `TASTE_CONFIG` | CLI | 客户端配置文件路径，默认 `~/.config/taste/client.json` |
| `TASTE_URL` / `TASTE_TOKEN` | CLI | 分别覆盖配置文件中的 `url` / `token` |

## Runtime

默认 Runtime 位于 `~/.local/share/taste`，可通过 `TASTE_HOME` 覆盖：

```text
db/taste.sqlite
files/<asset-id>/<stored-name>
previews/<asset-id>.<webp|jpg>
run/server.json
logs/server.log
```

[预览生成器](app/server/preview.ts)为图片生成 WebP 预览，为 HTML 生成 JPG 截图；历史预览可能保留旧格式，执行 `regenerate-previews` 后按当前规则重建。

数据库中的文件路径都相对 Runtime 根保存，Runtime 可以整体搬到另一台机器；打开旧库时自动把绝对路径按固定布局转成相对路径。正式素材、SQLite、预览、PID 和日志都不能进入 Git。测试必须使用临时 `TASTE_HOME`。

## 数据与文件生命周期

内容组拥有标题、备注、标签、人工顺序和零到多个素材。每个素材保存文件状态、所属内容组和画布布局；同一文件哈希全局唯一。

`LibraryStore` 在事务中维护以下不变量：

- 活跃素材必须属于活跃内容组。
- 暂存或独立废弃素材不属于内容组。
- 移走最后一个素材时删除空内容组。
- 完整排序更新必须精确包含全部活跃内容组。
- 上传内容先落到 `.incoming/`，复制后校验哈希，整组素材在同一事务内入库，失败时清理全部中间文件。

服务端只接收上传的文件内容，不读取调用方指定的服务器路径。浏览器上传始终复制；CLI 导入由 CLI 上传，服务端入库成功后默认删除本机来源，删除前核对源文件仍与上传内容一致，失败时报告保留下来的文件，显式传入 `--copy` 始终保留。

## 请求回执

CLI 的每个写请求携带 UUID `Idempotency-Key`。HTTP 路由将同步业务操作交给 `LibraryStore.executeRequest`，请求编号、客户端、方法/路径/正文摘要、响应与业务数据在同一个 SQLite 事务中提交。重复编号和相同请求返回原响应；不同客户端或内容返回 409。已有业务事务使用 savepoint 嵌入请求事务，导入文件的回滚及废纸篓文件的提交清理也由该事务统一协调。回执没有自动过期，随数据库备份和恢复。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`；Host 只接受回环地址与 `TASTE_PUBLIC_URL`，浏览器写请求的 Origin 必须是回环同源或该公开地址。除仅返回 `{ok:true}` 的健康检查外，资源请求还需独立 Token 或浏览器签名会话。
- HTML 素材在不同 Origin 的 sandbox iframe 中运行，不能访问 Taste 顶层页面。
- 永久清空废纸篓要求服务端确认字段，CLI 还要求 `--permanently`。
- 导出只接受活跃素材 ID，下载内容来自 Runtime 内的原文件，不接受调用方传入路径。
- 日常客户端不创建 Runtime、不启动或停止服务；服务进程由服务器维护入口与进程管理器管理。
- 网页会话 Cookie 为 HttpOnly、SameSite=Strict，对外 HTTPS 时使用 Secure；Token 不进入 URL，客户端请求禁止重定向。
- Runtime 目录使用仅当前用户可访问的权限创建。

## 构建与验证

`app/package.json` 是版本源和构建入口。`pnpm test` 先运行 TypeScript 与 Vite 生产构建，再通过隔离 Runtime 覆盖存储状态机、路径迁移、图片处理、HTTP 访问边界与导出、CLI 缺配置保护、鉴权、回执重试、远程导入及独立安装。CI 在 macOS 与 Ubuntu 上各跑一遍；HEIC 夹具依赖 `sips` 生成，Linux 上跳过该用例。画布和最终 CSS 变化还需要在生产构建上进行真实浏览器验证。
