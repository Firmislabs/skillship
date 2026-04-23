import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TmpCtx {
  readonly dir: string;
  readonly dbPath: string;
  cleanup(): void;
}

export function makeTmpCtx(prefix = "skillship-"): TmpCtx {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const dbPath = join(dir, "graph.sqlite");
  return {
    dir,
    dbPath,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
