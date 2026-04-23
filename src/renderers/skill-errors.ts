import type { Database as Sqlite3Database } from 'better-sqlite3'

const STATUS_NAMES: Record<string, string> = {
  '200': 'OK',
  '201': 'Created',
  '204': 'No Content',
  '400': 'Bad Request',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not Found',
  '409': 'Conflict',
  '422': 'Unprocessable Entity',
  '429': 'Too Many Requests',
  '500': 'Internal Server Error',
  '502': 'Bad Gateway',
  '503': 'Service Unavailable',
  default: 'Default',
}

const MAX_ROWS = 12

interface StatusCount {
  readonly status: string
  readonly count: number
  readonly description: string
}

export function renderErrorsSection(
  db: Sqlite3Database,
  productId: string,
): string | null {
  const counts = aggregateStatusCodes(db, productId)
  if (counts.length === 0) return null
  const rows = counts.slice(0, MAX_ROWS)
  return buildErrorsMarkdown(rows)
}

function aggregateStatusCodes(
  db: Sqlite3Database,
  productId: string,
): StatusCount[] {
  const raw = db
    .prepare(
      `SELECT c.value_json
       FROM claims c
       JOIN nodes rsp ON rsp.id = c.node_id AND rsp.kind = 'response_shape'
       JOIN nodes op  ON op.id  = rsp.parent_id AND op.kind = 'operation'
       JOIN nodes sfc ON sfc.id = op.parent_id  AND sfc.kind = 'surface'
       WHERE sfc.parent_id = ?
         AND c.field = 'status_code'`,
    )
    .all(productId) as { value_json: string }[]

  const counts = new Map<string, number>()
  for (const row of raw) {
    const parsed = JSON.parse(row.value_json)
    const key = toStatusKey(parsed)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return [...counts.entries()]
    .map(([status, count]) => ({
      status,
      count,
      description: STATUS_NAMES[status] ?? STATUS_NAMES['default']!,
    }))
    .sort((a, b) => b.count - a.count)
}

function toStatusKey(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return String(n)
    return 'default'
  }
  return 'default'
}

function buildErrorsMarkdown(rows: StatusCount[]): string {
  const header = [
    '## Errors',
    '',
    'Common response status codes across this API:',
    '',
    '| status | count | description |',
    '|--------|-------|-------------|',
  ]
  const dataRows = rows.map(
    r => `| ${r.status} | ${r.count} | ${r.description} |`,
  )
  const footer = ['', 'See per-op references for exact response shapes.']
  return [...header, ...dataRows, ...footer].join('\n')
}
