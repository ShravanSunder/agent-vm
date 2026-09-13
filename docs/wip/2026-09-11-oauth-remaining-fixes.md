# Remaining OAuth fixes and proof

Continuation checklist for PR #227 and the separately requested UI follow-up.
Do not infer completion from earlier screenshots or CI at a different head.

- [x] Fix confirmation account-name input locally: label on its own row,
  full-width bounded input with visible dark styling. Desktop and 390px browser
  previews captured; 46 UI tests, package build/typecheck/format and scoped lint
  passed (three existing lint warnings, zero errors).
- [ ] Finish review of the confirmation-field correction. UI checkpoint9eef0104
  is pushed/deployed; actual beta serves the new CSS and retains its Gmail
  connection. Full confirmation was previewed, not repeated with live consent.
- [x] Reconcile Recommended versus available Custom permissions. Beta and the
  updated examples use non-narrowing `all-supported` with all 15 supported
  communications commands. Read/Write defaults and saved policies are unchanged.
  The real policy page offers Gmail, Calendar and Contacts controls. This is
  command availability, not additional Google consent or a blanket Allow.
- [x] Verify the approved beta Gmail connection through a real read-only Gog
  search. Gateway syntax validation was corrected in e888a7c6 and deployed.
  Raw Hermes tool results show a successful unmatched-message search, exit 0,
  with no message contents. Unknown-account and denied Calendar calls were
  not dispatched. No repeat consent or mailbox writes were performed.
- [ ] Investigate repeated controller graceful-shutdown hang separately. Beta
  was recovered using verified exact-PID termination and ownership-checked
  cleanup; no lifecycle or Gondolin patch was applied.
- [ ] Separate CI diagnostic: run 34607672416 had a VM shard4 stock pressure probe
  exited139; aggregate check failed consequently. No blind retries, weaker tests,
  timeout changes, or Gondolin/QEMU patches. Later run 34646896058 at 9eef0104
  passed all 13 jobs without changing that VM test. Root cause is not established;
  the historical failure is not evidence that the later run failed.
- [ ] Finish fresh hosted invitation proof with an authorized fresh test setup.
  The only approved existing account must not be deleted/recreated.
- [ ] Finish review, exact-head CI and PR gates before merge. PR remains draft.
- [ ] Separate PR: actual React/shadcn UI migration, retaining Hono server
  authentication, native form semantics, CSP and owner authorization boundaries.

Known completed checkpoint: waiting-for-access page, commit62afa6c3, deployed to
beta; local unit4616/integration921/check16/build17 passed. Existing-user beta
landing works. The Gog correction separately passed unit4621/integration921/
check16/build17 before deployment. Final choices/manual diff still needs its
current aggregate checks and final-head CI. These results do not prove the
unchecked items above.
