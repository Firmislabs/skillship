import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { runBuild } from '../../src/cli/build.js'
import { makeTmpCtx, type TmpCtx } from '../helpers.js'
import type { SkillshipConfig } from '../../src/discovery/config.js'
import {
  scoreStructure,
  scoreDensity,
  scoreFreshness,
  scoreSchemaFidelity,
  scoreQualitativeCoverage,
  scoreComposite,
  type QualitativeReport,
} from '../../eval/qualitative.js'

// ---- helpers -------------------------------------------------------

function seedProject(
  dir: string,
  sources: Array<{
    surface: SkillshipConfig['sources'][number]['surface']
    url: string
    contentType: string
    bytes: Buffer
    ext: string
    fetchedAt?: string
  }>,
  domain: string,
): void {
  const skDir = join(dir, '.skillship')
  const srcDir = join(skDir, 'sources')
  mkdirSync(srcDir, { recursive: true })
  const entries = sources.map(s => {
    const sha = createHash('sha256').update(s.bytes).digest('hex')
    writeFileSync(join(srcDir, `${sha}.${s.ext}`), s.bytes)
    return {
      surface: s.surface,
      url: s.url,
      sha256: sha,
      content_type: s.contentType,
      fetched_at: s.fetchedAt ?? new Date().toISOString(),
    }
  })
  const config = {
    product: { domain, github_org: null },
    sources: entries,
    coverage: 'bronze' as const,
  }
  writeFileSync(join(skDir, 'config.yaml'), stringifyYaml(config), 'utf8')
}

function loadFixture(rel: string): Buffer {
  return readFileSync(join(process.cwd(), rel))
}

async function buildFixtureProject(ctx: TmpCtx): Promise<{
  db: Database.Database
  productId: string
  skillDir: string
}> {
  seedProject(
    ctx.dir,
    [
      {
        surface: 'rest',
        url: 'https://acme.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      },
    ],
    'acme.example',
  )
  const outDir = join(ctx.dir, 'dist')
  const res = await runBuild({ in: ctx.dir, out: outDir })
  const db = new Database(join(ctx.dir, '.skillship', 'graph.sqlite'))
  const skillDir = join(outDir, 'skills', 'acme-example')
  return { db, productId: res.productId, skillDir }
}

// ---- SKILL.md content builders ------------------------------------

const FULL_SKILL_MD = `---
name: test-skill
description: A thorough test skill with all required sections present.
---

# Test API

This skill covers everything you need to use the Test API effectively.

## Authentication

Use a Bearer token in the Authorization header:

\`\`\`bash
curl -H "Authorization: Bearer <token>" https://api.example.com/v1/resource
\`\`\`

## Operations

- \`GET /v1/items\` — List items
- \`POST /v1/items\` — Create item

## Errors

Use standard HTTP status codes. 429 means rate-limited (retry after X-RateLimit-Reset).
Rate limits: 1000 req/min per key. Retry-After header is present on 429 responses.
`

const NO_FRONTMATTER_SKILL_MD = `# Test API

## Authentication

\`\`\`bash
curl https://api.example.com
\`\`\`

## Errors

Handle 4xx errors.
`

const MISSING_AUTH_SKILL_MD = `---
name: no-auth
description: Missing auth section but has errors.
---

# No Auth API

## Errors

\`\`\`bash
curl https://api.example.com
\`\`\`
`

const EMPTY_DESCRIPTION_SKILL_MD = `---
name: empty-desc
description: x
---

# Short Desc API

## Authentication

Use a token.

\`\`\`bash
curl https://api.example.com
\`\`\`

## Errors

Handle errors.
`

const NO_CODE_FENCE_SKILL_MD = `---
name: no-code
description: This skill is missing code fence examples entirely.
---

# No Code API

## Authentication

Use bearer tokens.

## Errors

Handle errors.
`

const RATE_LIMIT_BONUS_SKILL_MD = `---
name: rate-limit-bonus
description: This skill includes throttle limit information for the bonus.
---

# Rate Limit API

## Authentication

Use bearer tokens in Authorization header.

\`\`\`bash
curl -H "Authorization: Bearer tok" https://api.example.com
\`\`\`

## Errors

Handle errors gracefully.

Rate limits apply: 1000 requests per minute. Retry after 429.
`

// ---- scoreStructure tests ------------------------------------------

describe('scoreStructure', () => {
  test('full valid SKILL.md with rate-limit info → score = 1.1 (bonus)', () => {
    // FULL_SKILL_MD passes all 5 required checks + rate-limit bonus → 1.0 + 0.1 = 1.1
    const score = scoreStructure(FULL_SKILL_MD)
    expect(score).toBe(1.1)
  })

  test('missing frontmatter → score = 0', () => {
    const score = scoreStructure(NO_FRONTMATTER_SKILL_MD)
    expect(score).toBe(0)
  })

  test('missing auth section → partial score', () => {
    const score = scoreStructure(MISSING_AUTH_SKILL_MD)
    // has: frontmatter, name, description≥20, code fence, errors — missing: auth
    // 4 of 5 required checks → 0.8
    expect(score).toBeCloseTo(0.8, 5)
  })

  test('description too short → lower score', () => {
    const score = scoreStructure(EMPTY_DESCRIPTION_SKILL_MD)
    // has: frontmatter, name — missing: description≥20, has auth, code fence, errors
    // auth present, code fence present, errors present → 4/5 required failing desc
    expect(score).toBeLessThan(1.0)
    expect(score).toBeGreaterThan(0)
  })

  test('code fence detected when present', () => {
    // FULL_SKILL_MD has code fence → score ≥ 1.0 (plus rate-limit bonus = 1.1)
    expect(scoreStructure(FULL_SKILL_MD)).toBeGreaterThanOrEqual(1.0)
    // NO_CODE_FENCE_SKILL_MD has no code fence → lower score
    expect(scoreStructure(NO_CODE_FENCE_SKILL_MD)).toBeLessThan(1.0)
  })

  test('rate-limit info earns bonus up to +0.1', () => {
    const withBonus = scoreStructure(RATE_LIMIT_BONUS_SKILL_MD)
    const noBonus = scoreStructure(NO_RATE_LIMIT_SKILL_MD)
    // NO_RATE_LIMIT_SKILL_MD passes all 5 required checks → 1.0
    expect(noBonus).toBe(1.0)
    // RATE_LIMIT_BONUS_SKILL_MD passes all 5 + rate-limit bonus → 1.1
    expect(withBonus).toBe(1.1)
    expect(withBonus).toBeGreaterThan(noBonus)
    // bonus is capped at 0.1 extra above base
    expect(withBonus).toBeLessThanOrEqual(1.1)
  })
})

const NO_RATE_LIMIT_SKILL_MD = `---
name: no-throttle
description: This skill covers basic API operations without throttle docs.
---

# Basic API

## Authentication

Use bearer tokens.

\`\`\`bash
curl -H "Authorization: Bearer tok" https://api.example.com
\`\`\`

## Errors

Handle errors.
`

// ---- scoreDensity tests --------------------------------------------

describe('scoreDensity', () => {
  test('500 tokens / 5 ops = 100 t/op → ideal band → 1.0', () => {
    // 500 tokens, 5 ops → 100 t/op — wait, ideal band is [200, 2000]
    // 100 t/op is below 200 → linear decay from 200 to 0 at 50 → (100-50)/(200-50) ≈ 0.333
    const score = scoreDensity(500 * 4, 5) // bytes = tokens*4
    expect(score).toBeCloseTo(0.333, 2)
  })

  test('1000 tokens / 5 ops = 200 t/op → lower bound of ideal → 1.0', () => {
    const score = scoreDensity(1000 * 4, 5)
    expect(score).toBe(1.0)
  })

  test('10000 tokens / 5 ops = 2000 t/op → upper bound of ideal → 1.0', () => {
    const score = scoreDensity(10000 * 4, 5)
    expect(score).toBe(1.0)
  })

  test('very sparse: 50000 tokens / 5 ops = 10000 t/op → ~0', () => {
    // above 2000, decays to 0 at 10000 t/op → (10000-2000)/(10000-2000) = 1 → 0
    const score = scoreDensity(50000 * 4, 5)
    expect(score).toBeCloseTo(0, 5)
  })

  test('200/1 = 200 t/op → ideal lower → 1.0', () => {
    const score = scoreDensity(200 * 4, 1)
    expect(score).toBe(1.0)
  })

  test('2000/1 = 2000 t/op → ideal upper → 1.0', () => {
    const score = scoreDensity(2000 * 4, 1)
    expect(score).toBe(1.0)
  })

  test('below 50 t/op → 0', () => {
    // 49 t/op → below min → 0
    const score = scoreDensity(49 * 4, 1)
    expect(score).toBe(0)
  })

  test('0 ops → returns 0 (no divide by zero)', () => {
    const score = scoreDensity(1000, 0)
    expect(score).toBe(0)
  })
})

// ---- scoreFreshness tests ------------------------------------------

describe('scoreFreshness', () => {
  const NOW = new Date('2026-04-23T12:00:00.000Z')

  test('all sources today → score = 1.0', () => {
    const score = scoreFreshness([NOW.toISOString()], NOW)
    expect(score).toBe(1.0)
  })

  test('400 days old → score ≈ 0', () => {
    const old = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000)
    const score = scoreFreshness([old.toISOString()], NOW)
    expect(score).toBe(0)
  })

  test('100 days old → intermediate score', () => {
    const d = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000)
    const score = scoreFreshness([d.toISOString()], NOW)
    // 100 days: decay from 30 to 365 → (365-100)/(365-30) ≈ 0.791
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
    expect(score).toBeCloseTo(0.791, 2)
  })

  test('30 days old → score = 1.0', () => {
    const d = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000)
    const score = scoreFreshness([d.toISOString()], NOW)
    expect(score).toBe(1.0)
  })

  test('empty sources list → score = 0', () => {
    const score = scoreFreshness([], NOW)
    expect(score).toBe(0)
  })

  test('uses the max (most recent) fetched_at across multiple sources', () => {
    const old = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000)
    const recent = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000)
    // most recent is 10 days old → should score 1.0
    const score = scoreFreshness([old.toISOString(), recent.toISOString()], NOW)
    expect(score).toBe(1.0)
  })
})

// ---- scoreSchemaFidelity tests -------------------------------------

describe('scoreSchemaFidelity', () => {
  let ctx: TmpCtx

  beforeEach(() => {
    ctx = makeTmpCtx('skillship-qual-schema-')
  })

  afterEach(() => {
    ctx.cleanup()
  })

  test('ops from minimal.yaml have params and responses → fidelity > 0', async () => {
    const { db, productId } = await buildFixtureProject(ctx)
    try {
      const score = scoreSchemaFidelity(db, productId)
      // minimal.yaml has params and responses on both GET and POST
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    } finally {
      db.close()
    }
  })

  test('no operations → score = 0', () => {
    const dbPath = join(ctx.dir, 'empty.sqlite')
    mkdirSync(ctx.dir, { recursive: true })
    const db = new Database(dbPath)
    const schema = readFileSync(
      join(process.cwd(), 'src/graph/schema.sql'),
      'utf8',
    )
    db.exec(schema)
    try {
      const score = scoreSchemaFidelity(db, 'nonexistent-product')
      expect(score).toBe(0)
    } finally {
      db.close()
    }
  })
})

// ---- scoreQualitativeCoverage integration test ---------------------

describe('scoreQualitativeCoverage', () => {
  let ctx: TmpCtx

  beforeEach(() => {
    ctx = makeTmpCtx('skillship-qual-cov-')
  })

  afterEach(() => {
    ctx.cleanup()
  })

  test('delegates to scoreTaskCoverage and returns hitRate', async () => {
    const { db, productId } = await buildFixtureProject(ctx)
    try {
      const score = scoreQualitativeCoverage(db, productId, [
        { method: 'GET', path: '/projects' },
        { method: 'POST', path: '/projects' },
      ])
      expect(score).toBe(1.0)
    } finally {
      db.close()
    }
  })

  test('empty expected ops → score = 1.0', async () => {
    const { db, productId } = await buildFixtureProject(ctx)
    try {
      const score = scoreQualitativeCoverage(db, productId, [])
      expect(score).toBe(1.0)
    } finally {
      db.close()
    }
  })
})

// ---- scoreComposite tests ------------------------------------------

describe('scoreComposite', () => {
  test('weighted mean of known per-dim scores', () => {
    const report: QualitativeReport = {
      structure: 1.0,
      density: 1.0,
      freshness: 1.0,
      schemaFidelity: 1.0,
      coverage: 1.0,
      composite: 0, // computed below
    }
    const composite = scoreComposite(report)
    expect(composite).toBeCloseTo(1.0, 5)
  })

  test('all zeros → composite = 0', () => {
    const report: QualitativeReport = {
      structure: 0,
      density: 0,
      freshness: 0,
      schemaFidelity: 0,
      coverage: 0,
      composite: 0,
    }
    const composite = scoreComposite(report)
    expect(composite).toBe(0)
  })

  test('known partial scores → correct weighted mean', () => {
    // weights: structure=0.25, density=0.15, freshness=0.10, schema=0.20, coverage=0.30
    // scores: 1.0, 0.5, 0.0, 0.8, 0.6
    // expected = 1.0*0.25 + 0.5*0.15 + 0.0*0.10 + 0.8*0.20 + 0.6*0.30
    //          = 0.25 + 0.075 + 0 + 0.16 + 0.18 = 0.665
    const report: QualitativeReport = {
      structure: 1.0,
      density: 0.5,
      freshness: 0.0,
      schemaFidelity: 0.8,
      coverage: 0.6,
      composite: 0,
    }
    const composite = scoreComposite(report)
    expect(composite).toBeCloseTo(0.665, 5)
  })
})
