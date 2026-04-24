# skillship

Ingest the agent-facing signals a SaaS vendor already publishes (llms.txt,
OpenAPI, CLI specs, MCP tools, SDK specs, docs sitemap) and continuously
generate + maintain agent-onboarding artifacts (SKILL.md, `.mcp.json`,
llms.txt bundles) with provenance-per-claim and human-reviewable overrides.

OSS. No hosted service. No telemetry. Use your own Anthropic API key.

## Status

Pre-alpha. Schema locked. Implementation not started.

- [PLAN.md](PLAN.md) — phased implementation plan + acceptance criteria
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — graph model, lifecycle, provenance
- [docs/SCHEMA.md](docs/SCHEMA.md) — node + edge types, SQLite DDL mapping
- [src/graph/types.ts](src/graph/types.ts) — TypeScript types
- [src/graph/schema.sql](src/graph/schema.sql) — SQLite DDL

## Target UX

```
npx skillship init --domain supabase.com --github supabase
#  → discovers 11/12 signals, writes .skillship/config.yaml, GOLD coverage

npx skillship build
#  → dist/{manifest.json, .mcp.json, skills/*, llms.txt, llms-full.txt}

npx skillship review
#  → interactive triage of medium/low-confidence claims

npx skillship refresh
#  → diffs sources, re-runs enrichment only for drifted sections
```

## Continuous updates

Generated skills are **committed source** in your repo. A scheduled workflow
re-runs `init` + `build` and opens a PR when anything changed; humans review
the diff and merge. No semver, no tags — git history is the audit trail. This
mirrors how Anthropic maintains its own skills repos.

Copy-paste template: [examples/github-actions/update-skills.yml](examples/github-actions/update-skills.yml)
Setup + review playbook: [examples/github-actions/README.md](examples/github-actions/README.md)

## License

MIT (pending).
