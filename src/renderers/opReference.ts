import type { Database as Sqlite3Database } from 'better-sqlite3'
import { readBestClaim } from './claims.js'

interface ParameterView {
  readonly name: string
  readonly location: string
  readonly required: boolean
  readonly type: string
  readonly description: string | undefined
}

interface ResponseView {
  readonly statusCode: string
  readonly contentType: string
  readonly schemaRef: string | undefined
}

interface AuthView {
  readonly type: string
  readonly paramName: string | undefined
}

export function renderOpReference(
  db: Sqlite3Database,
  opId: string,
  _productId: string,
): string {
  const method = readBestClaim(db, opId, 'method') ?? 'OP'
  const path = readBestClaim(db, opId, 'path_or_name') ?? opId
  const summary = readBestClaim(db, opId, 'summary')
  const description = readBestClaim(db, opId, 'description')

  const params = loadParameters(db, opId)
  const responses = loadResponses(db, opId)
  const auths = loadAuthSchemes(db, opId)

  const sections: string[] = []
  sections.push(`# ${method.toUpperCase()} ${path}`)
  sections.push('')

  if (summary !== undefined) {
    sections.push(`**${summary}**`)
    sections.push('')
  }
  if (description !== undefined && description !== summary) {
    sections.push(description)
    sections.push('')
  }

  if (params.length > 0) {
    sections.push(...renderParametersSection(params))
  }
  if (responses.length > 0) {
    sections.push(...renderResponsesSection(responses))
  }
  if (auths.length > 0) {
    sections.push(...renderAuthSection(auths))
  }

  return sections.join('\n')
}

function loadParameters(
  db: Sqlite3Database,
  opId: string,
): ParameterView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind = 'parameter' AND parent_id = ? ORDER BY id`,
    )
    .all(opId) as { id: string }[]
  return rows.map(r => buildParameterView(db, r.id))
}

function buildParameterView(
  db: Sqlite3Database,
  paramId: string,
): ParameterView {
  const requiredRaw = db
    .prepare(
      `SELECT value_json FROM claims WHERE node_id = ? AND field = 'required' ORDER BY id LIMIT 1`,
    )
    .get(paramId) as { value_json: string } | undefined
  const required = requiredRaw !== undefined
    ? (JSON.parse(requiredRaw.value_json) as boolean)
    : false
  return {
    name: readBestClaim(db, paramId, 'name') ?? '',
    location: readBestClaim(db, paramId, 'location') ?? '',
    required,
    type: readBestClaim(db, paramId, 'type') ?? 'unknown',
    description: readBestClaim(db, paramId, 'description'),
  }
}

function renderParametersSection(params: readonly ParameterView[]): string[] {
  const lines: string[] = ['## Parameters', '']
  lines.push('| name | in | required | type | description |')
  lines.push('|------|----|----------|------|-------------|')
  for (const p of params) {
    const desc = p.description ?? ''
    lines.push(`| ${p.name} | ${p.location} | ${p.required ? 'yes' : 'no'} | ${p.type} | ${desc} |`)
  }
  lines.push('')
  return lines
}

function loadResponses(
  db: Sqlite3Database,
  opId: string,
): ResponseView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind = 'response_shape' AND parent_id = ? ORDER BY id`,
    )
    .all(opId) as { id: string }[]
  return rows.map(r => buildResponseView(db, r.id))
}

function buildResponseView(
  db: Sqlite3Database,
  respId: string,
): ResponseView {
  const statusRaw = db
    .prepare(
      `SELECT value_json FROM claims WHERE node_id = ? AND field = 'status_code' ORDER BY id LIMIT 1`,
    )
    .get(respId) as { value_json: string } | undefined
  const status = statusRaw !== undefined
    ? String(JSON.parse(statusRaw.value_json) as number | string)
    : '?'
  return {
    statusCode: status,
    contentType: readBestClaim(db, respId, 'content_type') ?? '*/*',
    schemaRef: readBestClaim(db, respId, 'schema_ref'),
  }
}

function renderResponsesSection(responses: readonly ResponseView[]): string[] {
  const lines: string[] = ['## Responses', '']
  lines.push('| status | content-type | schema |')
  lines.push('|--------|-------------|--------|')
  for (const r of responses) {
    const schema = r.schemaRef ?? ''
    lines.push(`| ${r.statusCode} | ${r.contentType} | ${schema} |`)
  }
  lines.push('')
  return lines
}

function loadAuthSchemes(
  db: Sqlite3Database,
  opId: string,
): AuthView[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.to_node_id AS auth_id
         FROM edges e
        WHERE e.from_node_id = ? AND e.kind = 'auth_requires'`,
    )
    .all(opId) as { auth_id: string }[]
  return rows.map(r => ({
    type: readBestClaim(db, r.auth_id, 'type') ?? 'unknown',
    paramName: readBestClaim(db, r.auth_id, 'param_name'),
  }))
}

function renderAuthSection(auths: readonly AuthView[]): string[] {
  const lines: string[] = ['## Authentication', '']
  for (const a of auths) {
    const detail = a.paramName !== undefined ? ` (${a.paramName})` : ''
    lines.push(`- ${a.type}${detail}`)
  }
  lines.push('')
  return lines
}
