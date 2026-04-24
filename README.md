# skillship

**Generate and maintain Claude skills from the signals a SaaS vendor already
publishes.** Point it at a domain + GitHub org; it ingests `llms.txt`,
OpenAPI specs, GraphQL SDLs, MCP tool catalogs, and docs into a
content-addressed graph, then renders `SKILL.md`, `references/*.md`,
`.mcp.json`, and `llms.txt` with per-claim provenance.

OSS. No hosted service. No telemetry. Your API key, your machine.

## Why

Hand-authored Claude skills go stale the moment an API changes, and most
teams don't have the bandwidth to hand-curate 100+ endpoints. skillship
generates from the vendor's own source of truth and re-generates on a
schedule — human review via PR, git history as the audit trail.

Evaluated against community-maintained hand-authored skills from
`majiayu000/claude-skill-registry` and `davepoon/buildwithclaude`:

| vendor   | generated (ours) | hand-authored | density (ours) | density (theirs) | freshness (ours) | freshness (theirs) |
|----------|:----------------:|:-------------:|:--------------:|:----------------:|:----------------:|:------------------:|
| stripe   |     **87%**      |      38%      |     100%       |        44%       |      100%        |         0%         |
| supabase |     **88%**      |      43%      |     100%       |       100%       |      100%        |         0%         |
| vercel   |     **90%**      |      43%      |     100%       |       100%       |      100%        |         0%         |
| linear   |     **63%**      |      46%      |      38%       |       100%       |      100%        |         0%         |
| gitea    |     **88%**      |      41%      |     100%       |        56%       |      100%        |         0%         |
| posthog  |     **88%**      |      46%      |     100%       |       100%       |      100%        |         0%         |

Composite score across 5 dimensions (structure, density, freshness, schema
fidelity, coverage). Freshness is 0% for hand-authored because they carry no
`generated_at` and go stale silently; skillship stamps every rebuild.

Reproduce: `npm install && npm run eval:compare`.

See [eval/README.md](eval/README.md) for scorer definitions and methodology.

## Quickstart

```bash
npx skillship init --domain https://supabase.com --github supabase
# → crawls domain, probes for llms.txt / OpenAPI / GraphQL,
#   scans the GitHub org for spec repos, writes .skillship/config.yaml

npx skillship build --in . --out skills
# → skills/{supabase.com/SKILL.md, .mcp.json, llms.txt, llms-full.txt,
#           references/op_<id>.md for every detected operation}
```

That's the whole loop. The generated `skills/` directory is what Claude
consumes; commit it to your repo.

Works offline against content-addressed sources cached in
`.skillship/sources/` — the ingest graph is deterministic from
`.skillship/config.yaml` + those bytes.

## Continuous updates

Generated skills are committed source in your repo, same as code. A
scheduled GitHub Action re-runs `init` + `build` and opens a PR when
anything changed; humans review the diff and merge. No semver, no tags —
git history is the audit trail. This mirrors how
[`anthropics/skills`](https://github.com/anthropics/skills) is maintained.

Copy-paste template: [examples/github-actions/update-skills.yml](examples/github-actions/update-skills.yml)
Setup + review playbook: [examples/github-actions/README.md](examples/github-actions/README.md)

## How it works

```
vendor signals               content-addressed graph           rendered artifacts
─────────────────            ──────────────────────           ──────────────────
llms.txt          ──┐                                      ┌─→ SKILL.md
OpenAPI           ──┤                                      ├─→ references/op_*.md
Swagger 2         ──┼─→  sources (sha256) ──→ nodes, ──────┼─→ .mcp.json
GraphQL SDL       ──┤    extractors         claims,        ├─→ llms.txt
sitemap           ──┤                        edges         └─→ llms-full.txt
MCP tool catalog  ──┤                       (SQLite)
GitHub repo scan  ──┘                         │
                                              └─→ human overlays
                                                  (.skillship/overlays/)
```

Every claim carries provenance (`source_id` + `span_path`) and a confidence
tier (`attested` / `derived` / `inferred` / `conflicted`). Overlays are
human-reviewed overrides that win on conflict.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/SCHEMA.md](docs/SCHEMA.md) for the graph model.

## Status

What works:
- Extractors: OpenAPI 3, Swagger 2, GraphQL SDL, `llms.txt`, docs markdown,
  sitemap.xml, MCP tool catalogs (via source scan).
- Discovery: domain crawler, GitHub org scanner, Stainless SDK spec
  resolver, auth-doc link follower.
- Renderers: SKILL.md, per-op references, `.mcp.json`, `llms.txt`,
  `llms-full.txt`, manifest.
- 359 tests, 42 test files. `npm test` and `npm run eval` both green.

Known limitations:
- GraphQL arguments render as a flat param list, not as individual
  parameter nodes — this is why `linear` density is 38% vs 100% for the
  others (tracked; not a blocker for use).
- No `skillship review` / `skillship refresh` subcommands yet; `init`
  re-crawls every run, which is fine for small-to-medium vendor spec sets.

## License

MIT — see [LICENSE](LICENSE).
