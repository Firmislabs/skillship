// qualitativeExternal.ts — scores SKILL.md files without a SQLite graph.
// Used for head-to-head comparison against hand-authored external skills.
// No LLM calls. Pure deterministic functions.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  scoreStructure,
  scoreDensityWithRefs,
  scoreFreshness,
} from './qualitative.js'
import type { QualitativeReport } from './qualitative.js'

// ---- External report type (coverage = -1 sentinel = N/A) -----------

export type ExternalQualitativeReport = QualitativeReport

// ---- Weights (4 dims — coverage excluded) --------------------------

const EXTERNAL_WEIGHTS = {
  structure: 0.25 / 0.7,      // 0.357
  density: 0.15 / 0.7,        // 0.214
  freshness: 0.10 / 0.7,      // 0.143
  schemaFidelity: 0.20 / 0.7, // 0.286
} as const

// ---- Op count heuristics ------------------------------------------

// HTTP op pattern: backtick METHOD /path
const HTTP_OP_RE = /^-\s*`[A-Z]+\s+\//gm

// Heading pattern for op-like H2 headings
const H2_RE = /^##\s+\S/gm

/**
 * Count operations in an external skill.
 * Priority: HTTP op lines in SKILL.md > references/ file count > H2 headings.
 * Minimum 1 to avoid divide-by-zero.
 */
export function countExternalOps(
  skillMd: string,
  refFileCount: number,
): number {
  const httpMatches = skillMd.match(HTTP_OP_RE) ?? []
  const httpCount = httpMatches.length
  const candidate = Math.max(httpCount, refFileCount)
  if (candidate > 0) return candidate
  // Fall back: count H2 headings as proxy for ops
  const h2Matches = skillMd.match(H2_RE) ?? []
  return Math.max(h2Matches.length, 1)
}

// ---- Dimension 1: Structure ----------------------------------------

/**
 * Score SKILL.md structure for an external skill directory.
 * Returns 0 if SKILL.md is missing. Delegates to shared scoreStructure.
 */
export function scoreExternalStructure(skillDir: string): number {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return 0
  const skillMd = safeReadUtf8(skillMdPath)
  return scoreStructure(skillMd)
}

// ---- Dimension 2: Density ------------------------------------------

/**
 * Score density for an external skill directory.
 * Reads SKILL.md bytes + references/ bytes, derives op count via heuristics.
 */
export function scoreExternalDensity(skillDir: string): number {
  const skillMdPath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillMdPath)) return 0
  const skillMd = safeReadUtf8(skillMdPath)
  const skillMdBytes = Buffer.byteLength(skillMd, 'utf8')
  const { refBytes, refFileCount } = measureRefs(skillDir)
  const opCount = countExternalOps(skillMd, refFileCount)
  return scoreDensityWithRefs(skillMdBytes, refBytes, opCount)
}

// ---- Dimension 3: Freshness ----------------------------------------

/**
 * Score freshness using git log on the skill directory.
 * Falls back to 0 if the directory is not inside a git repo.
 */
export function scoreExternalFreshness(
  skillDir: string,
  now: Date,
): number {
  const commitTs = gitLastCommitUnixSeconds(skillDir)
  if (commitTs === null) return 0
  const isoTs = new Date(commitTs * 1000).toISOString()
  return scoreFreshness([isoTs], now)
}

// ---- Dimension 4: Schema fidelity ----------------------------------

// Section headings that indicate a well-formed per-op reference
const PARAMETERS_RE = /^##\s+Parameters?/im
const RESPONSES_RE = /^##\s+Responses?/im

/**
 * Score schema fidelity by inspecting references/ .md files.
 * Per-file score = sections present (Parameters, Responses) / 2.
 * Returns 0 if no references/ dir or no .md files.
 */
export function scoreExternalSchemaFidelity(skillDir: string): number {
  const refsDir = join(skillDir, 'references')
  if (!existsSync(refsDir)) return 0
  const files = readdirSync(refsDir).filter(f => f.endsWith('.md'))
  if (files.length === 0) return 0
  const perFileScores = files.map(f => scoreSingleRefFidelity(join(refsDir, f)))
  const sum = perFileScores.reduce((a, b) => a + b, 0)
  return sum / perFileScores.length
}

// ---- Composite (4-dim, coverage excluded) --------------------------

function computeExternalComposite(
  structure: number,
  density: number,
  freshness: number,
  schemaFidelity: number,
): number {
  return (
    structure * EXTERNAL_WEIGHTS.structure +
    density * EXTERNAL_WEIGHTS.density +
    freshness * EXTERNAL_WEIGHTS.freshness +
    schemaFidelity * EXTERNAL_WEIGHTS.schemaFidelity
  )
}

// ---- Full external scorer ------------------------------------------

/**
 * Score an external skill directory on 4 dimensions.
 * Coverage is set to -1 (N/A sentinel) since there are no expected_ops.
 * Composite reweights the 4 active dimensions proportionally.
 */
export function scoreExternalSkill(
  skillDir: string,
  now?: Date,
): ExternalQualitativeReport {
  const effectiveNow = now ?? new Date()
  const structure = scoreExternalStructure(skillDir)
  const density = scoreExternalDensity(skillDir)
  const freshness = scoreExternalFreshness(skillDir, effectiveNow)
  const schemaFidelity = scoreExternalSchemaFidelity(skillDir)
  const composite = computeExternalComposite(
    structure,
    density,
    freshness,
    schemaFidelity,
  )
  return {
    structure,
    density,
    freshness,
    schemaFidelity,
    coverage: -1,
    composite,
  }
}

// ---- Internal helpers ----------------------------------------------

function safeReadUtf8(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

interface RefMeasurement {
  readonly refBytes: number
  readonly refFileCount: number
}

function measureRefs(skillDir: string): RefMeasurement {
  const refsDir = join(skillDir, 'references')
  if (!existsSync(refsDir)) return { refBytes: 0, refFileCount: 0 }
  const files = readdirSync(refsDir).filter(f => f.endsWith('.md'))
  const refBytes = files.reduce((sum, f) => {
    try {
      return sum + statSync(join(refsDir, f)).size
    } catch {
      return sum
    }
  }, 0)
  return { refBytes, refFileCount: files.length }
}

function gitLastCommitUnixSeconds(skillDir: string): number | null {
  try {
    const stdout = execFileSync(
      'git',
      ['log', '-1', '--format=%ct', '--', skillDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (stdout === '') return null
    const ts = parseInt(stdout, 10)
    return isNaN(ts) ? null : ts
  } catch {
    return null
  }
}

function scoreSingleRefFidelity(refFilePath: string): number {
  const content = safeReadUtf8(refFilePath)
  const hasParams = PARAMETERS_RE.test(content)
  const hasResponses = RESPONSES_RE.test(content)
  return ((hasParams ? 1 : 0) + (hasResponses ? 1 : 0)) / 2
}
