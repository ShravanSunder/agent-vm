# Explanation review and remaining limits

Document: [Google access explained](2026-09-11-google-agent-access-explained.md).

Claude Opus 5 reviewed two drafts through ACPX with high effort. The adapter
reported `claude-opus-5` and `high`; the first review's native response metadata
also identified `claude-opus-5`. No model was substituted. User-wide settings
were disabled after the initial settings-inclusive launch was rejected.

The first draft scored **16/20** for clarity. The revised draft scored **19/20**,
with no zero and no material factual error found. The second verdict was
**readable**. These are explanation scores, not runtime/security certification.

| Rubric item | Revised-draft score |
| --- | --- |
| Google application/account/client versus agent boundary | 2/2 |
| Connection, scope, policy and one-call approval remain distinct | 2/2 |
| Complete, understandable dimensions | 2/2 |
| Clear responsibility and edit-versus-approve ownership | 2/2 |
| Config defaults, database overrides and encryption | 2/2 |
| Recommendation versus maximum; current versus intended | 2/2 |
| Same-account Sun/Ember isolation example | 2/2 |
| Readable diagrams and tables | 2/2 |
| Failure and recovery examples | 2/2 |
| Progressive disclosure and plain language | 1/2 |

## Parent-verified repairs

- Explained that the effective offered choices combine command availability and
  the authored ceiling. Distinguished deleting the required field from making
  its existing all-supported preset non-narrowing. The reviewed draft described
  that distinction before the configuration examples were updated.
- Made Read = Allow and Write = Deny explicit for selected read-only collection
  services; distinguished suggested Google scopes from local default policy.
- Explained loaded-default/active-snapshot mismatch and fail-closed unavailability
  without claiming that merely editing a file changes a running controller.
- Standardized “agent connection”; separately defined integration/application ID.
- Replaced the non-portable beta anecdote with the checkable shipped example.
- Confirmed that agents using the same integration share its configured client ID.
- Distinguished local Disconnect from Google's broader provider revocation and
  explained what local credential removal does and does not erase.
- Split the long paragraph and explained zone, local blocking and envelope
  encryption. Added the existing reauthorization recovery distinction.

One reviewer suggestion was rejected in part: the nickname is NOT only inside
encrypted storage. `catalog-schema.ts` declares plaintext `account_alias`, and
`oauth-catalog-repositories.ts` writes it. The final document names both the
verified email and editable nickname as plaintext metadata, alongside encrypted
authenticated copies. This correction was checked directly by the parent.

The parent also made explicit the limit already implied by the policy lookup's
inputs: a shared agent's account policy is not per-chat-human confidentiality.
Who may send messages/API requests is a separate admission concern. This is a
boundary clarification, not another scope maximum or a new proposed subsystem.

The scores above belong to the second reviewed draft. These final small wording
and boundary clarifications were parent-checked; no unperformed third rescore
is claimed.

After that review, the owner accepted shared-agent execution and the examples
were updated to non-narrowing `all-supported`, with all 15 supported
communications commands and unchanged defaults. The parent reconciled the
Markdown and HTML current-state sections with those files and their integration
test. The Opus scores are not a new review of those later configuration changes.

## Evidence limits

- Google cross-client and web-server OAuth documentation was checked directly;
  actual same-account grant/refresh/revocation behavior was not tested by review.
- Source was checked at `e888a7c6`. This explanation is not a claim of deployed
  feature completion, scope-maximum removal or successful Gmail execution.
- Reviews were source-reading only; no tests or provider operations were run.
  The first reviewer used read-only shell searches despite the intended tool
  restriction. The second reported one stray `echo skip` attempt, then used
  Read/Grep/Glob. No product/configuration writes were observed; the source
  worktree was checked. Do not interpret ACPX's terminal capability flag as an
  OS sandbox guarantee.
- The offline HTML copy was generated from the final Markdown. Browser-tool
  local-file policy prevented a rendered preview; no browser workaround was
  attempted. Markdown links and generated HTML structure were checked locally.

Detailed review packets and candidate reports remain under
`tmp/research-workflows/2026-09-11-access-explanation/`.
