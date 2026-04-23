import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { openGraph, type GraphDb } from '../../src/graph/db.js'
import { renderSkillMd } from '../../src/renderers/skill.js'
import { renderAuthSection } from '../../src/renderers/skill-auth.js'

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

function insertAuthScheme(
  graph: GraphDb,
  schemeId: string,
  productId: string,
  claims: Record<string, string | number>,
): void {
  graph.db
    .prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
       VALUES (?, 'auth_scheme', ?, ?, ?)`,
    )
    .run(schemeId, productId, NOW, NOW)
  for (const [field, value] of Object.entries(claims)) {
    graph.db
      .prepare(
        `INSERT INTO claims
         (id, node_id, field, value_json, source_id, extractor, extracted_at,
          span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES (?, ?, ?, ?, ?, 'openapi@3', ?, NULL, NULL, NULL, 'attested', 1, NULL)`,
      )
      .run(
        `clm-${schemeId}-${field}`,
        schemeId,
        field,
        JSON.stringify(value),
        SOURCE_ID,
        NOW,
      )
  }
}

describe('renderAuthSection', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-auth-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('product with bearer scheme emits Authentication section with Bearer hint', () => {
    insertProduct(graph, 'p-bearer')
    insertAuthScheme(graph, 'ath-1', 'p-bearer', { type: 'bearer' })
    const result = renderAuthSection(graph.db, 'p-bearer')
    expect(result).not.toBeNull()
    expect(result).toContain('## Authentication')
    expect(result).toContain('Bearer')
    expect(result).toContain('Authorization')
  })

  test('product with apiKey-in-header scheme emits header hint with param name', () => {
    insertProduct(graph, 'p-apikey')
    insertAuthScheme(graph, 'ath-2', 'p-apikey', {
      type: 'apiKey',
      location: 'header',
      param_name: 'X-API-Key',
    })
    const result = renderAuthSection(graph.db, 'p-apikey')
    expect(result).not.toBeNull()
    expect(result).toContain('## Authentication')
    expect(result).toContain('API key')
    expect(result).toContain('X-API-Key')
  })

  test('product with apiKey-in-query scheme shows query hint', () => {
    insertProduct(graph, 'p-apikeyq')
    insertAuthScheme(graph, 'ath-3', 'p-apikeyq', {
      type: 'apiKey',
      location: 'query',
      param_name: 'api_key',
    })
    const result = renderAuthSection(graph.db, 'p-apikeyq')
    expect(result).not.toBeNull()
    expect(result).toContain('query')
    expect(result).toContain('api_key')
  })

  test('product with oauth2 scheme emits minimal OAuth2 block', () => {
    insertProduct(graph, 'p-oauth')
    insertAuthScheme(graph, 'ath-4', 'p-oauth', { type: 'oauth2' })
    const result = renderAuthSection(graph.db, 'p-oauth')
    expect(result).not.toBeNull()
    expect(result).toContain('## Authentication')
    expect(result).toContain('OAuth2')
  })

  test('product with no auth schemes returns null (section omitted)', () => {
    insertProduct(graph, 'p-noauth')
    const result = renderAuthSection(graph.db, 'p-noauth')
    expect(result).toBeNull()
  })

  test('basic auth scheme shows basic hint', () => {
    insertProduct(graph, 'p-basic')
    insertAuthScheme(graph, 'ath-5', 'p-basic', { type: 'basic' })
    const result = renderAuthSection(graph.db, 'p-basic')
    expect(result).not.toBeNull()
    expect(result).toContain('Basic')
  })
})

describe('renderSkillMd with auth section', () => {
  let tmp: string
  let graph: GraphDb

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skillship-auth-int-'))
    graph = openGraph(join(tmp, 'graph.db'))
  })

  afterEach(() => {
    graph.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('renderSkillMd contains ## Authentication when bearer scheme exists', () => {
    insertProduct(graph, 'p-int-auth')
    insertAuthScheme(graph, 'ath-int-1', 'p-int-auth', { type: 'bearer' })
    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-int-auth',
      productName: 'int.example',
      allowedTools: ['Read'],
    })
    expect(out).toContain('## Authentication')
    expect(out).toContain('## Surfaces')
    expect(out).toContain('## Operations')
    const authIdx = out.indexOf('## Authentication')
    const surfIdx = out.indexOf('## Surfaces')
    const opsIdx = out.indexOf('## Operations')
    expect(authIdx).toBeGreaterThan(surfIdx)
    expect(opsIdx).toBeGreaterThan(authIdx)
  })

  test('renderSkillMd omits ## Authentication when no auth schemes', () => {
    insertProduct(graph, 'p-int-noauth')
    const out = renderSkillMd({
      db: graph.db,
      productId: 'p-int-noauth',
      productName: 'noauth.example',
      allowedTools: ['Read'],
    })
    expect(out).not.toContain('## Authentication')
  })
})
