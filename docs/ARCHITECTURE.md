# Skillship Architecture

## One-paragraph pitch

Skillship turns a vendor's machine-facing surfaces (OpenAPI, CLI spec,
MCP manifest, SDK types, docs sitemap, llms.txt) into a typed capability
graph with per-claim provenance, then renders agent-onboarding artifacts
(SKILL.md, `.mcp.json`, llms.txt bundles) from that graph. The graph is
the source of truth; the artifacts are projections. When vendor specs
drift, skillship knows *which* artifacts to regenerate — not everything.

## Why a graph (and not one big SKILL.md)

A single SKILL.md can't answer the refresh question: "the vendor shipped
a new CLI version — which sections of my skill are now stale?" Answering
that requires typed edges between claims and the sources they came from.
That's the whole reason the graph exists.

Nine edge kinds suffice for every refresh scenario we modelled:

- `exposes` — product → surface
- `has_operation` — surface → operation
- `has_parameter` — operation → parameter
- `returns` — operation → response_shape
- `acts_on` — operation → resource
- `auth_requires` — operation → auth_scheme
- `documented_by` — operation | resource → doc_page
- `illustrated_by` — operation → example
- `same_capability` — operation ↔ operation (cross-surface alias)

## Node kinds (12)

`product`, `surface`, `operation`, `parameter`, `response_shape`,
`resource`, `auth_scheme`, `example`, `doc_page`, `override_note`,
`source`, `release`.

Field-by-field catalog: [SCHEMA.md](SCHEMA.md).

## Lifecycle

```
init → fetch → extract → merge → enrich → review → render → publish
                 ↑__________________________________________|
                                 refresh
```

### 1. `init`

`skillship init --domain <url> [--github <org>]` writes
`.skillship/config.yaml` listing the surfaces discovered. Discovery is
progressive:

- Domain alone: ~30% coverage (sitemap, llms.txt, robots, public
  OpenAPI guesses).
- Domain + GitHub org: ~90% coverage (CLI spec, SDK types, internal
  docs, release tags).

### 2. `fetch`

Every surface is fetched to `.skillship/sources/<sha256>.<ext>`. Sources
are content-addressable: the sha256 *is* the ID. Refetches that hit the
same hash short-circuit everything downstream.

### 3. `extract`

One extractor per surface kind:

- `openapi@3` — REST → operations, parameters, response shapes
- `swagger@2` — auto-converted to OpenAPI 3, then `openapi@3`
- `openref-cli@1` — Supabase-format CLI spec
- `openref-sdk@1` — Supabase-format SDK spec
- `sitemap@1` — docs URL discovery
- `llms-txt@1` — categorised doc index
- `mcp-well-known@1` — OAuth + tool manifest
- `zod-ast@1` — ts-morph-walked Zod schemas → MCP tool catalog

Extractors emit **claims**, not nodes. A claim is `(node_id, field,
value, source_id, span, confidence)`. The node shell and its parent
edges are created/updated as a side effect.

### 4. `merge`

For each `(node, field)`, pick one winning claim. Rules:

1. Active override wins (rationale required, persisted).
2. Higher-precedence source wins. Precedence is configurable but
   defaults to `openapi > openref-cli > openref-sdk > llms-txt > docs`.
3. Ties → `confidence: "conflicted"`, losers kept in `claims` with
   `rejection_rationale` so the review UI can show them.

### 5. `enrich` (LLM, scoped)

Five enrichment passes, each with a bounded prompt and budget:

1. Operation summaries — when extractor extracted only path+method.
2. Destructiveness labels — MCP ToolAnnotations where absent in source.
3. Example generation — language-specific, validated against schema.
4. Cross-surface `same_capability` edges — "CLI `deploy` ≡ REST `POST
   /functions`".
5. Narrative glue — the `## When to use` sections.

Budget cap: **$5 per vendor per rebuild**. Passes skipped when cap
exceeded; the affected claims retain `confidence: "inferred"` if they
already exist, or are left missing.

### 6. `review`

`skillship review` is an interactive TUI that walks `WHERE confidence
IN ('inferred','conflicted')` claims. Every accept, reject, or edit
becomes an `override_note` with rationale. Overrides persist across
rebuilds via `.skillship/overlays/*.yaml` and the mirror in
`overrides` table.

### 7. `render`

View projection — no LLM. Pure function from graph + overrides to an
output tree:

```
dist/
├── manifest.json              # vendor, version, source checksums
├── .mcp.json                  # MCP client config
├── skills/<product>/
│   ├── SKILL.md               # Anthropic allowlist frontmatter only
│   ├── references/            # per-operation / per-resource prose
│   │   ├── <op-1>.md
│   │   └── ...
│   └── _sections.md           # MOC linking references/
├── llms.txt                   # Howard/AnswerDotAI index format
└── llms-full.txt              # concatenated full-content bundle
```

### 8. `refresh`

Fetch all sources. For each source whose sha256 changed:

1. Find all claims with `source_id = <old>`.
2. Find all nodes with claims referencing this source.
3. Re-run the extractor on the new source bytes.
4. Re-run merge for affected `(node, field)` pairs only.
5. Re-run only the enrichment passes whose inputs changed.
6. Re-render.

This is why the graph exists. Without it, every vendor update is a
full regeneration + a full manual review.

## Provenance

Every field on every node carries a `Provenance` record:

| Field          | Meaning                                       |
|----------------|-----------------------------------------------|
| `source_id`    | sha256 of the source file                     |
| `source_url`   | where we got it                               |
| `surface`      | rest \| cli \| mcp \| sdk \| docs \| llms_txt |
| `extractor`    | `name@version`                                |
| `extracted_at` | ISO8601                                       |
| `span`         | byte offsets + JSONPath into source           |
| `confidence`   | attested \| derived \| inferred \| conflicted |

This is what makes the review UI navigable: every claim links back to
the exact byte range it came from. No black boxes.

## Overrides

Human decisions are first-class. `.skillship/overlays/*.yaml` files
look like OpenAPI Overlay Spec v1.0 documents but target our graph.
Every override requires a rationale — silent overrides are rejected by
the merge engine. The rationale is what makes overrides legible six
months later.

## Storage layout

- `.skillship/graph.sqlite` — live graph (schema:
  `src/graph/schema.sql`)
- `.skillship/snapshots/<ts>.sqlite` — point-in-time copies
- `.skillship/sources/<sha256>.<ext>` — raw bytes, content-addressable
- `.skillship/config.yaml` — user-editable, committed
- `.skillship/overlays/*.yaml` — user-editable, committed

Everything else is regenerable and gitignored.

## Invariants

- Sources are immutable. A new URL with different bytes = new source_id.
- Nodes never store field values directly. Values live in `claims`.
- Edges are typed. No free-form "related" links.
- Every override has a rationale.
- Every derived (LLM-inferred) claim has `confidence IN ('derived',
  'inferred')` and surfaces in `skillship review`.
