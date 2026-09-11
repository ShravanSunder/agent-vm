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
- [ ] Reconcile Recommended versus available Custom permissions. Recommendations
  are starting selections, not restrictions. Current beta separately has a
  Gmail-only ceiling and only two Gmail commands configured in Tool Portal.
  Calendar needs coherent supported command/config admission, not only an enabled
  checkbox. Preserve explicit owner consent and account policy; do not bypass
  restrictions or invent a blanket grant. Explain unavailable choices accurately.
- [ ] Verify the approved beta Gmail connection through a real read-only Gog
  search. Credential lookup later succeeded. Actual Tool Portal listing/describe
  worked, but the search was rejected before RPC: Gateway registration used the
  static policy evaluator, which always rejects managed Google policy. A local
  syntax-validator correction passes21 adapter tests; full proof and deployment
  are pending. No repeat Google consent is needed.
- [ ] Investigate repeated controller graceful-shutdown hang separately. Beta
  was recovered using verified exact-PID termination and ownership-checked
  cleanup; no lifecycle or Gondolin patch was applied.
- [ ] Diagnose exact-head CI run 34607672416: VM shard4 stock pressure probe
  exited139; aggregate check failed consequently. No blind retries, weaker tests,
  timeout changes, or Gondolin/QEMU patches.
- [ ] Finish fresh hosted invitation proof with an authorized fresh test setup.
  The only approved existing account must not be deleted/recreated.
- [ ] Finish review, exact-head CI and PR gates before merge. PR remains draft.
- [ ] Separate PR: actual React/shadcn UI migration, retaining Hono server
  authentication, native form semantics, CSP and owner authorization boundaries.

Known completed checkpoint: waiting-for-access page, commit62afa6c3, deployed to
beta; local unit4616/integration921/check16/build17 passed. Existing-user beta
landing works. These results do not prove the unchecked items above.
