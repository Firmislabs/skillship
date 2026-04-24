#!/usr/bin/env node
// compare.ts — Head-to-head comparison: our generated skills vs external hand-authored skills.
// Fetches external SKILL.md files (idempotent), scores all, prints a table.
// No LLM calls. Deterministic scoring only.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  scoreQualitative,
  scoreStructure,
} from './qualitative.js'
import { scoreExternalSkill } from './qualitativeExternal.js'
import type { QualitativeReport } from './qualitative.js'

// ---- Constants ---------------------------------------------------

const ROOT = process.cwd()
const EVAL_DIR = join(ROOT, 'eval')
const EXTERNAL_DIR = join(EVAL_DIR, 'external')
const PROJECTS_DIR = join(EVAL_DIR, 'projects')

// External skills to fetch: slug → { repo, path within repo }
// Note: linear and github external_plugins do NOT contain SKILL.md files.
// discord and mcp-server-dev are the best available official external skills.
interface ExternalSkillSpec {
  readonly slug: string
  readonly repo: string
  readonly pathInRepo: string
  readonly note: string
}

const EXTERNAL_SKILLS: readonly ExternalSkillSpec[] = [
  // Vendor-API skills with matching slugs to our generated skills.
  {
    slug: 'stripe',
    repo: 'majiayu000/claude-skill-registry',
    pathInRepo: 'skills/other/other/stripe',
    note: 'Hand-authored stripe integration skill (community registry)',
  },
  {
    slug: 'supabase',
    repo: 'majiayu000/claude-skill-registry',
    pathInRepo: 'skills/data/supabase-rest',
    note: 'Hand-authored supabase REST skill (community registry)',
  },
  {
    slug: 'vercel',
    repo: 'majiayu000/claude-skill-registry',
    pathInRepo: 'skills/data/vercel-github-actions',
    note: 'Hand-authored vercel skill (community registry)',
  },
  {
    slug: 'linear',
    repo: 'majiayu000/claude-skill-registry',
    pathInRepo: 'skills/other/other/linear-claude-skill',
    note: 'Hand-authored linear skill (community registry)',
  },
  {
    slug: 'gitea',
    repo: 'majiayu000/claude-skill-registry',
    pathInRepo: 'skills/data/gitea-tea',
    note: 'Hand-authored gitea skill (community registry)',
  },
  {
    slug: 'posthog',
    repo: 'davepoon/buildwithclaude',
    pathInRepo: 'plugins/all-skills/skills/posthog-automation',
    note: 'Hand-authored posthog automation skill (community plugin)',
  },
  // Reference baselines: high-quality official Anthropic skills (not
  // vendor-API skills — kept for context on hand-authored ceiling).
  {
    slug: 'discord-access',
    repo: 'anthropics/claude-plugins-official',
    pathInRepo: 'external_plugins/discord/skills/access',
    note: '[reference] Official discord access skill (workflow, not API)',
  },
  {
    slug: 'mcp-server',
    repo: 'anthropics/claude-plugins-official',
    pathInRepo: 'plugins/mcp-server-dev/skills/build-mcp-server',
    note: '[reference] Official mcp-server-dev skill',
  },
  {
    slug: 'claude-code-setup',
    repo: 'anthropics/claude-plugins-official',
    pathInRepo: 'plugins/claude-code-setup/skills/claude-automation-recommender',
    note: '[reference] Official claude-code-setup skill',
  },
]

// Our vendors to score (must have projects/<slug> with dist/skills/ output)
const OUR_VENDORS: readonly string[] = [
  'stripe',
  'supabase',
  'vercel',
  'linear',
  'gitea',
  'posthog',
]

// ---- Fetch external skills -----------------------------------------

function fetchExternalSkill(spec: ExternalSkillSpec): void {
  const destDir = join(EXTERNAL_DIR, spec.slug)
  if (existsSync(join(destDir, 'SKILL.md'))) {
    process.stdout.write(`  [cache] ${spec.slug}: already fetched\n`)
    return
  }
  mkdirSync(destDir, { recursive: true })
  process.stdout.write(`  [fetch] ${spec.slug}: ${spec.repo}/${spec.pathInRepo}\n`)
  fetchSkillMd(spec.repo, spec.pathInRepo, destDir)
  fetchRefsDir(spec.repo, spec.pathInRepo, destDir)
}

function fetchSkillMd(repo: string, pathInRepo: string, destDir: string): void {
  const raw = ghApiGetContent(repo, `${pathInRepo}/SKILL.md`)
  if (raw === null) {
    process.stderr.write(`    [warn] SKILL.md not found at ${pathInRepo}/SKILL.md\n`)
    return
  }
  writeFileSync(join(destDir, 'SKILL.md'), raw, 'utf8')
}

function fetchRefsDir(repo: string, pathInRepo: string, destDir: string): void {
  const refsPath = `${pathInRepo}/references`
  const listing = ghApiListDir(repo, refsPath)
  if (listing === null) return
  const refsDestDir = join(destDir, 'references')
  mkdirSync(refsDestDir, { recursive: true })
  for (const file of listing) {
    if (!file.endsWith('.md')) continue
    const content = ghApiGetContent(repo, `${refsPath}/${file}`)
    if (content !== null) {
      writeFileSync(join(refsDestDir, file), content, 'utf8')
    }
  }
}

function ghApiGetContent(repo: string, path: string): string | null {
  try {
    const result = spawnSync(
      'gh',
      ['api', `repos/${repo}/contents/${path}`, '--jq', '.content'],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) return null
    const b64 = result.stdout.trim()
    if (b64 === '' || b64 === 'null') return null
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch {
    return null
  }
}

function ghApiListDir(repo: string, path: string): string[] | null {
  try {
    const result = spawnSync(
      'gh',
      ['api', `repos/${repo}/contents/${path}`, '--jq', '.[].name'],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) return null
    const lines = result.stdout.trim().split('\n').filter(l => l.length > 0)
    return lines
  } catch {
    return null
  }
}

// ---- Score our vendor skill ----------------------------------------

interface OurScore {
  readonly vendor: string
  readonly report: QualitativeReport | null
  readonly reason?: string | null
}

function scoreOurVendor(slug: string): OurScore {
  const projectDir = join(PROJECTS_DIR, slug)
  const distDir = join(projectDir, 'dist')
  const skDir = join(projectDir, '.skillship')
  if (!existsSync(join(skDir, 'graph.sqlite'))) {
    return {
      vendor: slug,
      report: null,
      reason: `graph.sqlite not found — run: skillship init + build for ${slug}`,
    }
  }
  const skillDir = resolveSkillDir(distDir)
  if (skillDir === null) {
    return { vendor: slug, report: null, reason: 'no dist/skills/ output found' }
  }
  const db = new Database(join(skDir, 'graph.sqlite'))
  try {
    const productId = resolveProductId(db)
    if (productId === null) {
      return { vendor: slug, report: null, reason: 'no product node in graph' }
    }
    const skillMdPath = join(skillDir, 'SKILL.md')
    const skillMd = existsSync(skillMdPath)
      ? readFileSync(skillMdPath, 'utf8')
      : ''
    const skillMdBytes = Buffer.byteLength(skillMd, 'utf8')
    const report = scoreQualitative(
      db,
      productId,
      skillMd,
      skillMdBytes,
      [],
      new Date(),
      skillDir,
    )
    return { vendor: slug, report }
  } finally {
    db.close()
  }
}

function resolveSkillDir(distDir: string): string | null {
  if (!existsSync(distDir)) return null
  const dirs = readdirSync(distDir)
  const first = dirs[0]
  return first !== undefined ? join(distDir, first) : null
}

function resolveProductId(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT id FROM nodes WHERE kind = 'product' LIMIT 1`)
    .get() as { id: string } | undefined
  return row?.id ?? null
}

// ---- Score note about linear/github/figma --------------------------

function printExternalNote(): void {
  process.stdout.write('\nNote: hand-authored vendor-API skills sourced from community\n')
  process.stdout.write('registries (majiayu000/claude-skill-registry, davepoon/buildwithclaude).\n')
  process.stdout.write('These are integration-pattern skills, not API operation catalogs —\n')
  process.stdout.write('different shape from ours. Three Anthropic official skills kept as\n')
  process.stdout.write('reference baselines (workflow / dev tooling skills).\n\n')
}

// ---- Table rendering -----------------------------------------------

interface CompareRow {
  readonly vendor: string
  readonly ours: QualitativeReport | null
  readonly ourNote: string | null
  readonly theirs: QualitativeReport | null
  readonly theirNote: string | null
  readonly theirSlug: string
}

function buildRows(): CompareRow[] {
  const rows: CompareRow[] = []
  // Our vendors vs the first available external skill as comparison reference
  const externalDirs = EXTERNAL_SKILLS.map(spec => ({
    slug: spec.slug,
    dir: join(EXTERNAL_DIR, spec.slug),
  }))
  for (const vendor of OUR_VENDORS) {
    const ourScore = scoreOurVendor(vendor)
    // Match against the external skill with the same slug if available, else first
    const matchedExternal =
      externalDirs.find(e => e.slug === vendor) ?? externalDirs[0]
    const theirReport =
      matchedExternal && existsSync(join(matchedExternal.dir, 'SKILL.md'))
        ? scoreExternalSkill(matchedExternal.dir)
        : null
    rows.push({
      vendor,
      ours: ourScore.report,
      ourNote: ourScore.reason ?? null,
      theirs: theirReport,
      theirNote: theirReport === null ? 'not fetched' : null,
      theirSlug: matchedExternal?.slug ?? 'n/a',
    })
  }
  // Also score each external skill standalone for reference
  for (const spec of EXTERNAL_SKILLS) {
    const dir = join(EXTERNAL_DIR, spec.slug)
    const theirReport = existsSync(join(dir, 'SKILL.md'))
      ? scoreExternalSkill(dir)
      : null
    rows.push({
      vendor: `[ext] ${spec.slug}`,
      ours: null,
      ourNote: 'n/a — external skill only',
      theirs: theirReport,
      theirNote: theirReport === null ? 'not fetched' : spec.note,
      theirSlug: spec.slug,
    })
  }
  return rows
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '  —  '
  if (n === -1) return '  —  '
  return `${(n * 100).toFixed(0).padStart(3)}% `
}

function printTable(rows: CompareRow[]): void {
  const header =
    'vendor                    | our_comp | ext_comp | our_str | ext_str | our_den | ext_den | our_frsh | ext_frsh | our_sch | ext_sch'
  const sep =
    '--------------------------|----------|----------|---------|---------|---------|---------|----------|----------|---------|--------'
  process.stdout.write('\n')
  process.stdout.write(`${header}\n`)
  process.stdout.write(`${sep}\n`)
  for (const row of rows) {
    const v = row.vendor.padEnd(26)
    const oc = fmt(row.ours?.composite)
    const tc = fmt(row.theirs?.composite)
    const os = fmt(row.ours?.structure)
    const ts = fmt(row.theirs?.structure)
    const od = fmt(row.ours?.density)
    const td = fmt(row.theirs?.density)
    const of_ = fmt(row.ours?.freshness)
    const tf = fmt(row.theirs?.freshness)
    const osc = fmt(row.ours?.schemaFidelity)
    const tsc = fmt(row.theirs?.schemaFidelity)
    process.stdout.write(
      `${v}| ${oc}   | ${tc}   | ${os}  | ${ts}  | ${od}  | ${td}  | ${of_}   | ${tf}   | ${osc}  | ${tsc}\n`,
    )
    if (row.ourNote !== null) {
      process.stdout.write(`  -> ours: ${row.ourNote}\n`)
    }
    if (row.theirNote !== null) {
      process.stdout.write(`  -> theirs (${row.theirSlug}): ${row.theirNote}\n`)
    }
  }
  process.stdout.write('\n')
}

// ---- Also score our linear against itself for structure check ------

function printLinearStructureSpotCheck(): void {
  const linearSkillMdPath = join(
    PROJECTS_DIR,
    'linear',
    'dist',
    'skills',
    'linear-app',
    'SKILL.md',
  )
  if (!existsSync(linearSkillMdPath)) return
  const md = readFileSync(linearSkillMdPath, 'utf8')
  const structScore = scoreStructure(md)
  process.stdout.write(`Spot check — our linear SKILL.md structure score: ${(structScore * 100).toFixed(0)}%\n`)
  const hasAuth = /^##?\s+Auth/im.test(md)
  const hasErrors = /^##?\s+Errors?/im.test(md)
  const hasRateLimit = /rate.?limit/i.test(md)
  process.stdout.write(`  Auth section: ${hasAuth ? 'yes' : 'NO'}\n`)
  process.stdout.write(`  Errors section: ${hasErrors ? 'yes' : 'NO'}\n`)
  process.stdout.write(`  Rate-limit mention: ${hasRateLimit ? 'yes' : 'NO'}\n`)
  process.stdout.write('\n')
}

// ---- Main ----------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write('eval/compare: fetching external skills...\n')
  mkdirSync(EXTERNAL_DIR, { recursive: true })
  for (const spec of EXTERNAL_SKILLS) {
    fetchExternalSkill(spec)
  }
  printExternalNote()
  printLinearStructureSpotCheck()
  process.stdout.write('Scoring all skills...\n')
  const rows = buildRows()
  printTable(rows)
}

// ---- Entry point ---------------------------------------------------

const entryHref = import.meta.url
const invokedAs = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).href
  : ''
if (entryHref === invokedAs) {
  main().catch((err: unknown) => {
    const msg =
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`eval/compare: ${msg}\n`)
    process.exit(1)
  })
}

export { fetchExternalSkill, scoreOurVendor }
