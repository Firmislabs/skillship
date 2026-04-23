import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runBuild } from '../../src/cli/build.js'
import { makeTmpCtx, type TmpCtx } from '../helpers.js'
import type { SkillshipConfig } from '../../src/discovery/config.js'
import {
  scoreDensityWithRefs,
  scoreStructureWithRefs,
} from '../../eval/qualitative.js'

function seedProject(
  dir: string,
  sources: Array<{
    surface: SkillshipConfig['sources'][number]['surface']
    url: string
    contentType: string
    bytes: Buffer
    ext: string
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
      fetched_at: new Date().toISOString(),
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

// ---- scoreDensityWithRefs tests ------------------------------------

describe('scoreDensityWithRefs', () => {
  test('counts references bytes when computing density', () => {
    // 200 bytes SKILL.md + 800 bytes of refs total for 1 op → (1000/4)/1 = 250 t/op → ideal → 1.0
    const score = scoreDensityWithRefs(200, 800, 1)
    expect(score).toBe(1.0)
  })

  test('returns 0 when 0 ops', () => {
    const score = scoreDensityWithRefs(1000, 5000, 0)
    expect(score).toBe(0)
  })

  test('below 50 t/op → 0', () => {
    // 49 tokens / 1 op = 49 t/op → below floor
    const score = scoreDensityWithRefs(49 * 4, 0, 1)
    expect(score).toBe(0)
  })

  test('ideal band 200-2000 t/op → 1.0', () => {
    // 200 t/op exactly
    expect(scoreDensityWithRefs(200 * 4, 0, 1)).toBe(1.0)
    // 2000 t/op exactly
    expect(scoreDensityWithRefs(2000 * 4, 0, 1)).toBe(1.0)
  })

  test('ignores zero ref bytes gracefully', () => {
    // 100 t/op without refs: (100-50)/(200-50) ≈ 0.333
    const score = scoreDensityWithRefs(100 * 4, 0, 1)
    expect(score).toBeCloseTo(0.333, 2)
  })
})

// ---- scoreStructureWithRefs tests ---------------------------------

describe('scoreStructureWithRefs', () => {
  let ctx: TmpCtx

  beforeEach(() => {
    ctx = makeTmpCtx('skillship-qual-ref-str-')
  })

  afterEach(() => {
    ctx.cleanup()
  })

  test('references/ dir present with matching file count boosts structure check', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://acme.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'acme.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const skillDir = join(outDir, 'skills', 'acme-example')
    // With references dir present (2 files), score should be > 0
    const score = scoreStructureWithRefs(skillDir, 2)
    expect(score).toBeGreaterThan(0)
  })

  test('missing references/ dir returns 0 for references check', () => {
    // Use a temp dir without references/
    mkdirSync(ctx.dir, { recursive: true })
    const score = scoreStructureWithRefs(ctx.dir, 5)
    expect(score).toBe(0)
  })

  test('references/ present but empty when ops > 0 returns 0', () => {
    const skillDir = ctx.dir
    mkdirSync(join(skillDir, 'references'), { recursive: true })
    // 0 files but 5 expected ops
    const score = scoreStructureWithRefs(skillDir, 5)
    expect(score).toBe(0)
  })

  test('references count matches expected ops → returns 1.0', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://acme.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'acme.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const skillDir = join(outDir, 'skills', 'acme-example')
    // 2 ops → 2 ref files
    const score = scoreStructureWithRefs(skillDir, 2)
    expect(score).toBe(1.0)
  })
})
