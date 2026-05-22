# SDK Golden Trees — review process

`sdk-minimal/` is a byte-identical lock of the R-SDK emit for
`tests/fixtures/openapi3/minimal.yaml`; `sdk-graphql-minimal/` for
`tests/fixtures/graphql/minimal.graphql`. Any change in those trees means
the SDK emitter behavior changed.

This README is a SIBLING of the golden tree dirs (not inside them) because the
generator wipes and rewrites the tree dirs on every regen (`rmSync` + atomic
rename via `renderSdkPackage`), and the lock test compares the trees
byte-for-byte — a README inside the tree would either be deleted on regen or
break the byte-identity comparison.

## How to regenerate

    npx tsx scripts/gen-sdk-goldens.mts

This overwrites both `sdk-minimal/` and `sdk-graphql-minimal/` from the same
render code path as `tests/renderers/sdk-golden.test.ts`.

## How to review a diff

When you regenerate and see a diff, sort the changes into three buckets:

1. **`src/*.ts` changes** — behavior changes. Read the test expectations in
   `tests/sdk-plugins/*.test.ts` first; if the diff matches an intentional
   plugin change, accept. If not, the plugin or renderer needs a fix.
2. **`package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `.npmignore`**
   — template changes. Confirm `src/renderers/sdk-templates/render.ts`
   substitution semantics didn't drift unexpectedly.
3. **Whitespace / formatting** — Prettier version bump or config change.
   Verify against `package.json` deps. Whitespace-only diffs should correlate
   with a Prettier upgrade commit; otherwise investigate.

Per spec §5.9 R2-4: do not "rubber-stamp" large diffs. Bisect by plugin if
the diff is large and unexpected.
