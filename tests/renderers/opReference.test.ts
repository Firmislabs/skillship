import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openGraph, type GraphDb } from '../../src/graph/db.js'
import { ingestConfig } from '../../src/ingest/pipeline.js'
import { renderOpReference } from '../../src/renderers/opReference.js'
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

function getFirstOpId(graph: GraphDb, productId: string): string {
  const row = graph.db
    .prepare(
      `SELECT n.id FROM nodes n
       JOIN nodes s ON s.id = n.parent_id
       WHERE n.kind = 'operation' AND s.parent_id = ?
       ORDER BY n.id
       LIMIT 1`,
    )
    .get(productId) as { id: string } | undefined
  if (row === undefined) throw new Error('no operations found')
  return row.id
}

describe('renderOpReference', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-opref-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('renders H1 with METHOD and path_or_name', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref', 'ref.example')
    const opId = getFirstOpId(graph, 'p-ref')
    const md = renderOpReference(graph.db, opId, 'p-ref')
    // Should start with # METHOD /path
    expect(md).toMatch(/^# (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE) \//m)
  })

  test('renders Parameters section with table when params exist', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref2', 'ref2.example')
    // GET /projects has two params: limit (query) and X-Trace-Id (header)
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"GET"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ref2'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no GET op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ref2')
    expect(md).toMatch(/## Parameters/)
    // table header
    expect(md).toMatch(/name.*in.*required.*type/i)
    // should mention limit and X-Trace-Id
    expect(md).toMatch(/limit/)
    expect(md).toMatch(/X-Trace-Id/)
  })

  test('omits Parameters section when op has no params', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref3', 'ref3.example')
    // POST /projects has no parameters (only requestBody, not modelled as params here)
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"POST"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ref3'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no POST op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ref3')
    expect(md).not.toMatch(/## Parameters/)
  })

  test('renders Responses section with table when responses exist', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref4', 'ref4.example')
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"GET"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ref4'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no GET op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ref4')
    expect(md).toMatch(/## Responses/)
    // table header
    expect(md).toMatch(/status.*content-type.*schema/i)
    // 200 and 401 responses
    expect(md).toMatch(/200/)
    expect(md).toMatch(/401/)
  })

  test('renders Authentication section when op has auth_requires edges', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref5', 'ref5.example')
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"GET"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ref5'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no GET op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ref5')
    expect(md).toMatch(/## Authentication/)
  })

  test('renders Request Example fenced JSON when requestBody example exists', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/examples.yaml', 'p-ex1', 'ex1.example')
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"POST"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ex1'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no POST op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ex1')
    expect(md).toMatch(/## Request Example/)
    expect(md).toMatch(/```json/)
    expect(md).toMatch(/"name":\s*"gizmo"/)
    expect(md).toMatch(/"count":\s*3/)
  })

  test('renders Response Example fenced JSON when response example exists', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/examples.yaml', 'p-ex2', 'ex2.example')
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"GET"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ex2'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no GET op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ex2')
    expect(md).toMatch(/## Response Example/)
    expect(md).toMatch(/```json/)
    expect(md).toMatch(/"id":\s*"w_1"/)
  })

  test('renders enum values appended to type column for enum-constrained params', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/examples.yaml', 'p-ex3', 'ex3.example')
    const opId = graph.db
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field = 'method' AND m.value_json = '"GET"'
         WHERE n.kind = 'operation' AND s.parent_id = 'p-ex3'
         LIMIT 1`,
      )
      .get() as { id: string } | undefined
    if (opId === undefined) throw new Error('no GET op found')
    const md = renderOpReference(graph.db, opId.id, 'p-ex3')
    // type column should show: string (open|closed|draft)
    expect(md).toMatch(/string\s*\(open\|closed\|draft\)/)
  })

  test('falls back to params claim list when no parameter child nodes exist', () => {
    const db = graph.db
    const NOW2 = '2026-04-23T00:00:00Z'
    db.prepare(
      `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('src-gql', 'graphql', 'https://x/schema.graphql', 'application/graphql', NOW2, 100, '/tmp/x')
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'operation', ?, ?, ?)`,
    ).run('op-fb-1', 'p-fb', NOW2, NOW2)
    const insertClaim = db.prepare(
      `INSERT INTO claims (id, node_id, field, value_json, source_id, extractor, extracted_at, confidence, chosen)
       VALUES (?, ?, ?, ?, 'src-gql', 'graphql@1', ?, 'attested', 1)`,
    )
    insertClaim.run('c1', 'op-fb-1', 'method', JSON.stringify('QUERY'), NOW2)
    insertClaim.run('c2', 'op-fb-1', 'path_or_name', JSON.stringify('issue'), NOW2)
    insertClaim.run('c3', 'op-fb-1', 'params', JSON.stringify(['id: ID!', 'teamId: String']), NOW2)
    const md = renderOpReference(db, 'op-fb-1', 'p-fb')
    expect(md).toMatch(/## Parameters/)
    expect(md).toMatch(/id: ID!/)
    expect(md).toMatch(/teamId: String/)
  })

  test('returns non-empty string for any valid opId', async () => {
    await ingestOpenapi(graph, 'tests/fixtures/openapi3/minimal.yaml', 'p-ref6', 'ref6.example')
    const opId = getFirstOpId(graph, 'p-ref6')
    const md = renderOpReference(graph.db, opId, 'p-ref6')
    expect(typeof md).toBe('string')
    expect(md.length).toBeGreaterThan(0)
  })
})
