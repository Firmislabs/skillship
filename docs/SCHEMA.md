# Skillship Schema

Authoritative spec for node kinds, edge kinds, and their DDL mapping.

- TypeScript: [`src/graph/types.ts`](../src/graph/types.ts)
- SQL: [`src/graph/schema.sql`](../src/graph/schema.sql)
- Architecture context: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Node kinds (12)

Every node is one row in `nodes`, with its per-field values stored in
`claims`.

| Kind             | Purpose                                     | Parent         |
|------------------|---------------------------------------------|----------------|
| `product`        | The vendor (e.g. Supabase)                  | —              |
| `surface`        | One exposed channel (REST v1, CLI, MCP...)  | product        |
| `operation`      | One endpoint, command, or tool              | surface        |
| `parameter`      | One input to an operation                   | operation      |
| `response_shape` | One possible output of an operation         | operation      |
| `resource`       | A domain entity (project, table, function)  | product        |
| `auth_scheme`    | One way to authenticate                     | product        |
| `example`        | Code sample for an operation                | operation      |
| `doc_page`       | One prose doc page                          | product        |
| `override_note`  | Human decision overriding a machine claim   | target node    |
| `source`         | One fetched artifact (content-addressable)  | —              |
| `release`        | A frozen set of sources                     | product        |

### `operation` fields

The richest node. Mirrors MCP `ToolAnnotations` verbatim where fields
overlap, so translating an operation to an MCP tool is lossless.

| Field             | Type     | Notes                                  |
|-------------------|----------|----------------------------------------|
| `method`          | string   | `POST`/`GET`/`deploy`/tool name        |
| `path_or_name`    | string   | path for REST; command for CLI         |
| `summary`         | string   | one-line                               |
| `description`     | string   | long-form                              |
| `is_destructive`  | boolean  | mirrors MCP `destructiveHint`          |
| `is_idempotent`   | boolean  | mirrors MCP `idempotentHint`           |
| `is_read_only`    | boolean  | mirrors MCP `readOnlyHint`             |
| `opens_world`     | boolean  | mirrors MCP `openWorldHint`            |
| `task_support`    | string[] | mirrors MCP `taskSupport`              |
| `auth_scheme_ids` | string[] | refs to `auth_scheme` nodes            |
| `deprecated`      | boolean  |                                        |

## Edge kinds (9)

All typed, all in `edges` table.

| Kind              | From                | To              | Provenance?        |
|-------------------|---------------------|-----------------|--------------------|
| `exposes`         | product             | surface         | no (structural)    |
| `has_operation`   | surface             | operation       | no (structural)    |
| `has_parameter`   | operation           | parameter       | no (structural)    |
| `returns`         | operation           | response_shape  | no (structural)    |
| `acts_on`         | operation           | resource        | **yes** (derived)  |
| `auth_requires`   | operation           | auth_scheme     | yes                |
| `documented_by`   | operation/resource  | doc_page        | yes                |
| `illustrated_by`  | operation           | example         | yes                |
| `same_capability` | operation           | operation       | **yes** (LLM)      |

Structural edges are implied by the source (a parameter in OpenAPI
necessarily belongs to an operation). Derived edges cross surfaces or
assert semantics beyond what the source literally says and must record
rationale + source_id.

## Claim table (per-field provenance)

```
claims (id PK, node_id FK, field, value_json, source_id FK, extractor,
        extracted_at, span_start, span_end, span_path, confidence,
        chosen, rejection_rationale)
```

- One row per extracted value. Multiple rows for the same `(node_id,
  field)` when sources conflict; exactly one has `chosen = 1`.
- `confidence`: `attested` | `derived` | `inferred` | `conflicted`.
- `span_path` is JSONPath or XPath into the source — used by the review
  UI to jump to the exact line in the original spec.

## Overrides

```
overrides (id PK, node_id FK, field, value_json, rationale, authored_by,
           authored_at, supersedes, active)
```

- `rationale` is `NOT NULL` — the merge engine rejects silent overrides.
- `supersedes` tracks edit history without deletion.
- Active overrides beat any claim, regardless of confidence.

## Sources

```
sources (id PK, surface, url, content_type, fetched_at, bytes, cache_path)
```

- `id` is sha256 of bytes; content-addressable.
- `cache_path` points into `.skillship/sources/`.
- Same URL fetched twice with identical bytes = one row (idempotent).

## Releases and snapshots

```
releases        (id PK, product_id, tag, released_at)
release_sources (release_id, source_id)
snapshots       (id PK, path, node_count, edge_count, reason)
```

- Releases pin a set of sources for reproducible rebuilds (think
  `release-please` per skill).
- Snapshots are on-disk copies of the whole graph for pre/post-refresh
  diffing.

## TypeScript types → tables

| TS type              | Rows in                                    |
|----------------------|--------------------------------------------|
| `ProductNode`        | `nodes` (1) + `claims` (N per field)       |
| `SurfaceNode`        | `nodes` (1) + `claims`                     |
| `OperationNode`      | `nodes` (1) + `claims`                     |
| `ParameterNode`      | `nodes` (1) + `claims`                     |
| `ResponseShapeNode`  | `nodes` (1) + `claims`                     |
| `ResourceNode`       | `nodes` (1) + `claims`                     |
| `AuthSchemeNode`     | `nodes` (1) + `claims`                     |
| `ExampleNode`        | `nodes` (1) + `claims`                     |
| `DocPageNode`        | `nodes` (1) + `claims`                     |
| `OverrideNoteNode`   | `overrides` (1)                            |
| `SourceNode`         | `sources` (1)                              |
| `ReleaseNode`        | `releases` (1) + `release_sources` (N)     |
| `Edge`               | `edges` (1)                                |
| `Claim<T>`           | `claims` (1)                               |
| `ConflictedClaim<T>` | `claims` (1 chosen + N rejected)           |

No content lives on the node row itself except `kind`, `parent_id`, and
timestamps. Every semantic value goes through `claims` for provenance.
