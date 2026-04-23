# SPRINT_JOURNAL

One entry per task attempt. Format: started / status / duration / pre-flight /
tests + exit codes / files changed / checkpoint tag or rollback reason.

---

## Session: 2026-04-23 — Phase 1 (Foundation)

### T0 — git init + scaffold baseline commit
- **Started:** 2026-04-23 12:01 local
- **Status:** completed
- **Reason:** the incoming brief assumed the skillship dir was already a
  git repo, but `git rev-parse --show-toplevel` reported no `.git` existed
  anywhere up the tree. Initialized a fresh repo with `git init -b main`
  and committed the scaffold (11 files / 3711 insertions) as the root
  commit so `sprint/P1-complete` and `sprint/P2-complete` tags have a
  base to land on.
- **Pre-flight:** `npm run typecheck` EXIT=0. `npm test` EXIT=1 — vitest
  exits non-zero when no test files are present (expected; resolves once
  tests exist).
- **Commit:** `83a579d` "scaffold: initial TypeScript project + docs +
  graph types/DDL"
- **Files:** .gitignore, PLAN.md, README.md, docs/, package.json,
  package-lock.json, src/graph/{types.ts,schema.sql}, tsconfig.json,
  vitest.config.ts.

### T1 — src/graph/db.ts (TDD)
- **Status:** completed
- **Pre-flight:** typecheck EXIT=0
- **RED:** `tests/graph/db.test.ts` — 4 tests, failed to import
  `../../src/graph/db.js` (file did not exist). RED verified.
- **GREEN:** implemented `openGraph(path)` returning a typed `GraphDb`
  handle. Applies `src/graph/schema.sql` via `better-sqlite3`. Enables
  `foreign_keys` + WAL journal. Idempotent on re-open.
- **Tests:** `npx vitest run tests/graph/db.test.ts` → 4 passed, EXIT=0.
- **Files changed:** +src/graph/db.ts, +tests/helpers.ts, +tests/graph/db.test.ts.

### T2 — src/graph/repo.ts (TDD)
- **Status:** completed
- **Pre-flight:** db.ts green.
- **RED:** `tests/graph/repo.test.ts` — 6 tests, import failed. RED
  verified.
- **GREEN:** typed CRUD for `nodes`, `claims`, `edges`, `overrides`,
  `sources`. `insertEdge` uses `INSERT OR IGNORE` on the
  `uq_edges_triple` unique index. `upsertSource` re-reads after insert
  so duplicate sha256s return the existing row.
- **Tests:** 6 passed (round-trip Product/Surface/Operation with 3
  claims each, chosen=1; setClaimChosen flips winner; edge idempotent;
  upsertSource de-dupes on id). EXIT=0.
- **Files:** +src/graph/repo.ts, +tests/graph/repo.test.ts.

### T3 — src/graph/merge.ts (TDD)
- **Status:** completed
- **RED:** `tests/graph/merge.test.ts` — 5 tests, import failed. RED
  verified.
- **GREEN:** `chooseWinningClaim(db, nodeId, field, cfg?)` implements
  ARCHITECTURE.md §4: (1) active override → all claims chosen=0 with
  rationale, return `{kind:"override", override}`; (2) pick by
  `extractor` precedence × confidence; (3) tie → every tied claim
  chosen=0 + confidence="conflicted" + rationale "tied at top rank"; (4)
  no claims → `{kind:"none"}`. `DEFAULT_PRECEDENCE` exported, ranks
  `openapi@3 > mcp-well-known > openref-cli > openref-sdk > llms-txt >
  docs`.
- **Tests:** 5 passed. EXIT=0.
- **Files:** +src/graph/merge.ts, +tests/graph/merge.test.ts.

### T4 — src/sources/store.ts (TDD)
- **Status:** completed
- **RED:** `tests/sources/store.test.ts` — 4 tests, import failed. RED
  verified.
- **GREEN:** `storeSource(db, sourcesDir, {url,bytes,content_type,surface})`
  hashes bytes (sha256), writes
  `<sourcesDir>/<sha256>.<ext>`, upserts `sources` row, returns
  `SourceNode`. Content-type → extension mapper (`extensionFor`) strips
  charset params and maps json/txt/md/yaml/xml/html/js/ts; unknown →
  `.bin`.
- **Tests:** 4 passed (path + id + one-row + different-bytes →
  different-id + extensionFor cases). EXIT=0.
- **Files:** +src/sources/store.ts, +tests/sources/store.test.ts.

### T5 — Phase 1 acceptance gate
- **Status:** completed
- **Command:** `npm run typecheck && npm test`
- **Result:**
  - typecheck EXIT=0
  - vitest 19 passed / 0 failed across 4 test files (db, repo, merge,
    sources/store). EXIT=0.
- **Tag target:** `sprint/P1-complete` (next step).
