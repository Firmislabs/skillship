// Qualitative skill scorer — 5-dimension deterministic rubric.
// No LLM calls. Pure functions per dimension + composite.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as Sqlite3Database } from 'better-sqlite3'
import { scoreCoverage, type ExpectedOp } from './scorers.js'

// ---- Types ---------------------------------------------------------

export interface QualitativeReport {
  readonly structure: number
  readonly density: number
  readonly freshness: number
  readonly schemaFidelity: number
  readonly coverage: number
  readonly composite: number
}

// ---- Weights (const) -----------------------------------------------

const WEIGHTS = {
  structure: 0.25,
  density: 0.15,
  freshness: 0.10,
  schemaFidelity: 0.20,
  coverage: 0.30,
} as const

// ---- Dimension 1: Structure ----------------------------------------
// Checklist on SKILL.md text.
// Valid frontmatter is a hard gate: if absent, score = 0.
// Required checks (5 after gating): name, description≥20, auth section,
// code fence, errors section. Score = passed/5. Bonus +0.1 for rate-limit info.

const REQUIRED_CHECKS_AFTER_GATE: ReadonlyArray<(t: string) => boolean> = [
  // 1. name: field in frontmatter
  (text: string): boolean => /^name:\s*\S/m.test(extractFrontmatter(text)),
  // 2. description ≥ 20 chars in frontmatter
  (text: string): boolean => {
    const desc = extractFrontmatterField(text, 'description')
    return desc !== null && desc.length >= 20
  },
  // 3. Auth section heading
  (text: string): boolean => /^##?\s+Auth(entication)?/im.test(text),
  // 4. At least one non-trivial code fence (≥ 10 chars between fences)
  (text: string): boolean => /```[^\n]*\n[\s\S]{10,}?```/.test(text),
  // 5. Errors section heading
  (text: string): boolean => /^##?\s+Errors?(\s+handling)?/im.test(text),
]

const BONUS_CHECK = (text: string): boolean =>
  /rate.?limit/i.test(text)

export function scoreStructure(skillMd: string): number {
  // Hard gate: no valid frontmatter block → 0
  if (!/^---\n[\s\S]*?\n---/.test(skillMd)) return 0
  const totalRequired = REQUIRED_CHECKS_AFTER_GATE.length
  const passed = REQUIRED_CHECKS_AFTER_GATE.filter(check => check(skillMd)).length
  const bonus = BONUS_CHECK(skillMd) ? 0.1 : 0
  const base = passed / totalRequired
  return Math.min(base + bonus, 1.1) // bonus can push above 1.0 (per spec)
}

// Check references/ directory: returns 1.0 if refs exist and count matches,
// 0 if refs dir missing or empty when ops > 0.
export function scoreStructureWithRefs(
  skillDir: string,
  opCount: number,
): number {
  if (opCount === 0) return 1.0
  const refsDir = join(skillDir, 'references')
  if (!existsSync(refsDir)) return 0
  const files = readdirSync(refsDir).filter(f => f.endsWith('.md'))
  if (files.length === 0) return 0
  return files.length >= opCount ? 1.0 : files.length / opCount
}

// ---- Dimension 2: Density ------------------------------------------
// Tokens ≈ bytes / 4 (GPT-style approximation: ~4 bytes per token on average).
// Ideal band [200, 2000] tokens/op → 1.0.
// Linear decay below 200 to 0 at 50 t/op.
// Linear decay above 2000 to 0 at 10000 t/op.
// Now includes per-op reference file bytes in the total.

const DENSITY_IDEAL_LOW = 200
const DENSITY_IDEAL_HIGH = 2000
const DENSITY_FLOOR = 50
const DENSITY_CEILING = 10000

export function scoreDensity(bytes: number, opCount: number): number {
  return scoreDensityWithRefs(bytes, 0, opCount)
}

// scoreDensityWithRefs: bytes = SKILL.md size, refBytes = total references/ size
export function scoreDensityWithRefs(
  bytes: number,
  refBytes: number,
  opCount: number,
): number {
  if (opCount === 0) return 0
  // bytes / 4 ≈ token count (documented: GPT-4 tokenizer averages ~4 bytes/token)
  const tokensPerOp = (bytes + refBytes) / 4 / opCount
  if (tokensPerOp < DENSITY_FLOOR) return 0
  if (tokensPerOp < DENSITY_IDEAL_LOW) {
    return (tokensPerOp - DENSITY_FLOOR) / (DENSITY_IDEAL_LOW - DENSITY_FLOOR)
  }
  if (tokensPerOp <= DENSITY_IDEAL_HIGH) return 1.0
  if (tokensPerOp >= DENSITY_CEILING) return 0
  return (DENSITY_CEILING - tokensPerOp) / (DENSITY_CEILING - DENSITY_IDEAL_HIGH)
}

// ---- Dimension 3: Freshness ----------------------------------------
// max(source.fetched_at) → 1.0 if ≤ 30 days old; linear decay to 0 at 365 days.

const FRESHNESS_FULL_DAYS = 30
const FRESHNESS_ZERO_DAYS = 365

export function scoreFreshness(
  fetchedAts: readonly string[],
  now: Date,
): number {
  if (fetchedAts.length === 0) return 0
  const maxMs = Math.max(...fetchedAts.map(ts => new Date(ts).getTime()))
  const ageDays = (now.getTime() - maxMs) / (1000 * 60 * 60 * 24)
  if (ageDays <= FRESHNESS_FULL_DAYS) return 1.0
  if (ageDays >= FRESHNESS_ZERO_DAYS) return 0
  return (
    (FRESHNESS_ZERO_DAYS - ageDays) /
    (FRESHNESS_ZERO_DAYS - FRESHNESS_FULL_DAYS)
  )
}

// ---- Dimension 4: Schema fidelity ----------------------------------
// Per op: check presence of 3 claim fields — params, request_body (body params),
// and responses. Per-op score = present/3. Dim score = mean across ops.
//
// Implementation detail: parameters are child nodes of kind='parameter'.
// request_body presence is inferred from parameter children with location='body'.
// responses are child nodes of kind='response_shape'.

export function scoreSchemaFidelity(
  db: Sqlite3Database,
  productId: string,
): number {
  const opIds = loadOperationIds(db, productId)
  if (opIds.length === 0) return 0
  const perOpScores = opIds.map(opId => scoreSingleOpFidelity(db, opId))
  const sum = perOpScores.reduce((a, b) => a + b, 0)
  return sum / perOpScores.length
}

// ---- Dimension 5: Structural coverage (delegates to existing scorer)

export function scoreQualitativeCoverage(
  db: Sqlite3Database,
  productId: string,
  expectedOps: readonly ExpectedOp[],
): number {
  return scoreCoverage(db, productId, expectedOps).hitRate
}

// ---- Composite -----------------------------------------------------

export function scoreComposite(
  report: Omit<QualitativeReport, 'composite'>,
): number {
  return (
    report.structure * WEIGHTS.structure +
    report.density * WEIGHTS.density +
    report.freshness * WEIGHTS.freshness +
    report.schemaFidelity * WEIGHTS.schemaFidelity +
    report.coverage * WEIGHTS.coverage
  )
}

// ---- Full scorer (DB + skillDir + expectedOps) ---------------------

export function scoreQualitative(
  db: Sqlite3Database,
  productId: string,
  skillMd: string,
  skillMdBytes: number,
  expectedOps: readonly ExpectedOp[],
  now?: Date,
  skillDir?: string,
): QualitativeReport {
  const structure = scoreStructure(skillMd)
  const opCount = countOperations(db, productId)
  const refBytes = skillDir !== undefined ? measureRefBytes(skillDir, opCount) : 0
  const density = scoreDensityWithRefs(skillMdBytes, refBytes, opCount)
  const fetchedAts = loadFetchedAts(db, productId)
  const freshness = scoreFreshness(fetchedAts, now ?? new Date())
  const schemaFidelity = scoreSchemaFidelity(db, productId)
  const coverage = scoreQualitativeCoverage(db, productId, expectedOps)
  const partial = { structure, density, freshness, schemaFidelity, coverage }
  return { ...partial, composite: scoreComposite(partial) }
}

// ---- Internal helpers ----------------------------------------------

function extractFrontmatter(text: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  return match?.[1] ?? ''
}

function extractFrontmatterField(
  text: string,
  field: string,
): string | null {
  const fm = extractFrontmatter(text)
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(fm)
  return match?.[1]?.trim() ?? null
}

function loadOperationIds(
  db: Sqlite3Database,
  productId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT n.id
         FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
        WHERE n.kind = 'operation' AND s.parent_id = ?`,
    )
    .all(productId) as { id: string }[]
  return rows.map(r => r.id)
}

function countOperations(
  db: Sqlite3Database,
  productId: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT n.id) AS cnt
         FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
        WHERE n.kind = 'operation' AND s.parent_id = ?`,
    )
    .get(productId) as { cnt: number }
  return row.cnt
}

function measureRefBytes(skillDir: string, opCount: number): number {
  if (opCount === 0) return 0
  const refsDir = join(skillDir, 'references')
  if (!existsSync(refsDir)) return 0
  const files = readdirSync(refsDir).filter(f => f.endsWith('.md'))
  return files.reduce((sum, f) => {
    try {
      return sum + statSync(join(refsDir, f)).size
    } catch {
      return sum
    }
  }, 0)
}

function scoreSingleOpFidelity(
  db: Sqlite3Database,
  opId: string,
): number {
  // 1. Has any parameters (query, path, header, etc.)
  const paramCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM nodes
          WHERE kind = 'parameter' AND parent_id = ?`,
      )
      .get(opId) as { cnt: number }
  ).cnt

  // 2. Has body parameters (request_body proxy)
  const bodyCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM nodes n
          JOIN claims c ON c.node_id = n.id AND c.field = 'location'
         WHERE n.kind = 'parameter' AND n.parent_id = ?
           AND c.value_json = '"body"'`,
      )
      .get(opId) as { cnt: number }
  ).cnt

  // 3. Has response shapes
  const responseCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM nodes
          WHERE kind = 'response_shape' AND parent_id = ?`,
      )
      .get(opId) as { cnt: number }
  ).cnt

  const present =
    (paramCount > 0 ? 1 : 0) +
    (bodyCount > 0 ? 1 : 0) +
    (responseCount > 0 ? 1 : 0)
  return present / 3
}

function loadFetchedAts(
  db: Sqlite3Database,
  productId: string,
): string[] {
  // Join through: sources that contributed claims to nodes under this product.
  // We use the claims table to find source_ids used by this product's nodes.
  const rows = db
    .prepare(
      `SELECT DISTINCT s.fetched_at
         FROM sources s
         JOIN claims c ON c.source_id = s.id
         JOIN nodes n ON n.id = c.node_id
        WHERE n.parent_id = ?
           OR n.id = ?
           OR n.parent_id IN (
             SELECT id FROM nodes WHERE parent_id = ?
           )`,
    )
    .all(productId, productId, productId) as { fetched_at: string }[]
  return rows.map(r => r.fetched_at)
}
