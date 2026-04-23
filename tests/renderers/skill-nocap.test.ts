import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openGraph, type GraphDb } from '../../src/graph/db.js'
import { ingestConfig } from '../../src/ingest/pipeline.js'
import { renderSkillMd } from '../../src/renderers/skill.js'
import type { SkillshipConfig } from '../../src/discovery/config.js'

const NOW = '2026-04-23T12:00:00.000Z'

async function ingestOpenapi(
  graph: GraphDb,
  fixture: string,
  productId: string,
  domain: string,
): Promise<void> {
  const bytes = readFileSync(join(process.cwd(), fixture))
  const sha = createHash('sha256').update(bytes).digest('hex')
  const config: SkillshipConfig = {
    product: { domain, github_org: null },
    sources: [
      {
        surface: 'rest',
        url: `https://${domain}/openapi.yaml`,
        sha256: sha,
        content_type: 'application/openapi+yaml',
        fetched_at: NOW,
      },
    ],
    coverage: 'bronze',
  }
  await ingestConfig({
    db: graph.db,
    config,
    productId,
    loadBytes: async () => bytes,
    now: () => NOW,
  })
}

describe('renderSkillMd - no default cap (R2)', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-nocap-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('renders all 160 ops from bulk-160.yaml without cap when no cap specified', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/bulk-160.yaml', 'p-big', 'big.example')
    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-big',
      productName: 'big.example',
      allowedTools: ['Read'],
      // No operationIndexCap — should show all
    })
    const opLines = out.split('\n').filter(l => /^- `[A-Z]+ \//.test(l))
    // Should show ALL 160 ops, not truncate at 50
    expect(opLines.length).toBe(160)
    // Should NOT have the "more operations" truncation notice
    expect(out).not.toMatch(/\+ \d+ more operations/)
  })

  test('explicit cap still truncates when provided', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/bulk-160.yaml', 'p-big2', 'big2.example')
    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-big2',
      productName: 'big2.example',
      allowedTools: ['Read'],
      operationIndexCap: 5,
    })
    const opLines = out.split('\n').filter(l => /^- `[A-Z]+ \//.test(l))
    expect(opLines.length).toBe(5)
    expect(out).toMatch(/\+ 155 more operations/)
  })
})
