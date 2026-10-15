# Gondolin patches

Every Gondolin dependency patch, patch change, runtime monkeypatch, guest change,
or fork adoption requires Shravan's explicit approval. Previous approval is not
blanket authority. Keep this tracker current; do not equate merged, released,
installed and qualified.

## Current state

No Gondolin patches are carried. On 2026-09-09 Shravan approved removal of the
obsolete rootfs-transfer path and its two-handler patch. Google/Gog inputs and
outputs use controller-owned RealFS staging. Native attachment copies use the
existing Gateway cache mount. The managed VM contract no longer exposes a
guest-file writer. Credentials remain on the separate protected memory mount.

The retired path is independent of upstream fix distribution. Stock 0.13.0
contains the upstream fix; the removed writer remains outside our contract. Ordinary guest exec streaming uses stock Gondolin
flow control and disables final payload buffering. No QEMU, kernel, firmware,
guest protocol or machine setting changes are part of this transition.

## Historical upstream tracker

| Fix | Upstream PR and pinned revision | Last verified upstream state | Local state |
| --- | --- | --- | --- |
| Early completion-promise rejection observers in guest writes/deletes | [#136](https://github.com/earendil-works/gondolin/pull/136), `94b1f94828e5b834d5abe7fda478b3c7ce6ab352` | Merged 2026-10-04; verified 2026-10-15 at release [0.13.0](https://github.com/earendil-works/gondolin/releases/tag/v0.13.0), `fcbcef162a73b214f79069f8430c70cebda0f827` | Retired with owner approval 2026-09-09; formerly applied to 0.12.0. Removal gate satisfied by writer retirement; no patch to carry into 0.13.0 |

The retired patch attached immediate rejection observers to two internal promises
in `SandboxServerOps.writeGuestFile` and `deleteGuestFile`. It did not alter caller
errors. Its original regression established four failure cases failing without
the patch and passing with it. Those tests tested an obsolete dependency path,
not the selected RealFS delivery mechanism; retirement is not an upstream fix.

## Qualification and downstream installations

The removal must be qualified against the stock installed dependency and the
actual RealFS input/publication/attachment path. Keep byte integrity, source and
destination failures, cancellation, bounded-memory, isolation and cleanup proof.
Do not count historical patched results as stock-dependency qualification.

Workspace patch configuration was never transitive to published consumers.
Deployments that explicitly copied the old patch must remove their own matching
registration/file and regenerate their lockfile during the approved update; a
source-checkout removal alone does not change deployed dependencies. Preserve
unrelated deployment patches. Verify the installed chain after that update.

The earlier fork-evaluation TODO is no longer needed for this delivery. If a
future feature requires an upstream fix, record its exact affected path, upstream
PR/revision/status, release, distribution and removal gates, and obtain fresh
approval before adding a patch or adopting a fork.
