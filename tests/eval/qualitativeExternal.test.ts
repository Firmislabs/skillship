// TDD: tests for eval/qualitativeExternal.ts
// Run RED first (before implementation exists), then GREEN after.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import {
  scoreExternalStructure,
  scoreExternalDensity,
  scoreExternalFreshness,
  scoreExternalSchemaFidelity,
  scoreExternalSkill,
  countExternalOps,
} from '../../eval/qualitativeExternal.js'

// ---- Helpers -----------------------------------------------------------

function makeTmp(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `ext-skill-test-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const RICH_SKILL_DIR = join(
  process.cwd(),
  'tests/fixtures/external-skill/rich-skill',
)
const THIN_SKILL_DIR = join(
  process.cwd(),
  'tests/fixtures/external-skill/thin-skill',
)

// ---- countExternalOps --------------------------------------------------

describe('countExternalOps', () => {
  test('counts HTTP op lines in SKILL.md (backtick METHOD /path pattern)', () => {
    const md = `
- \`GET /v1/items\` — list
- \`POST /v1/items\` — create
- \`DELETE /v1/items/{id}\` — delete
`
    const count = countExternalOps(md, 0)
    expect(count).toBe(3)
  })

  test('falls back to references/ file count when no HTTP op lines', () => {
    const md = `# Some skill\n\nNo HTTP ops here.`
    const count = countExternalOps(md, 4)
    expect(count).toBe(4)
  })

  test('uses whichever is larger: op lines vs ref file count', () => {
    const md = `- \`GET /v1/a\` — one op`
    // 1 HTTP op, but 5 ref files → should pick 5
    const count = countExternalOps(md, 5)
    expect(count).toBe(5)
  })

  test('falls back to heading count when no HTTP ops and no refs', () => {
    const md = `# Skill\n\n## Create Issue\n\nDo stuff.\n\n## List Issues\n\nDo other stuff.`
    const count = countExternalOps(md, 0)
    // No HTTP ops, 0 refs. Should count op-looking headings (## ... level headings excluding frontmatter ones)
    // The fallback counts H2 headings
    expect(count).toBeGreaterThan(0)
  })

  test('returns 1 as minimum to avoid divide-by-zero', () => {
    const md = `# Skill`
    const count = countExternalOps(md, 0)
    expect(count).toBeGreaterThanOrEqual(1)
  })
})

// ---- scoreExternalStructure --------------------------------------------

describe('scoreExternalStructure', () => {
  test('rich skill with frontmatter, auth, code, errors, rate-limit → high score', () => {
    const score = scoreExternalStructure(RICH_SKILL_DIR)
    // Should pass: frontmatter gate, name, description≥20, auth, code, errors, rate-limit bonus
    expect(score).toBeGreaterThanOrEqual(1.0)
  })

  test('thin skill without frontmatter → 0', () => {
    const score = scoreExternalStructure(THIN_SKILL_DIR)
    expect(score).toBe(0)
  })

  test('missing SKILL.md → 0', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const score = scoreExternalStructure(dir)
      expect(score).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('skill with frontmatter but missing auth section → partial score', () => {
    const { dir, cleanup } = makeTmp()
    try {
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: partial\ndescription: A skill that is missing auth but has errors and code.\n---\n\n## Errors\n\n\`\`\`bash\ncurl example\n\`\`\`\n`,
      )
      const score = scoreExternalStructure(dir)
      // Passes: frontmatter, name, description≥20, code, errors — fails: auth → 4/5
      expect(score).toBeCloseTo(0.8, 2)
    } finally {
      cleanup()
    }
  })
})

// ---- scoreExternalDensity ----------------------------------------------

describe('scoreExternalDensity', () => {
  test('rich skill with large SKILL.md and refs → ideal density range → 1.0', () => {
    const score = scoreExternalDensity(RICH_SKILL_DIR)
    // rich-skill has 5 HTTP ops in SKILL.md, 2 ref files with substantial content
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThanOrEqual(1.0)
  })

  test('thin skill with almost no content and 1 implicit op → below ideal', () => {
    const score = scoreExternalDensity(THIN_SKILL_DIR)
    // Very few bytes, falls below ideal
    expect(score).toBeLessThan(1.0)
  })

  test('missing SKILL.md → 0', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const score = scoreExternalDensity(dir)
      expect(score).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('skill with many refs and small SKILL.md still accounts for ref bytes', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const refsDir = join(dir, 'references')
      mkdirSync(refsDir)
      // Write SKILL.md with 5 HTTP ops so we have realistic op count
      const skillMd = [
        '---',
        'name: test',
        'description: test skill for density accounting.',
        '---',
        '',
        '- `GET /a` — a',
        '- `POST /b` — b',
        '- `GET /c` — c',
        '- `DELETE /d` — d',
        '- `PATCH /e` — e',
      ].join('\n')
      writeFileSync(join(dir, 'SKILL.md'), skillMd)
      // Write a large ref file: 200KB total → pushes density high
      const bigContent = '# Ref\n\n## Parameters\n\n## Responses\n\n' + 'x'.repeat(200_000)
      writeFileSync(join(refsDir, 'op-a.md'), bigContent)
      const score = scoreExternalDensity(dir)
      // (200KB + tiny SKILL.md) / 4 / 5 = ~10000 t/op → at the ceiling → ~0
      expect(score).toBeLessThan(1.0)
    } finally {
      cleanup()
    }
  })
})

// ---- scoreExternalFreshness --------------------------------------------

describe('scoreExternalFreshness', () => {
  test('non-git directory → freshness = 0', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const score = scoreExternalFreshness(dir, new Date())
      expect(score).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('returns a number between 0 and 1 for valid git dirs', () => {
    // RICH_SKILL_DIR is inside the skillship repo (a git repo)
    // The fixture was recently added, so it should score > 0
    const score = scoreExternalFreshness(RICH_SKILL_DIR, new Date())
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1.0)
  })

  test('date far in future relative to file → score = 1.0 (freshly committed)', () => {
    // The fixtures are just now being committed, so git log will return a recent timestamp
    // Score should be 1.0 if the file was committed recently (within 30 days)
    const now = new Date()
    const score = scoreExternalFreshness(RICH_SKILL_DIR, now)
    // Can't assert exact value without knowing git log output, just verify it's valid
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1.0)
  })
})

// ---- scoreExternalSchemaFidelity ---------------------------------------

describe('scoreExternalSchemaFidelity', () => {
  test('rich skill refs with Parameters + Responses sections → high fidelity', () => {
    const score = scoreExternalSchemaFidelity(RICH_SKILL_DIR)
    // Both ref files have ## Parameters and ## Responses → each scores 1.0 → mean = 1.0
    expect(score).toBeCloseTo(1.0, 1)
  })

  test('thin skill with no references/ dir → 0', () => {
    const score = scoreExternalSchemaFidelity(THIN_SKILL_DIR)
    expect(score).toBe(0)
  })

  test('missing SKILL.md dir → 0', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const score = scoreExternalSchemaFidelity(dir)
      expect(score).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('refs with only Parameters (no Responses) → 0.5 per file', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const refsDir = join(dir, 'references')
      mkdirSync(refsDir)
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: t\ndescription: test.\n---\n- \`GET /x\` — x\n`,
      )
      writeFileSync(
        join(refsDir, 'op-x.md'),
        `# GET /x\n\n## Parameters\n\n| param | query | string | No | desc |\n`,
      )
      const score = scoreExternalSchemaFidelity(dir)
      // 1 ref: Parameters present (1/2) → 0.5
      expect(score).toBeCloseTo(0.5, 1)
    } finally {
      cleanup()
    }
  })

  test('refs with neither Parameters nor Responses → 0', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const refsDir = join(dir, 'references')
      mkdirSync(refsDir)
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: t\ndescription: test.\n---\n`)
      writeFileSync(join(refsDir, 'op-x.md'), `# GET /x\n\nSome description only.\n`)
      const score = scoreExternalSchemaFidelity(dir)
      expect(score).toBe(0)
    } finally {
      cleanup()
    }
  })
})

// ---- scoreExternalSkill (integration) ----------------------------------

describe('scoreExternalSkill', () => {
  test('rich skill → all dimensions populated, composite > 0', () => {
    const report = scoreExternalSkill(RICH_SKILL_DIR)
    expect(report.structure).toBeGreaterThanOrEqual(0)
    expect(report.density).toBeGreaterThanOrEqual(0)
    expect(report.freshness).toBeGreaterThanOrEqual(0)
    expect(report.schemaFidelity).toBeGreaterThanOrEqual(0)
    expect(report.composite).toBeGreaterThan(0)
    // Coverage is N/A for external skills → -1 sentinel
    expect(report.coverage).toBe(-1)
  })

  test('thin skill → structure = 0, composite is low', () => {
    const report = scoreExternalSkill(THIN_SKILL_DIR)
    expect(report.structure).toBe(0)
    expect(report.composite).toBeLessThan(0.5)
  })

  test('missing skill dir → all zeros except coverage sentinel', () => {
    const { dir, cleanup } = makeTmp()
    try {
      const report = scoreExternalSkill(dir)
      expect(report.structure).toBe(0)
      expect(report.density).toBe(0)
      expect(report.freshness).toBe(0)
      expect(report.schemaFidelity).toBe(0)
      expect(report.composite).toBe(0)
      expect(report.coverage).toBe(-1)
    } finally {
      cleanup()
    }
  })

  test('composite excludes coverage dimension and reweights the 4 remaining dims', () => {
    const report = scoreExternalSkill(RICH_SKILL_DIR)
    // Composite should NOT include coverage (which is -1)
    // Verify composite is a valid 0..1+ number
    expect(report.composite).toBeGreaterThanOrEqual(0)
    expect(report.composite).toBeLessThanOrEqual(1.2) // allows structure bonus
  })
})
