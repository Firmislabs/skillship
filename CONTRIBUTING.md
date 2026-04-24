# Contributing to skillship

Thanks for the interest. PRs welcome.

## Dev loop (after forking)

```bash
# 1. Fork on GitHub, then clone your fork:
git clone https://github.com/YOUR_USERNAME/skillship.git
cd skillship

# 2. Use the pinned Node version (see .nvmrc):
nvm use          # Node 20

# 3. Install + verify:
npm install
npm test         # 359 tests should pass
npm run typecheck

# 4. Build and link for local CLI use:
npm run build
npm link         # makes `skillship` available in your PATH

# 5. Try it end-to-end:
skillship init --domain https://supabase.com --github supabase
skillship build --in . --out /tmp/skills
ls /tmp/skills
```

`npm link` is the fastest way to iterate; re-running `npm run build` after a
code change updates the linked binary.

## Running the eval

The eval harness compares generated skills against canonical task sets and
against hand-authored community skills.

```bash
npm run eval           # writes eval/out/report.json
npm run eval:compare   # writes comparison table to stdout
```

Both fetch vendor specs the first time they run (cached in
`eval/projects/<vendor>/.skillship/sources/`). Re-runs are offline.

## TDD

Test-first, per [coding standards](#coding-standards):

```bash
npm run test:watch     # vitest, re-runs on save
```

Write the failing test, watch it go red, write the minimum code to make it
green, refactor. Small, scoped PRs are easier to review.

## Coding standards

- TypeScript strict mode, `exactOptionalPropertyTypes` on.
- No `any`. Explicit return types on exported functions.
- Functional style where reasonable; avoid mutable shared state.
- Max ~50 lines per function, ~300 lines per file (soft targets).
- Run `npm run typecheck && npm test` before opening a PR.

## Opening a PR

- Branch off `main`.
- Keep the PR scoped to one logical change. Unrelated refactors belong in
  their own PR.
- CI runs typecheck + tests on every PR; both must be green to merge.
- Use conventional-commits style in the title when natural (`feat:`, `fix:`,
  `docs:`, `refactor:`, `chore:`).

## What to work on

- Issues tagged [`good first issue`](https://github.com/firmislabs/skillship/labels/good%20first%20issue).
- Additional extractors (e.g. AsyncAPI, Protobuf).
- GraphQL: model field arguments as proper parameter child nodes (currently
  the main gap on density for GraphQL-first vendors like Linear).
- Any of the open items listed under **Status** in the README.

Questions? Open an issue — a short reproducible example beats a long bug
report.
