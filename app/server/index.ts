import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTasteHttpServer } from "./http.js";

export async function startServer(): Promise<void> {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
  const server = createTasteHttpServer({ webRoot });
  const address = await server.listen(Number(process.env.TASTE_PORT ?? 4178));
  writeFileSync(server.store.paths.serverInfo, JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date().toISOString() }), { mode: 0o600 });

  const shutdown = async () => {
    if (existsSync(server.store.paths.serverInfo)) rmSync(server.store.paths.serverInfo, { force: true });
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`Taste listening on http://127.0.0.1:${address.port}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
