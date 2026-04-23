# Skillship evaluation harness

Quantitative eval for `skillship build` output. Answers: **for this vendor, how
well does the generated bundle cover real tasks, stay grounded in source bytes,
and conform to the Agent-Skill spec?**

## What it measures (per vendor)

| Score | Scorer | Question |
|---|---|---|
| **coverage** | `scoreCoverage` | Of the operations a canonical task set needs, how many are present as operation nodes in the graph? |
| **grounding** | `scoreGrounding` | Sampling N claims, do they all resolve to a source row + source bytes on disk? (provenance integrity) |
| **format** | `scoreFormat` | Does the `SKILL.md` pass Anthropic's `quick_validate.py`? |
| **op-count-min** | (inline) | Did `ingestConfig` produce ≥ `expected.ops_min` operations overall? |

Out of scope here (suggested follow-ups):
- **task-success rate** — requires a live agent. Pipe `SKILL.md` +
  generated artifacts to Claude, run each task in `eval/tasks/*.yaml`,
  score completion. Needs an API key and a runner.
- **baseline A/B** — hand-written skill (e.g.
  `vendor/anthropic-skills/skills/skill-creator`) or raw-docs dump as a
  third arm. Framework-ready via `vendors.expected.baseline_path`.
- **token efficiency** — tokens-in ÷ successful-task-completion.

## Layout

```
eval/
  vendors.yaml            # 5 vendors + expected surfaces/ops_min
  tasks/<vendor>.yaml     # task templates with expected_ops
  scorers.ts              # pure scoring functions
  run.ts                  # harness runner; writes eval/out/report.json
  projects/<vendor>/      # per-vendor .skillship project (NOT committed)
  out/report.json         # generated report (NOT committed)
```

## Running it

### 1. Seed vendor projects

For each vendor, produce a `.skillship/` directory by running
`skillship init` against the real domain:

```bash
npm run build
node dist/cli/index.js init \
  --domain supabase.com \
  --github supabase \
  --out eval/projects/supabase
```

Repeat for stripe, vercel, linear, anthropic. (This makes real HTTP
calls and writes `eval/projects/<id>/.skillship/{config.yaml,sources/}`.)

### 2. Run the harness

```bash
npm run eval
```

Vendors without a seeded project are reported as `skipped` with the
exact init command needed. Seeded vendors are scored end-to-end.

Output: `eval/out/report.json` and a one-line-per-vendor summary:

```
[ok]   supabase: cov=87% grd=100% fmt=pass ops=132/100
[ok]   stripe:   cov=95% grd=100% fmt=pass ops=521/400
[skip] vercel:   missing .../.skillship/config.yaml — run `skillship init ...`
```

### 3. Interpret

- **coverage < 80%** → tasks the skill cannot perform without agent
  guessing. Dig into `report.vendors[].coverage.misses` for the
  specific `{method, path}` pairs missing from the graph.
- **grounding < 100%** → a claim points to a source the system can't
  find. This should never happen in a clean run; treat as a bug.
- **format fail** → SKILL.md doesn't conform to the Agent-Skill spec.
- **op-count-min fail** → ingestion found too few operations; likely
  cause is an extractor not firing on a signal that's actually present
  (check `report.vendors[].ingest.errors` after extending the runner
  to surface them).

## Adding a vendor

1. Append an entry to `eval/vendors.yaml`.
2. Add `eval/tasks/<id>.yaml` with ~5 representative tasks (goal +
   `expected_ops` of `{method, path}` pairs).
3. Run `skillship init --domain <domain> --out eval/projects/<id>`.
4. `npm run eval`.

`expected_ops.path` should match the graph's `path_or_name` claim
exactly (OpenAPI uses the raw template path like `/v1/projects/{id}`;
MCP uses the tool name; CLI uses the command path).

## Extending the harness

- **LLM-as-judge for task completion:** add a scorer that hits the
  Anthropic API with `system=SKILL.md contents` + `user=task.goal`,
  runs the returned plan in a sandbox, and checks the observed calls
  against `expected_ops`. Respect `ANTHROPIC_API_KEY`.
- **Baseline diff:** when `baseline_path` is set, compute the set
  difference of operations surfaced by the hand-written skill vs.
  Skillship's output.
- **Trend tracking:** commit `out/report.json` under `out/history/<date>.json`
  and diff weekly — catches upstream spec drift and extractor regressions.
