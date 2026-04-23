import Database, { type Database as Sqlite3Database } from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GraphDb {
  readonly db: Sqlite3Database;
  readonly path: string;
  close(): void;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(HERE, "schema.sql");

export function openGraph(path: string): GraphDb {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const ddl = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(ddl);
  return {
    db,
    path,
    close: (): void => {
      if (db.open) db.close();
    },
  };
}
