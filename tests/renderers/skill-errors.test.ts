import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openGraph, type GraphDb } from '../../src/graph/db.js'
import { renderSkillMd } from '../../src/renderers/skill.js'
import { renderErrorsSection } from '../../src/renderers/skill-errors.js'

const NOW = '2026-04-23T12:00:00.000Z'
const SOURCE_ID = 'src-test-1'

function ensureSource(graph: GraphDb): void {
  graph.db
    .prepare(
      `INSERT OR IGNORE INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, 'rest', 'https://test.example/openapi.yaml', 'application/openapi+yaml', ?, 100, 'cache/test.yaml')`,
    )
    .run(SOURCE_ID, NOW)
}

function insertProduct(graph: GraphDb, productId: string): void {
  ensureSource(graph)
  graph.db
    .prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'product', NULL, ?, ?)`,
    )
    .run(productId, NOW, NOW)
}

function insertSurface(graph: GraphDb, surfaceId: string, productId: string): void {
  graph.db
    .prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'surface', ?, ?, ?)`,
    )
    .run(surfaceId, productId, NOW, NOW)
}

function insertOp(graph: GraphDb, opId: string, surfaceId: string): void {
  graph.db
    .prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'operation', ?, ?, ?)`,
    )
    .run(opId, surfaceId, NOW, NOW)
}

function insertResponseShape(
  graph: GraphDb,
  rspId: string,
  opId: string,
  statusCode: number | string,
): void {
  graph.db
    .prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'response_shape', ?, ?, ?)`,
    )
    .run(rspId, opId, NOW, NOW)
  graph.db
    .prepare(
      `INSERT INTO claims
       (id, node_id, field, value_json, source_id, extractor, extracted_at,
        span_start, span_end, span_path, confidence, chosen, rejection_rationale)
       VALUES (?, ?, 'status_code', ?, ?, 'openapi@3', ?, NULL, NULL, NULL, 'attested', 1, NULL)`,
    )
    .run(
      `clm-${rspId}-status`,
      rspId,
      JSON.stringify(statusCode),
      SOURCE_ID,
      NOW,
    )
}

describe('renderErrorsSection', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-errors-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('product with ops returning 200, 400, 401 renders Errors table with counts', () => {
    insertProduct(graph, 'p-errs')
    insertSurface(graph, 'sfc-1', 'p-errs')
    insertOp(graph, 'op-1', 'sfc-1')
    insertOp(graph, 'op-2', 'sfc-1')
    insertResponseShape(graph, 'rsp-1', 'op-1', 200)
    insertResponseShape(graph, 'rsp-2', 'op-1', 400)
    insertResponseShape(graph, 'rsp-3', 'op-2', 200)
    insertResponseShape(graph, 'rsp-4', 'op-2', 401)

    const result = renderErrorsSection(graph.db, 'p-errs')
    expect(result).not.toBeNull()
    expect(result).toContain('## Errors')
    expect(result).toContain('| 200')
    expect(result).toContain('| 400')
    expect(result).toContain('| 401')
    expect(result).toContain('OK')
    expect(result).toContain('Bad Request')
    expect(result).toContain('Unauthorized')
    // 200 appears twice, should show count 2
    const lines = result!.split('\n')
    const row200 = lines.find(l => l.includes('| 200'))
    expect(row200).toBeDefined()
    expect(row200).toContain('2')
  })

  test('default status code is bucketed as Default', () => {
    insertProduct(graph, 'p-default')
    insertSurface(graph, 'sfc-2', 'p-default')
    insertOp(graph, 'op-3', 'sfc-2')
    insertResponseShape(graph, 'rsp-5', 'op-3', 'default')

    const result = renderErrorsSection(graph.db, 'p-default')
    expect(result).not.toBeNull()
    expect(result).toContain('Default')
  })

  test('product with zero response_shape nodes returns null', () => {
    insertProduct(graph, 'p-noerrs')
    insertSurface(graph, 'sfc-3', 'p-noerrs')
    insertOp(graph, 'op-4', 'sfc-3')

    const result = renderErrorsSection(graph.db, 'p-noerrs')
    expect(result).toBeNull()
  })

  test('product with no surfaces returns null', () => {
    insertProduct(graph, 'p-nosfc')
    const result = renderErrorsSection(graph.db, 'p-nosfc')
    expect(result).toBeNull()
  })

  test('rows are sorted by count descending', () => {
    insertProduct(graph, 'p-sort')
    insertSurface(graph, 'sfc-4', 'p-sort')
    insertOp(graph, 'op-5', 'sfc-4')
    insertOp(graph, 'op-6', 'sfc-4')
    insertOp(graph, 'op-7', 'sfc-4')
    // 200 appears 3 times, 400 once
    insertResponseShape(graph, 'rsp-6', 'op-5', 200)
    insertResponseShape(graph, 'rsp-7', 'op-6', 200)
    insertResponseShape(graph, 'rsp-8', 'op-7', 200)
    insertResponseShape(graph, 'rsp-9', 'op-5', 400)

    const result = renderErrorsSection(graph.db, 'p-sort')
    expect(result).not.toBeNull()
    const lines = result!.split('\n').filter(l => l.startsWith('|') && !l.includes('status') && !l.includes('---'))
    // First data row should be 200 with count 3
    expect(lines[0]).toContain('200')
    expect(lines[0]).toContain('3')
    expect(lines[1]).toContain('400')
    expect(lines[1]).toContain('1')
  })

  test('caps at 12 rows maximum', () => {
    insertProduct(graph, 'p-cap')
    insertSurface(graph, 'sfc-5', 'p-cap')
    // Create 15 different status codes
    for (let i = 0; i < 15; i++) {
      const opId = `op-cap-${i}`
      const rspId = `rsp-cap-${i}`
      const statusCode = 200 + i
      insertOp(graph, opId, 'sfc-5')
      insertResponseShape(graph, rspId, opId, statusCode)
    }

    const result = renderErrorsSection(graph.db, 'p-cap')
    expect(result).not.toBeNull()
    const dataRows = result!
      .split('\n')
      .filter(l => l.startsWith('|') && !l.includes('status') && !l.includes('---'))
    expect(dataRows.length).toBeLessThanOrEqual(12)
  })
})

describe('renderSkillMd with errors section', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-errors-int-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('renderSkillMd contains ## Errors after ## Operations when response shapes exist', () => {
    insertProduct(graph, 'p-int-errs')
    insertSurface(graph, 'sfc-int-1', 'p-int-errs')
    insertOp(graph, 'op-int-1', 'sfc-int-1')
    insertResponseShape(graph, 'rsp-int-1', 'op-int-1', 200)

    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-int-errs',
      productName: 'errors.example',
      allowedTools: ['Read'],
    })
    expect(out).toContain('## Errors')
    const opsIdx = out.indexOf('## Operations')
    const errIdx = out.indexOf('## Errors')
    expect(errIdx).toBeGreaterThan(opsIdx)
  })

  test('renderSkillMd omits ## Errors when no response shapes', () => {
    insertProduct(graph, 'p-int-noerrs')
    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-int-noerrs',
      productName: 'noerrors.example',
      allowedTools: ['Read'],
    })
    expect(out).not.toContain('## Errors')
  })

  test('renderSkillMd contains both ## Authentication and ## Errors when applicable', () => {
    insertProduct(graph, 'p-int-both')
    // Auth scheme node
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('ath-int-both', 'auth_scheme', 'p-int-both', ?, ?)`,
      )
      .run(NOW, NOW)
    // Auth scheme claim with valid source_id
    graph.db
      .prepare(
        `INSERT INTO claims
         (id, node_id, field, value_json, source_id, extractor, extracted_at,
          span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES ('clm-ath-type', 'ath-int-both', 'type', '"bearer"', ?, 'openapi@3', ?, NULL, NULL, NULL, 'attested', 1, NULL)`,
      )
      .run(SOURCE_ID, NOW)
    // Surface + op + response
    insertSurface(graph, 'sfc-int-both', 'p-int-both')
    insertOp(graph, 'op-int-both', 'sfc-int-both')
    insertResponseShape(graph, 'rsp-int-both', 'op-int-both', 200)

    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-int-both',
      productName: 'both.example',
      allowedTools: ['Read'],
    })
    expect(out).toContain('## Authentication')
    expect(out).toContain('## Errors')
  })
})
