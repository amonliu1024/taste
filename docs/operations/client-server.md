# 客户端连接与服务维护

Taste 客户端只连接服务器。本机与云端 Agent 使用同一份客户端；缺少配置、凭据错误或断线时直接报错。SQLite、素材、缩略图和服务进程都由服务器持有。

## 安装和连接

源码在 `app/` 完成 `pnpm build` 后，运行 `sh scripts/install-client.sh`。安装器将已构建的客户端复制到 `~/.local/share/taste-client`，并将命令链接到 `~/.local/bin/taste`。日常运行只需要 Node.js 22.13 以上版本，不依赖源码目录、pnpm、预览依赖或服务器程序。

管理员可运行 `sh scripts/package-client.sh /tmp/taste-client.tar.gz` 生成固定清单的分发包；本地与云端解包后都运行其中的 `scripts/install-client.sh`。包内只有客户端、安装入口和说明。`TASTE_CLIENT_DIR`、`TASTE_BIN_DIR` 可指定安装位置。

将服务器完整地址和管理员分配的凭据保存到仓外 `~/.config/taste/client.json`：

```json
{"url":"https://lab.example.ts.net:10000","token":"<管理员分配的客户端凭据>"}
```

配置目录权限设为 700，文件权限设为 600。`TASTE_CONFIG` 可指定配置路径；`TASTE_URL` 和 `TASTE_TOKEN` 分别覆盖字段。地址必须是 HTTPS，隔离测试服务允许回环 HTTP；地址中不能包含用户名、密码、查询参数或片段。云端通过环境变量提供地址，通过受保护的凭据设置提供 Token。

运行 `taste config` 查看地址、配置来源和凭据是否就绪，输出不会显示 Token。`taste doctor` 或 `taste status` 检查连接和鉴权；失败时以非零状态退出。`taste` 或 `taste open` 打开网页；网页首次输入访问凭据后保存 30 天会话，Token 撤销或更换后原会话失效。

`start`、`stop`、`regenerate-previews` 已退出客户端。开发与测试通过独立服务入口运行，使用显式的临时 `TASTE_HOME`，客户端仍经 HTTP 连接该隔离服务。

## 写入和重试

每次客户端写入带一个 UUID 请求编号。成功结果与业务数据在同一 SQLite 事务中保存；同一客户端用相同编号和相同请求内容重试，返回原结果。换客户端或改动请求内容会返回冲突。回执保留在服务器数据库中，重启后仍有效。

连接中断、超时或响应不可读时，命令输出请求编号。恢复连接后，将编号放在原命令前重试：

```bash
taste --request-id <原 UUID> create --title "参考"
taste --request-id <原 UUID> import ./reference.png
```

客户端不会自动重试写入。重试导入时保持文件名、文件内容和参数一致；只有服务器确认回执，且本机源文件仍与上传内容一致时才删除源文件。源文件变化、权限错误或连接中断时保留源文件；`--copy` 始终保留。

## 服务端凭据与更新

服务继续监听回环地址，经 Tailscale 私有 HTTPS 的现有地址访问。在仓外创建权限 600 的客户端凭据 JSON，由 `TASTE_CLIENTS_FILE` 指向它，内容是客户端名称到 Token 的映射，例如 `local`、`cloud`。每个 Token 独立且至少 32 字符，用安全随机源生成；凭据不写进代码、提交或日志。

```ini
Environment=TASTE_PUBLIC_URL=https://lab.example.ts.net:10000
Environment=TASTE_CLIENTS_FILE=/etc/taste/clients.json
```

配置了对外地址而缺少凭据时，服务拒绝启动。除仅返回存活状态的 `/api/health` 外，API、原图、预览、HTML 和导出都要求 Bearer Token 或浏览器会话；网页会话使用 HttpOnly、SameSite=Strict Cookie，对外 HTTPS 时附加 Secure。来源检查继续生效；浏览器提交凭据不进入 URL。

上线前先取得刘顺确认，再运行 `taste backup lab`，留存当前代码、服务配置和一致数据库快照；首次启动新代码会新增请求回执表。准备好服务器凭据文件及本地、云端配置后，再构建、重启并核对服务器提交和健康状态。新旧客户端与服务端应一起切换；旧客户端不发送凭据，新客户端也会拒绝没有持久化回执确认的写入响应。

上线后分别验证两个凭据的读取、错误凭据拒绝、网页访问、同编号重试、导入源文件保留与删除。服务器地址和 Tailscale 端口保持现有值。回滚程序时恢复上版代码与配置；保留最新服务器 Runtime，新代码新增的回执表不影响旧代码读取素材数据。若已发生新写入，使用最新完整备份恢复，避免覆盖为切换前数据。

## 备份和恢复

`taste backup lab` 继续生成 SQLite 一致快照并增量拉取素材和预览。请求回执与数据库一起备份。恢复时停止服务，选定快照为新 Runtime 的 `db/taste.sqlite`，配合同一备份目录的 `files/`、`previews/`，再用服务器维护入口启动；凭据文件和服务配置另外从受保护位置恢复。先在隔离目录核对恢复结果，再替换正式 Runtime。

在服务所在机器重建预览时，使用维护入口：

```bash
TASTE_HOME=/path/to/runtime node dist-node/server/maintenance.js regenerate-previews
```

开发测试使用临时目录：

```bash
TASTE_HOME="$(mktemp -d)" TASTE_PORT=14178 node dist-node/server/index.js
```
