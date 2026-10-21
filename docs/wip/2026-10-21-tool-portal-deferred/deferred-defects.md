# Tool Portal: defects found and deferred during the decomposition

These are defects in today's behavior, found while porting it. The new code reproduces each one exactly ("same behaviour"). Fixing them belongs after cutover (S4), as an owner-visible change.

| Found | Defect | Today's anchors | Kept as | Who would notice |
| --- | --- | --- | --- | --- |
| 2026-10-21, S3d (#245, Bugbot) | A standalone artifact read can return no media type, but the Portal SDK's high-level `artifacts.read` requires one, so the SDK call fails for such an artifact | Portal SDK `index.ts:105–113`; old MCP projection returns `mimeType` undefined; identical at `d25be046` | today's behavior, pinned by an old-versus-new parity test | a Portal SDK caller reading an artifact that has no media type |

Fixed instead of deferred, because the new code would otherwise break a published contract:

| Found | Defect | Fix |
| --- | --- | --- |
| 2026-10-21, S3d | Today's standalone approval coordinator emits a 32-hex `challengeId`, while the Portal SDK schema requires a UUID | the new Node host formats a deterministic UUID from the same fingerprint; token bytes are unchanged |

## Order-sensitive assertion on concurrent effects (test defect)

`packages/tool-engine/src/mcp-gateway/approval-carriers.unit.test.ts:73`
(from S3a, #241) compares the order of upstream effects with the order of the
calls in the batch. The calls in one batch run concurrently by design, so under
load they can finish in either order: `[43, 42]` instead of `[42, 43]`. Seen
once on 2026-10-21 in a loaded Implementer run at b8c80560; it passed 6/6 when
rerun. **Fix in its own layer:** compare the effects' arguments as a multiset,
and keep the exactly-once count and the receipt assertion. This doesn't weaken
proof, because order isn't a requirement. Not changed during the structure
pass.
