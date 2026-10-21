# Tool Portal: defects found and deferred during the decomposition

These are defects in today's behavior, found while porting it. The new code reproduces each one exactly ("same behaviour"). Fixing them belongs after cutover (S4), as an owner-visible change.

| Found | Defect | Today's anchors | Kept as | Who would notice |
| --- | --- | --- | --- | --- |
| 2026-10-21, S3d (#245, Bugbot) | A standalone artifact read can return no media type, but the Portal SDK's high-level `artifacts.read` requires one, so the SDK call fails for such an artifact | Portal SDK `index.ts:105–113`; old MCP projection returns `mimeType` undefined; identical at `d25be046` | today's behavior, pinned by an old-versus-new parity test | a Portal SDK caller reading an artifact that has no media type |

Fixed instead of deferred, because the new code would otherwise break a published contract:

| Found | Defect | Fix |
| --- | --- | --- |
| 2026-10-21, S3d | Today's standalone approval coordinator emits a 32-hex `challengeId`, while the Portal SDK schema requires a UUID | the new Node host formats a deterministic UUID from the same fingerprint; token bytes are unchanged |
