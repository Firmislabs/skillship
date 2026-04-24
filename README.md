# skillship

> Generate and maintain Claude skills from a SaaS vendor's own API signals.

[![CI](https://github.com/firmislabs/skillship/actions/workflows/ci.yml/badge.svg)](https://github.com/firmislabs/skillship/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)
[![GitHub stars](https://img.shields.io/github/stars/firmislabs/skillship?style=social)](https://github.com/firmislabs/skillship/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Point it at a domain + GitHub org. It ingests `llms.txt`, OpenAPI, GraphQL
SDL, MCP catalogs, docs, and sitemaps into a content-addressed graph, then
renders `SKILL.md`, per-op references, `.mcp.json`, and `llms.txt` — with
per-claim provenance. Re-runs produce a git diff you can review as a PR.

OSS, MIT, no telemetry, no hosted service. Your API key, your machine.

## Quick start

Run without cloning — npx installs straight from GitHub:

```bash
npx github:firmislabs/skillship init --domain https://supabase.com --github supabase
npx github:firmislabs/skillship build --in . --out skills

ls skills/supabase.com/
# SKILL.md  references/  .mcp.json  llms.txt  llms-full.txt
```

Commit `skills/` to your repo — it's what Claude consumes.

<details>
<summary><strong>Install globally (skip npx on every call)</strong></summary>

```bash
npm install -g github:firmislabs/skillship
skillship init --domain https://supabase.com --github supabase
skillship build --in . --out skills
```
</details>

<details>
<summary><strong>Fork and run from source (to contribute)</strong></summary>

```bash
# 1. Click "Fork" on GitHub, then clone your fork:
git clone https://github.com/YOUR_USERNAME/skillship.git
cd skillship

# 2. Use pinned Node, install, build, link:
nvm use            # Node 20 from .nvmrc
npm install        # auto-builds via `prepare` script
npm link           # exposes `skillship` from your local build
npm test           # 359 tests should pass

# 3. Try it:
skillship init --domain https://supabase.com --github supabase
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev loop and PR
conventions.
</details>

<details>
<summary><strong>Use with different vendors</strong></summary>

skillship auto-discovers whatever a vendor publishes. It works out of the
box against vendors in our eval set (stripe, supabase, vercel, linear,
gitea, posthog, anthropic, n8n, directus) and should handle anything with
a discoverable OpenAPI spec, GraphQL SDL, or `llms.txt`.

```bash
# GraphQL-first (Linear)
skillship init --domain https://linear.app --github linear

# REST + OpenAPI (Stripe)
skillship init --domain https://stripe.com --github stripe

# Docs-only / sitemap fallback
skillship init --domain https://example.com
```

Coverage tier is reported at the end of `skillship init` (bronze / silver /
gold) based on how many signals were found.
</details>

## What it generates

Per detected operation, a reference file embedded in the skill:

````markdown
# POST /v1/projects

Create a project.

## Parameters
| Name | In | Type | Required | Description |
|---|---|---|---|---|
| name | body | string | yes | Project name |
| region | body | string (us-east-1\|us-west-2\|eu-west-1) | yes | … |

## Request Example
```json
{ "name": "my-app", "region": "us-east-1" }
```

## Response Example
```json
{ "id": "proj_abc", "status": "ACTIVE_HEALTHY" }
```
````

Every field carries provenance back to the source byte offset it came from.
Conflicts between sources surface as `conflicted` claims, not silent drops.

## How it compares

Evaluated against community hand-authored skills from
[`majiayu000/claude-skill-registry`](https://github.com/majiayu000/claude-skill-registry)
and [`davepoon/buildwithclaude`](https://github.com/davepoon/buildwithclaude):

| vendor   | composite (ours) | composite (theirs) | density (ours) | density (theirs) | freshness (ours) | freshness (theirs) |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|
| stripe   | **87%** | 38% | 100% |  44% | 100% | 0% |
| supabase | **88%** | 43% | 100% | 100% | 100% | 0% |
| vercel   | **90%** | 43% | 100% | 100% | 100% | 0% |
| linear   | **63%** | 46% |  38% | 100% | 100% | 0% |
| gitea    | **88%** | 41% | 100% |  56% | 100% | 0% |
| posthog  | **88%** | 46% | 100% | 100% | 100% | 0% |

Composite is the mean across 5 dimensions: structure, density, freshness,
schema fidelity, coverage. Freshness is 0% for hand-authored because they
carry no `generated_at` stamp and go stale silently; skillship stamps every
rebuild.

Reproduce: `git clone ... && npm install && npm run eval:compare`. See
[eval/README.md](eval/README.md) for scorer definitions.

## Continuous updates

Commit generated skills to your repo, same as code. A scheduled GitHub
Action re-runs `skillship init + build` and opens a PR when anything
changed; humans review the diff and merge. No semver, no tags — git history
is the audit trail. This mirrors how
[`anthropics/skills`](https://github.com/anthropics/skills) is maintained.

- Copy-paste workflow: [examples/github-actions/update-skills.yml](examples/github-actions/update-skills.yml)
- Setup + review playbook: [examples/github-actions/README.md](examples/github-actions/README.md)

## How it works

```
vendor signals               content-addressed graph        rendered artifacts
─────────────────            ──────────────────────        ──────────────────
llms.txt          ──┐                                   ┌─→ SKILL.md
OpenAPI / Swagger ──┤                                   ├─→ references/op_*.md
GraphQL SDL       ──┼─→  sources (sha256) ──→ nodes, ───┼─→ .mcp.json
sitemap / docs    ──┤    extractors         claims,     ├─→ llms.txt
MCP tool catalog  ──┤                        edges      └─→ llms-full.txt
GitHub repo scan  ──┘                       (SQLite)
                                              │
                                              └─→ human overlays
                                                  (.skillship/overlays/)
```

Every claim carries provenance (`source_id` + `span_path`) and a confidence
tier (`attested` / `derived` / `inferred` / `conflicted`). Overlays are
human-reviewed overrides that win on conflict.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/SCHEMA.md](docs/SCHEMA.md) for the graph model.

## Status

Works today:
- Extractors: OpenAPI 3, Swagger 2, GraphQL SDL, `llms.txt`, docs markdown,
  `sitemap.xml`, MCP tool catalogs.
- Discovery: domain crawler, GitHub org scanner, Stainless SDK spec
  resolver, auth-doc link follower.
- Renderers: `SKILL.md`, per-op references, `.mcp.json`, `llms.txt`,
  `llms-full.txt`, `manifest.json`.
- 359 tests, 42 test files; CI runs typecheck + tests on every PR.

Known gaps:
- GraphQL argument nodes are rendered as a flat list, not individual
  parameter children — why `linear` density is 38% vs 100% for others.
- `skillship review` / `skillship refresh` subcommands aren't implemented
  yet; `init` re-crawls every run (fine for most spec sets).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, TDD expectations,
and PR conventions.

## License

MIT — see [LICENSE](LICENSE).
