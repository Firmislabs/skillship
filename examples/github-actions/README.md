# Continuous skill updates via GitHub Actions

Keep your committed `skills/` directory in sync with a vendor's live API/docs.
Runs on a schedule, opens a PR when anything changed, stays silent otherwise.

## Model

Generated skills are **committed source** in your repo, same as code. Every
refresh is a PR. Humans review the diff and merge. No semver, no tags — git
history is the audit trail.

This mirrors how [`anthropics/skills`](https://github.com/anthropics/skills) and
[`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)
are maintained today: PR-driven commits, no version bumps.

## Setup (one time, locally)

```bash
# In your product repo:
npm install -g github:firmislabs/skillship
skillship init --domain https://your-vendor.com --github your-vendor
skillship build --in . --out skills

git add .skillship/config.yaml skills/
git commit -m "chore(skills): initial generation"
```

Review the output. If it looks right, move on. If not, edit
`.skillship/overlays/` (human overrides — preserved across rebuilds) or file a
skillship issue.

## Install the workflow

```bash
mkdir -p .github/workflows
cp path/to/skillship/examples/github-actions/update-skills.yml \
   .github/workflows/update-skills.yml
```

Edit the `SKILLSHIP_DOMAIN` and `SKILLSHIP_GITHUB_ORG` env vars in the
workflow to match the args you used in `skillship init`.

Commit and push. The workflow will run on the next scheduled tick (or trigger
manually via the Actions tab → Update skills → Run workflow).

## What gets committed vs. regenerated

| Path | Git | Why |
|------|-----|-----|
| `skills/` | committed | the output agents consume |
| `.skillship/config.yaml` | committed | discovered sources (changes = meaningful) |
| `.skillship/overlays/` | committed | your human overrides |
| `.skillship/sources/` | gitignored | content-addressed raw fetches (cheap to regen) |
| `.skillship/graph.sqlite` | gitignored | derived from sources + config |

## Reviewing a refresh PR

Look for these change classes in the diff:

- **Removed operations.** Vendor deprecated an endpoint. Check whether your
  callers are migrated before merging.
- **Auth scheme changes.** Tokens, scopes, or OAuth flows shifted. Usually
  worth a closer read.
- **Large rewrites of a single op reference.** Often a docs rewrite upstream.
  Spot-check for factual drift before rubber-stamping.
- **Net additions.** New endpoints appearing is the common case. Skim for
  reasonableness and merge.

## Opt-out / pause

Dismiss the PR to skip one cycle; the next scheduled run will re-open it with
the current diff. Disable the workflow in the Actions tab to pause
indefinitely.
