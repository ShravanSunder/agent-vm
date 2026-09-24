# Cloudflare Access and Hermes approval beta proof

Date: 2026-09-24. Branch: `investigate/sunclaw-oauth-access`. This is a continuation of the preserved [implementation handoff](2026-09-23-cloudflare-access-oauth-closeout/implementation-handoff.md), not a release or production qualification. The live beta observations below were made on `0c94820d`; review corrections were committed as `049daf60bbd6562ce47e4bc138de0364fbab285d`.

## Source findings and corrections

- Hermes already has an authenticated run API and `/v1/runs/{run_id}/approval`. Agent VM's Tool Portal presenter used Hermes clarify delivery, which has no HTTP response channel. The presenter now uses Hermes's existing run approval queue for API runs and retains clarify delivery for Discord. No controller approval route or upstream Hermes patch was added. A pinned-image test failed with `presenter-missing` before the correction, then passed approve and deny through Hermes's HTTP handler on a real local socket.
- Closed-field Portal diagnostics distinguish an initial `approval_required` item from an initial denied/error item without exporting arguments, identifiers or exception text. A separate presenter fix prevents an expired clarify challenge from becoming an unlimited wait in pinned Hermes.
- Pinned gogcli v0.38.1 requires `--force` for noninteractive Calendar event deletion. The compiled Google command catalog now requires that exact flag on `calendar.delete` only. The existing per-account Calendar Write Ask/Allow policy remains the decision authority. Its focused test failed before the correction and passed afterward.
- Public OAuth origin validation rejects normalized-away path and empty query/fragment markers before URL canonicalization.

## Real isolated beta observations

- Local tarball sync, beta build, static validation and a graceful restart succeeded. The controller, zone and Gateway ingress health probes each returned HTTP 200.
- A live authenticated Hermes HTTP run produced a Calendar Write Ask. `deny` resolved one pending approval and the exact synthetic event remained absent. A separate `once` resolved one pending approval; Google Calendar showed exactly one event. A separate approved delete removed it, and an exact-title search returned no events.
- A human-originated pulse-beta Discord DM produced the native Hermes Approve/Deny prompt for the same one-call Calendar Write policy. Approve created one different synthetic event, verified in Google Calendar. A distinct native Ask approved exact-event deletion; a refreshed Calendar search returned no events. Intermediate model calls with missing positional or unsupported command flags were typed `capability_denied` before dispatch, and exact-label absence was verified before corrected requests.
- The signed-in Access browser POSTed an inert invalid body to the public origin at the controller execute-command path and received HTTP 404. Access logout displayed success; reloading the account page required fresh Cloudflare/Google admission, which succeeded. The configured beta host was used; the older dotted handoff host is stale.
- After code commit `049daf60`, the isolated beta controller's first graceful stop returned HTTP 500 because exact Gateway VM destruction timed out after 60 seconds and retained `owner-unsafe` evidence. The owner authorized exact beta termination. The old installed CLI's offline cleanup then exited 0 without `--force` and reported complete ownership disposition. Local tarball sync, beta validation (15/15), image build, and restart succeeded. The new beta package pin and installed CLI matched the `049daf60` tarball, and controller, zone and Gateway service probes returned healthy HTTP 200. The earlier Calendar and browser journeys were not repeated on this commit; their success-path source was not changed by the review correction.

## Current verification and limits

The following commands ran on the scoped remediation worktree immediately before code commit `049daf60`. `pnpm check` is a build and static-quality gate; it does not run Vitest. The inventory command discovers gated E2E tests and its skips are not runtime proof.

| Gate | Result on the remediation source |
| --- | --- |
| `pnpm test:unit` | 407 files, 4,626 passed; exit 0 |
| `pnpm test:integration` | 80 files, 915 passed; exit 0 |
| `pnpm test:e2e:host` | 35 files, 233 passed; exit 0 |
| `pnpm test:e2e:inventory` | 6 passed, 53 skipped; exit 0; inventory only, including the gated presenter E2E |
| Pinned Hermes Python suite | 232 passed; exit 0 |
| Pinned-image presenter E2E | 1 passed; exit 0 |
| `pnpm check` | 16 passed, 0 failed; exit 0 |
| Built manual CLI host E2E | 1 passed; exit 0 |
| Hermes Python typecheck | Exit 1: 12 existing diagnostics in untouched files, none in the changed presenter or tests |

The independent different-lineage review of `0c94820d` returned `needs-revision`. Commit `049daf60` restores the identified route and authority tests, classifies JWKS key-resolution failures as temporarily unavailable, removes unrequested callback diagnostics, documents the Access session duration, and rejects a native Approve arriving after challenge expiry. Deliberately deleting the Access expiry guard made four restored integration tests fail; broadening person-scoped cancellation made two restored unit tests fail. Restoring the source made all six pass. A malformed or ambiguous JWKS test and the route's 503 test both failed before their production corrections and passed afterward.

The owner explicitly requested HTTP approve and deny through Hermes, so the API-run branch remains in scope. Pinned Hermes checks now cover a wrong bearer key returning 401 without resolving a pending approval. Hermes's gateway elicitation wait uses its configured approval timeout, 300 seconds by default; it does not accept a caller timeout on that path. Agent VM rejects any answer received after the Tool Portal challenge expires, but cannot cancel that upstream wait at the exact challenge deadline without an upstream-owned request identifier. The controller's default Tool Portal challenge lifetime is also 300 seconds. Closed-field approval diagnostics remain as operator observability; `calendar.delete --force` remains required because the pinned noninteractive CLI refuses deletion without it, and Calendar Write Ask/Allow still decides each call.

| Specification proof row | Current evidence and open boundary |
| --- | --- |
| V1 | Isolated beta Access/Google admission and account enrollment were observed on `0c94820d`. Another-user denial and phone readability were not observed. |
| V2 | Current config, signed assertion, JWKS, admission, and 403/503 behavior have focused unit/integration proof. A live Cloudflare JWKS outage was not induced. |
| V3 | Broker/catalog/policy integration and the beta Calendar Ask, deny, approve, create/read/delete cleanup journey were observed. |
| V4 | Beta logout required fresh Cloudflare/Google admission; callback and native POST paths were exercised. Local tests cover renewal, identity replacement, and expiry. Live provider expiry and provider-side revocation were not exercised. |
| V5 | The real OAuth app binds loopback HTTP and returns 404 for controller admin and lease routes in a socket test. The signed-in beta browser observed public-origin HTTP 404 on an admin path, but that observation alone does not identify whether the edge or origin produced it. |

PR #231's first CI run on `0c94820d` failed in four VM shards and Hermes on guest-readiness/boot timeouts and a virtio bridge queue error; validation and host lanes passed. Local shards 4 and 5 subsequently reported 3/3 tests passing each on that earlier head, but their runner did not expose a separate final exit code. A new exact-head CI result is required before PR readiness. The accepted review findings were corrected in remediation pass three of three; no fourth independent review was commissioned. No production configuration, provider credentials, DNS, merge, or package publication changed. The historical shared work root was unavailable on this Router service, so this checkpoint remains explicitly unshared pending reconciliation with that root.
