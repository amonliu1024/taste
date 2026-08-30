import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimePaths {
  home: string;
  dbDir: string;
  db: string;
  files: string;
  previews: string;
  incoming: string;
  run: string;
  logs: string;
  serverInfo: string;
  serverLog: string;
}

export function getRuntimePaths(homeOverride = process.env.TASTE_HOME): RuntimePaths {
  const home = resolve(homeOverride || join(homedir(), ".local", "share", "taste"));
  return {
    home,
    dbDir: join(home, "db"),
    db: join(home, "db", "taste.sqlite"),
    files: join(home, "files"),
    previews: join(home, "previews"),
    incoming: join(home, ".incoming"),
    run: join(home, "run"),
    logs: join(home, "logs"),
    serverInfo: join(home, "run", "server.json"),
    serverLog: join(home, "logs", "server.log"),
  };
}

export function ensureRuntime(paths = getRuntimePaths()): RuntimePaths {
  for (const directory of [
    paths.home,
    paths.dbDir,
    paths.files,
    paths.previews,
    paths.incoming,
    paths.run,
    paths.logs,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return paths;
}
