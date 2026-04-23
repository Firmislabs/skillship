import type { Database as Sqlite3Database } from 'better-sqlite3'
import { readBestClaim } from './claims.js'

interface AuthSchemeView {
  readonly id: string
  readonly type: string
  readonly location: string | undefined
  readonly paramName: string | undefined
}

export function renderAuthSection(
  db: Sqlite3Database,
  productId: string,
): string | null {
  const schemes = loadAuthSchemes(db, productId)
  if (schemes.length === 0) return null
  const blocks = schemes.map(renderSchemeBlock)
  return ['## Authentication', '', ...blocks].join('\n')
}

function loadAuthSchemes(
  db: Sqlite3Database,
  productId: string,
): AuthSchemeView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind='auth_scheme' AND parent_id=? ORDER BY id`,
    )
    .all(productId) as { id: string }[]
  return rows.map(r => ({
    id: r.id,
    type: readBestClaim(db, r.id, 'type') ?? 'custom',
    location: readBestClaim(db, r.id, 'location'),
    paramName: readBestClaim(db, r.id, 'param_name'),
  }))
}

function renderSchemeBlock(scheme: AuthSchemeView): string {
  const title = schemeTitle(scheme)
  const typeLine = `- **Type:** ${humanType(scheme.type)}`
  const locationLine = buildLocationLine(scheme)
  const lines = [title, typeLine]
  if (locationLine !== null) lines.push(locationLine)
  return lines.join('\n')
}

function schemeTitle(scheme: AuthSchemeView): string {
  const label = scheme.paramName ?? scheme.type
  return `### ${label}`
}

function humanType(type: string): string {
  switch (type) {
    case 'bearer': return 'bearer token'
    case 'basic': return 'HTTP Basic'
    case 'apiKey': return 'API key'
    case 'oauth2': return 'OAuth2'
    case 'mutualTLS': return 'Mutual TLS'
    default: return type
  }
}

function buildLocationLine(scheme: AuthSchemeView): string | null {
  if (scheme.type === 'bearer') {
    return `- **In:** header \`Authorization: Bearer <token>\``
  }
  if (scheme.type === 'basic') {
    return `- **In:** header \`Authorization: Basic <base64>\``
  }
  if (scheme.type === 'oauth2') {
    return `- **Note:** OAuth2 — consult the API's authorization server for flow details`
  }
  if (scheme.type === 'apiKey') {
    return buildApiKeyLocationLine(scheme)
  }
  return null
}

function buildApiKeyLocationLine(scheme: AuthSchemeView): string | null {
  const name = scheme.paramName ?? '<key>'
  const loc = scheme.location ?? 'header'
  if (loc === 'query') {
    return `- **In:** query parameter \`?${name}=<value>\``
  }
  if (loc === 'cookie') {
    return `- **In:** cookie \`${name}=<value>\``
  }
  return `- **In:** header \`${name}: <value>\``
}
