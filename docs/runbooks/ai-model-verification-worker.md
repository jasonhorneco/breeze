# Model discovery and verification workers

Model listing remains on the global `ai-model-discovery` queue. SDK-backed
offering verification uses `ai-model-verification` on the API/socket-owning role.
The verification harness still uses its existing inert surface stubs and
deny-all tool proxy; this placement does not authorize endpoint commands.

The split keeps executable SDK/tool imports out of global workers without
duplicating tool declarations or reducing the surfaces being verified. The
worker import-closure contract applies unchanged to discovery.

## Requests and resource limits

The existing Verify endpoint still returns 202 with the connection/offering IDs.
Clients read the persisted offering verdict; they do not consume a BullMQ job's
return value. Existing producer imports remain compatible.

Queue payloads contain only offering ID, partner ID, type and the optional
bootstrap retry flag. Verification reloads and authorizes the offering using
those IDs. Manual requests get one attempt; the existing environment bootstrap
gets three with a 60-second exponential backoff. Connection rotation may cause
the existing one-time recheck; a newer verdict alone does not.

Both worker concurrency and Redis queue-wide concurrency are one. An API worker
does not start if it cannot establish that global cap. Adding API replicas must
not multiply concurrent SDK sessions.

## Upgrade and rollback

Old `verify-offering` jobs in the discovery queue delegate into the new queue;
they never run the SDK in a global worker. The handoff preserves the remaining
attempt budget and retains terminal target jobs so retrying a handoff does not
repeat inference. A later explicit Verify request can replace a terminal target
as before. The legacy job's result is a handoff status, not the model verdict.

Before an upgrade, record waiting, delayed, active and failed verification jobs
in both queues using authorized administration tooling. Drain active verification
before changing versions. Do not drop jobs, reset attempts or replay terminal jobs
as part of deployment. Listing schedules remain unchanged.

For rollback, stop new verification admission, drain or park pending work in the
new queue, and retain Redis records and persisted verdicts. The old release does
not consume `ai-model-verification`; do not assume reverting its image migrates
that queue. Reconcile requests by offering and verdict before explicitly moving
any pending request back. Keep at most one execution consumer for each request.
No database migration is required for this split.

## Qualification

Worker tests cover role placement, the full global import closure, queue-wide
concurrency, request deduplication, legacy handoff/retry budgets, expected-failure
classification and sanitized results. Existing verification, surface stub,
harness, route and bootstrap tests remain required. These mocked regressions
neither spend model tokens nor establish production acceptance.
