import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stringify as stringifyYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { runBuild } from '../../src/cli/build.js'
import { makeTmpCtx, type TmpCtx } from '../helpers.js'
import type { SkillshipConfig } from '../../src/discovery/config.js'

const NOW = '2026-04-23T12:00:00.000Z'

function seedProject(dir: string, sources: Array<{
  surface: SkillshipConfig['sources'][number]['surface']
  url: string
  contentType: string
  bytes: Buffer
  ext: string
}>, domain: string): void {
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
      fetched_at: NOW,
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

describe('runBuild reference file generation (R1)', () => {
  let ctx: TmpCtx

  beforeEach(() => {
    ctx = makeTmpCtx('skillship-build-ref-')
  })

  afterEach(() => {
    ctx.cleanup()
  })

  test('emits references/ directory inside the skill directory', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://x.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const refsDir = join(outDir, 'skills', 'x-example', 'references')
    expect(existsSync(refsDir)).toBe(true)
  })

  test('emits one .md file per operation in references/', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://x.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const refsDir = join(outDir, 'skills', 'x-example', 'references')
    const files = readdirSync(refsDir)
    // minimal.yaml has 2 ops: GET /projects and POST /projects
    expect(files.length).toBe(2)
    expect(files.every(f => f.endsWith('.md'))).toBe(true)
  })

  test('reference files are included in BuildArtifact[] return value', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://x.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    const result = await runBuild({ in: ctx.dir, out: outDir })
    const refArtifacts = result.artifacts.filter(a => a.path.includes('/references/'))
    // 2 ops → 2 reference artifacts
    expect(refArtifacts.length).toBe(2)
    expect(refArtifacts.every(a => a.bytes > 0)).toBe(true)
  })

  test('per-op reference file has Parameters and Responses sections', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://x.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const refsDir = join(outDir, 'skills', 'x-example', 'references')
    const files = readdirSync(refsDir)
    // At least one file should have Parameters section (GET /projects has params)
    const contents = files.map(f => readFileSync(join(refsDir, f), 'utf8'))
    const hasParamsSection = contents.some(c => /## Parameters/.test(c))
    const hasResponsesSection = contents.some(c => /## Responses/.test(c))
    expect(hasParamsSection).toBe(true)
    expect(hasResponsesSection).toBe(true)
  })

  test('SKILL.md op lines still contain [details](references/<id>.md) links', async () => {
    seedProject(
      ctx.dir,
      [{
        surface: 'rest',
        url: 'https://x.example/openapi.yaml',
        contentType: 'application/openapi+yaml',
        bytes: loadFixture('tests/fixtures/openapi3/minimal.yaml'),
        ext: 'yaml',
      }],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const skillMd = readFileSync(join(outDir, 'skills', 'x-example', 'SKILL.md'), 'utf8')
    expect(skillMd).toMatch(/\[details\]\(references\/op_[a-f0-9]+\.md\)/)
  })
})

describe('runBuild surface deduplication (R3)', () => {
  let ctx: TmpCtx

  beforeEach(() => {
    ctx = makeTmpCtx('skillship-build-dedup-')
  })

  afterEach(() => {
    ctx.cleanup()
  })

  test('two REST specs for same product merge into one surface row in SKILL.md', async () => {
    // Seed two different OpenAPI specs for the same product
    const spec1 = loadFixture('tests/fixtures/openapi3/minimal.yaml')
    // We create a second variant by modifying the version field
    const spec2Content = readFileSync(
      join(process.cwd(), 'tests/fixtures/openapi3/minimal.yaml'),
      'utf8',
    ).replace('version: 1.0.0', 'version: 2.0.0')
    const spec2 = Buffer.from(spec2Content, 'utf8')

    seedProject(
      ctx.dir,
      [
        {
          surface: 'rest',
          url: 'https://x.example/openapi-v1.yaml',
          contentType: 'application/openapi+yaml',
          bytes: spec1,
          ext: 'yaml',
        },
        {
          surface: 'rest',
          url: 'https://x.example/openapi-v2.yaml',
          contentType: 'application/openapi+yaml',
          bytes: spec2,
          ext: 'yaml',
        },
      ],
      'x.example',
    )
    const outDir = join(ctx.dir, 'dist')
    await runBuild({ in: ctx.dir, out: outDir })
    const skillMd = readFileSync(join(outDir, 'skills', 'x-example', 'SKILL.md'), 'utf8')
    // Should have exactly one "rest" surface row, not two
    const restRows = (skillMd.match(/^- rest/gm) ?? [])
    expect(restRows.length).toBe(1)
  })
})
