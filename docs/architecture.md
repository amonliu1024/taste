# Architecture

Taste 是一个仅监听回环地址的本机应用。React 页面和 `taste` CLI 都通过同一个 HTTP 服务访问 `LibraryStore`；SQLite 和 Runtime 文件不作为公共接口。

## 模块

```text
Browser ─┐
         ├─ HTTP service ─ LibraryStore ─ SQLite
CLI ─────┘                    └────────── Runtime files
```

- `app/src/`：素材墙、抽屉和无限画布，只消费 HTTP 返回的资源表示。
- `app/cli/`：除启动、停止和状态查询外，所有命令都调用本地 HTTP 服务。
- `app/server/http.ts`：路由、请求校验和回环地址安全边界。
- `app/server/library.ts`：内容组、素材、排序、布局和文件生命周期的唯一技术 Owner。
- `app/server/preview.ts`：使用 macOS `sips` 生成图片预览，并在可用时使用本机 Chrome/Chromium 生成 HTML 截图。
- `app/server/runtime.ts`：解析并创建仓库外的 Runtime 目录。

## Runtime

默认 Runtime 位于 `~/.local/share/taste`，可通过 `TASTE_HOME` 覆盖：

```text
db/taste.sqlite
files/<asset-id>/<original-name>
previews/<asset-id>.jpg
run/server.json
logs/server.log
```

正式素材、SQLite、预览、PID 和日志都不能进入 Git。测试必须使用临时 `TASTE_HOME`。

## 数据与文件生命周期

内容组拥有标题、备注、标签、人工顺序和零到多个素材。每个素材保存文件状态、所属内容组和画布布局；同一文件哈希全局唯一。

`LibraryStore` 在事务中维护以下不变量：

- 活跃素材必须属于活跃内容组。
- 暂存或独立废弃素材不属于内容组。
- 移走最后一个素材时删除空内容组。
- 完整排序更新必须精确包含全部活跃内容组。
- 跨文件系统移动先复制并校验哈希，成功后才删除来源。

浏览器上传始终复制。CLI 导入默认移动，只有显式传入 `--copy` 才保留来源。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`，并拒绝跨 Origin 的浏览器写请求。
- HTML 素材在不同 Origin 的 sandbox iframe 中运行，不能访问 Taste 顶层页面。
- 永久清空废纸篓要求服务端确认字段，CLI 还要求 `--permanently`。
- `taste stop` 同时核对 Runtime、健康检查和 PID，避免终止无关进程。
- Runtime 目录使用仅当前用户可访问的权限创建。

## 构建与验证

`app/package.json` 是版本源和构建入口。`pnpm test` 先运行 TypeScript 与 Vite 生产构建，再通过隔离 Runtime 覆盖存储状态机、HTTP 接口和 CLI 停止保护。画布和最终 CSS 变化还需要在生产构建上进行真实浏览器验证。
