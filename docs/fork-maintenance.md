# Maintaining the home deployment fork

This fork keeps a small set of deployment-specific changes alongside upstream
Breeze. Prefer an upstream fix when it meets the same requirements; avoid
maintaining a second implementation of an upstream feature.

## Branches and releases

- `main` tracks upstream history. Do not develop deployment changes directly on it.
- `home/stable` records accepted deployment source. A web-only tag identifies
  frontend source; it does not claim that a new API image was deployed.
- `home/staging` collects the next batch of fixes. It can contain changes that
  are tested but have not been deployed.
- Use short-lived `fix/`, `feat/`, or `chore/` branches for individual changes.

Do not enable automatic production updates from upstream or from a moving branch.
Deploy immutable image identifiers and retain the previous identifiers and exact
deployment configuration for rollback.

## Batched update process

1. Log the observed problem, source evidence, impact and acceptance condition in
   the private operations backlog before starting implementation.
2. Compare the problem with current upstream fixes and their prerequisites.
3. Make a focused change, run appropriate tests, and qualify the built artifact
   in the isolated release lab. A passing unit test is not live acceptance.
4. Record the source commit, tests, image identifier, affected services and exact
   rollback. Keep credentials and deployment configuration outside this repo.
5. Deploy only the qualified services. Verify preserved configuration, runtime
   readiness and the actual user workflow. For appearance changes, inspect the
   live rendered page in each affected view.
6. Advance `home/stable` and add an annotated component/release tag only after
   acceptance. Merge accepted fixes into `home/staging` as well.

Before publishing branches, review the full custom history for private data.
Never publish environment files, credentials, raw model transcripts, private
receipts, database dumps or infrastructure inventories. Keep a single private
operations checklist and release ledger rather than copying those into Git.

## Current boundary

The administration contrast repair is accepted as a web-only update. Strict
`query_devices` argument validation is staged for the next API batch. The newer
upstream AI context/tool-profile work still needs its prerequisite changes and
qualification; this fork does not claim that it is already deployed.
