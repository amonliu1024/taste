#!/usr/bin/env node
import { LibraryStore } from "./library.js";

if (process.argv[2] !== "regenerate-previews" || !process.env.TASTE_HOME) {
  console.error("用法：TASTE_HOME=<Runtime 路径> node dist-node/server/maintenance.js regenerate-previews");
  process.exit(1);
}
const store = new LibraryStore();
try { console.log(JSON.stringify(store.regeneratePreviews(), null, 2)); }
finally { store.close(); }
