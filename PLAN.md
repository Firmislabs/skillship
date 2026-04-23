# Skillship — Implementation Plan

## What it is

Skillship ingests the agent-facing signals a SaaS vendor already publishes
(llms.txt, OpenAPI, CLI specs, MCP tool definitions, SDK specs, docs sitemap)
and continuously generates + maintains agent-onboarding artifacts:
SKILL.md, `.mcp.json`, llms.txt bundles.

The unit of output is a **plugin bundle** (Cloudflare / Supabase / OpenCLI shape), not a lone SKILL.md.
The unit of truth is a **capability graph** (SQLite) with per-claim provenance
and author overrides.

## Why build it (evidence, as of 2026-04-22)

- Skills-repo pattern is <6 months old and still growing.
  Cloudflare 1.2k★, Supabase 2k★, Amplitude 96★, Notion 76★, Shopify 26★,
  PostHog 25★ — all pushed within 2 weeks of today.
- Cloudflare found 18 factual errors in one weekly skills review on 2026-04-01.
  Drift is a real operational cost.
- Anthropic's own `cc-skill-sync` bot is dormant after 2 PRs.
  Nobody has solved automated skill maintenance.
- 12/15 surveyed vendors ship `llms.txt`; 8/15 expose MCP; 5/15 ship skills repos.
  The signals exist — nobody aggregates them.

## Non-goals (explicit)

- Not a hosted service
- Not a marketplace
- Not a new skill schema — use Anthropic's strict allowlist verbatim
- No MCP-server codegen in v1 (config only)
- No auto-merge
- No telemetry
- Not targeting Tier-3 vendors (Segment, Airtable, Intercom — docs-scraper territory)

## MVP target vendor: Supabase

Richest signal mix we found: 3 OpenAPI specs, 157 KB CLI openref YAML, real
MCP with Zod tool defs in `supabase-community/supabase-mcp`, `llms.txt` plus
13 per-product bundles, and an active hand-written skills repo
(`supabase/agent-skills`) to compare against.

If skillship can't produce a SKILL.md that matches the 80/20 of
`supabase/agent-skills`, the premise is wrong.

## Phased plan (~1-week MVP, 7 phases)

### Phase 1 — Foundation
- TypeScript project, strict tsconfig, Vitest
- Deps: `better-sqlite3`, `commander`, `zod`, `yaml`, `@anthropic-ai/sdk`,
  `openapi-types`, `xml2js`, `ts-morph`
- Graph types from `src/graph/types.ts`
- SQLite DDL + migration runner (`src/graph/schema.sql`)
- Content-addressable source store (`.skillship/sources/` keyed by sha256)
- **Acceptance:** `npm test` green; Product/Surface/Operation CRUD round-trip via SQLite.

### Phase 2 — Discovery
- `skillship init --domain <url> [--github <org>]` CLI command
- Crawler:
  - `/llms.txt` + content-type sniff (`text/plain|markdown` AND first line starts with `#`)
  - `/sitemap.xml`, `/docs/sitemap.xml`
  - `mcp.<domain>.com` + `/.well-known/oauth-protected-resource/mcp`
  - If `--github` given: list repos, heuristic-match openapi / cli / mcp / sdk repos
- Write `.skillship/config.yaml` with locked source URLs + content hashes
- Emit coverage score (bronze/silver/gold) from signal count
- **Acceptance:** `skillship init --domain supabase.com --github supabase`
  produces config with ≥10 sources, GOLD coverage.

### Phase 3 — Extractors
One parser per source kind. Every claim writes to `claims` table with provenance.
- OpenAPI 3.x → Operation, Parameter, ResponseShape, AuthScheme
- Swagger 2.0 → 3.x converter for GoTrue
- openref-CLI YAML → Operation(surface=cli)
- openref-SDK YAML → Operation(surface=sdk) (defer `$ref` resolution to v2)
- Sitemap → DocPage nodes with `lastmod`
- Docs `.md` fetcher (guide-only, content-type enforced)
- llms.txt parser → DocPage ordering + `tier: core|optional`
- MCP OAuth well-known → AuthScheme
- Zod-AST extractor for MCP tools (ts-morph) → Operation(surface=mcp) with ToolAnnotations
- **Acceptance:** Supabase graph contains ≥160 operations across all surfaces;
  every claim resolves back to a byte range in a named source.

### Phase 4 — View projection (no LLM)
- `skillship build` command
- Graph → SKILL.md (frontmatter strict allowlist + surface list + op index)
- Graph → `.mcp.json` from Surface(kind=mcp) + AuthScheme
- Graph → `llms.txt` (core) + `llms-full.txt` (core + optional)
- Output shape: plugin bundle in `dist/`
- **Acceptance:** `skillship build` output passes Anthropic's `quick_validate.py`.

### Phase 5 — LLM enrichment
- Anthropic SDK wiring (user's own API key, no hosted service)
- 5 scoped LLM passes, each grounded in specific evidence, writes confidence-scored claims:
  1. Activation triggers (from SDK symbols + docs H1s)
  2. Cross-surface routing (CLI AI-agent notes, MCP descriptions, comparison docs)
  3. Anti-patterns (docs "warning"/"caution"/"do not" + vendor issue trackers)
  4. Workflow synthesis (quickstart + tutorial sequences)
  5. Error-recovery mapping (OpenAPI responses + troubleshooting pages)
- Budget: ≤ $5 per vendor per rebuild
- **Acceptance:** Supabase skill contains ≥5 cross-surface routing claims at
  MEDIUM/HIGH confidence, all evidence URLs resolvable.

### Phase 6 — Review CLI
- `skillship review` command (interactive CLI; web UI is stretch)
- Groups claims by section; batch-accept HIGH; prompt on MEDIUM; block on LOW
- Evidence click-through (opens URL in `$BROWSER`)
- Writes `OverrideNote` rows on edit/reject
- `--batch` flag auto-accepts HIGH only (for CI)
- **Acceptance:** First-time Supabase review ≤20 min;
  regenerate after induced source-hash change shows only drifted sections.

### Phase 7 — GitHub Action
- `skillship/action` repo, composite action
- Triggers: `push` to openapi/changelog paths, `release.published`, daily schedule
- Steps: install skillship → rebuild → diff → open PR if drift
- Overrides preserved
- **Acceptance:** On a test fork with induced CLI-spec change, PR appears with
  only drifted sections + confidence scores.

## Stretch (post-MVP)

- Web review UI (currently CLI)
- Capability hub nodes if >3 vendors demand cross-skill queries
- Workflow as first-class node (currently render-time-only)
- Example validation in sandbox (execute, capture, gate)
- Coverage-score vendor dashboard

## Success gates (don't ship until)

1. `skillship init → build` produces a Supabase skill a non-authoring reviewer can understand
2. Drift detection catches 18/18 of the Cloudflare 2026-04-01 errors when run
   against the pre-fix state
3. Cost per vendor per rebuild < $5 in LLM calls
4. Review takes < 20 min first time, < 5 min on regen

## Session handoff

Per CLAUDE.md: "Fresh session after planning — don't implement in planning context."

- **This session:** scaffold + plan (you are here)
- **Fresh session 1:** phase 1–2 (foundation + discovery)
- **Fresh session 2:** phase 3–4 (extractors + rendering)
- **Fresh session 3:** phase 5–6 (LLM + review)
- **Fresh session 4:** phase 7 (GitHub Action + polish)

Every phase's fresh session should load:
1. `PLAN.md` (this file)
2. `docs/ARCHITECTURE.md`
3. `docs/SCHEMA.md`
4. `src/graph/types.ts`
5. `src/graph/schema.sql`

Conversation state lives in git commits; durable context lives in these five files.
