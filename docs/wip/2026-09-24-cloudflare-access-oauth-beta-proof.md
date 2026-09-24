# Cloudflare Access and Hermes approval beta proof

Date: 2026-09-24. Branch: `investigate/sunclaw-oauth-access`. This is a continuation of the preserved [implementation handoff](2026-09-23-cloudflare-access-oauth-closeout/implementation-handoff.md), not a release or production qualification.

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

## Current verification and limits

| Gate | Result |
| --- | --- |
| `pnpm test:unit` | 408 files, 4,627 passed; exit 0 |
| `pnpm test:integration` | 80 files, 910 passed; exit 0 |
| `pnpm test:e2e:host` | 35 files, 233 passed; exit 0 |
| `pnpm test:e2e:inventory` | 6 passed, 53 skipped; exit 0; inventory only |
| Pinned Hermes Python suite | 226 passed; exit 0 |
| Pinned-image presenter E2E | 1 passed; exit 0 |
| `pnpm check` | 16 passed, 0 failed; exit 0 |
| Hermes Python typecheck | Exit 1: 12 existing diagnostics in untouched files, none in the changed presenter |

Live Access time-based expiry and provider-side session revocation were not exercised. They require waiting for provider expiry or mutating provider session state; local expiry checks remain in the existing suite. No production configuration, provider credentials, DNS, merge, or package publication changed. The historical shared work root was unavailable on this Router service, so this checkpoint remains explicitly unshared pending reconciliation with that root.
