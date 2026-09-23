# Architecture

Taste 是一个仅监听回环地址、经反向代理对外提供私有 HTTPS 地址的单人应用。React 页面和 `taste` CLI 都通过同一个 HTTP 服务访问 `LibraryStore`；SQLite 和 Runtime 文件不作为公共接口。

## 模块

```text
Browser ─┐
         ├─ HTTP service ─ LibraryStore ─ SQLite
CLI ─────┘                    └────────── Runtime files
```

- `app/src/`：素材墙、抽屉和无限画布，只消费 HTTP 返回的资源表示。
- `app/cli/`：除启动、停止和状态查询外，所有命令都调用本地 HTTP 服务。
- `app/server/http.ts`：路由、请求校验和访问边界（回环地址加 `TASTE_PUBLIC_URL`），导出下载与 zip 打包（`zip.ts`）。
- `app/server/library.ts`：内容组、素材、排序、布局和文件生命周期的唯一技术 Owner。
- `app/server/preview.ts`：经 `image-worker.ts` 子进程调用 sharp 读取尺寸、生成图片预览、检测截图纯色边框得到自动去边裁切框（子进程让导入事务保持同步），HEIC 交给 libheif 工具或 macOS `sips` 解码，并在可用时使用 Chrome/Chromium 生成 HTML 截图。裁切框由 `library.ts` 的 `setAssetCrop` 统一写入，前端 `app/src/media.tsx` 统一按裁切框显示预览与原图。导入时把 HEIC/HEIF 转为 JPEG 保存，去重仍按来源文件哈希。
- `app/server/runtime.ts`：解析并创建仓库外的 Runtime 目录。

## Runtime

默认 Runtime 位于 `~/.local/share/taste`，可通过 `TASTE_HOME` 覆盖：

```text
db/taste.sqlite
files/<asset-id>/<stored-name>
previews/<asset-id>.jpg
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
- 跨文件系统移动先复制并校验哈希，成功后才删除来源。

服务端只接收上传的文件内容，不读取调用方指定的服务器路径。浏览器上传始终复制；CLI 导入由 CLI 上传，服务端入库成功后默认删除本机来源，显式传入 `--copy` 才保留。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`；Host 只接受回环地址与 `TASTE_PUBLIC_URL`，浏览器写请求的 Origin 必须是回环同源或该公开地址。访问控制由私有网络承担。
- HTML 素材在不同 Origin 的 sandbox iframe 中运行，不能访问 Taste 顶层页面。
- 永久清空废纸篓要求服务端确认字段，CLI 还要求 `--permanently`。
- `taste stop` 同时核对 Runtime、健康检查和 PID，避免终止无关进程。
- Runtime 目录使用仅当前用户可访问的权限创建。

## 构建与验证

`app/package.json` 是版本源和构建入口。`pnpm test` 先运行 TypeScript 与 Vite 生产构建，再通过隔离 Runtime 覆盖存储状态机、HTTP 接口和 CLI 停止保护。画布和最终 CSS 变化还需要在生产构建上进行真实浏览器验证。
