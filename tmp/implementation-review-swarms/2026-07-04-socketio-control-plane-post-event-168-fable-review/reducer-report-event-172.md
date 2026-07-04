Socket.IO Control Plane Post-Event-171 Reducer Report
=====================================================

Reviewed artifacts:
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/copy-paste-prompt.md
- tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl
- Current staged source tree against origin/master

Verdict:

not_ready

Reducer note:

The latest local implementation review found new accepted blockers after the
Event 171 fix set. The official workflow state still ended at a ready-for-review
transition, so this report records the reducer outcome and routes the goal back
to implementation execution before another Fable review.

Accepted blockers:

1. Managed OpenClaw still trusts plugin-supplied agent identity.

   The Event 171 fixes fail closed for empty `zones[].agents`, but a compromised
   plugin can still claim any declared OpenClaw agent by selecting `agentId` and
   agent-shaped session fields. Multi-agent managed OpenClaw zones are a
   supported configuration, so this is still a real authority bug.

   Required resolution:
   - Add verifiable controller/OpenClaw attestation for the selected agent, or
     conservatively fail closed for multi-agent managed OpenClaw zones until
     attestation exists.
   - Add tests proving the compromised plugin cannot select a different declared
     agent.

2. Worker git retry still breaks after ack-before-result loss.

   The client now preserves `commandId` and `idempotencyKey`, but retry still
   creates a fresh `messageId`. Dispatcher replay returns the cached terminal
   result with the original `responseToMessageId`, so the retrying worker waits
   for the new message id and can time out.

   Required resolution:
   - Preserve the original `messageId` across the in-flight retry, or rewrite
     cached `responseToMessageId` on replay.
   - Prove one controller operation and one terminal success for both
     `git_push` and `git_pull_default` after ack-before-result loss.

3. Gateway and Worker services can emit duplicate handler response sequences
   under concurrent commands.

   The current reservation flow reserves a peer sequence but does not advance
   the public cursor before receipt acceptance. Another outbound path can
   allocate the same sequence before the first response resolves.

   Required resolution:
   - Serialize handler-generated response sends per session, or implement an
     exclusive in-flight reservation cursor.
   - Add concurrency tests that hold the first response ack open, emit another
     outbound frame, and prove distinct sequences with both callers resolving.

Accepted important findings:

1. Review packet and inventory scope are wrong.

   The packet and inventory use bare `git diff --cached` instead of the PR/base
   scope. The correct review scope is explicit `git diff --cached origin/master`.

   Required resolution:
   - Regenerate `staged-name-status.txt`, `staged-stat.txt`, and packet counts
     from explicit origin/master scope after code fixes.

2. Terminal proof is stale after the latest runtime changes.

   Required before PR-ready:
   - `mise exec -- pnpm run test:e2e:openclaw`
   - `mise exec -- pnpm run test:e2e:worker`
   - `mise exec -- pnpm run test:e2e:vm`
   - `mise exec -- pnpm test:e2e`
   - `pnpm lint`
   - `pnpm check`
   - fresh `../shravan-claw-beta` Discord/OpenClaw proof

Follow-ups:

- Worker cancel/recovery still needs either runtime implementation or honest
  plan/spec narrowing.
- Portal export verifier could still use a dedicated fixture regression.

Routing:

Back to `shravan-dev-workflow:implementation-execute-plan`.
