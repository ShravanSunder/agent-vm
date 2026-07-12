# Worker e2e sequence-gap investigation

## Bug packet

- Command:
  `mise exec -- pnpm run test:e2e:worker`
- Failure:
  `worker-control-session.worker.e2e.test.ts` failed the git RPC task with
  `sequence_gap: control sequence gap: expected=1 received=14 kind=command_result operation=git_push`.
- Expected:
  Worker advisory events are ack-only observations. The first controller
  `command_result` for the Worker-originated `git_push` command should use
  controller sequence `1`.
- Actual:
  The e2e synthetic controller emitted `command_result` messages for every
  non-command Worker advisory event and incremented its local controller
  sequence counter for those synthetic responses.

## Evidence

- The protocol contract intentionally does not advance the hard last-seen
  sequence for `latest_wins` or `droppable` delivery.
- The Worker e2e harness copied the original advisory envelope when building
  synthetic command results. Advisory replies therefore used `latest_wins`
  delivery and did not advance Worker-side `lastSeenControllerSequence`.
- The harness still incremented its local `controllerSequence`, so the first
  real critical `git_push` command result was sent with sequence `14` while the
  Worker still expected controller sequence `1`.

## Root cause

The test controller was modeling Worker advisory events as commands that require
domain command results. Production semantics are ack-only for Worker runtime
observations/status/capacity events. The e2e harness should acknowledge
non-command advisory messages and return without sending a `command_result`.

## Fix path

Update the e2e synthetic controller to ack non-command Worker messages without
emitting `command_result` frames. Then rerun the focused Worker control-session
e2e followed by the full Worker e2e gate.
