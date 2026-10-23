import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClients } from "./auth.js";
import { createTasteHttpServer } from "./http.js";

export async function startServer(): Promise<void> {
  if (!process.env.TASTE_PUBLIC_URL && !process.env.TASTE_HOME) throw new Error("隔离开发服务必须显式设置临时 TASTE_HOME；正式服务需配置 TASTE_PUBLIC_URL 和 TASTE_CLIENTS_FILE。");
  const clients = readClients(process.env.TASTE_CLIENTS_FILE);
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  const server = createTasteHttpServer({ webRoot, publicUrl: process.env.TASTE_PUBLIC_URL || undefined, clients });
  const address = await server.listen(Number(process.env.TASTE_PORT ?? 4178));

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  console.log(`Taste listening on http://127.0.0.1:${address.port}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
