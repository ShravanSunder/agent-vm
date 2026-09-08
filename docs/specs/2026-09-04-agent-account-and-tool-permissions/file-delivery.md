# Shared staging for Gog files

This realizes [Specification R12/C12](specification.md#r12--c12-byte-safe-results-working-files-and-attachments).
Google consent, exact command admission and account-specific Tool Portal policy
remain mandatory before execution and publication. Published files are delivered
working data, not live Google credentials.

## File path and owners

```text
Agent / Gateway       Controller          Gog VM           Tool VM
      │                    │                 │                 │
      │── approved call ──▶│                 │                 │
      │                    │── run Gog ─────▶│                 │
      │                    │◀─ FUSE writes ──│                 │
      │                    │   private disk staging            │
      │                    │◀─ terminal exit ┤                 │
      │                    │                                   │
      │                    │ check files + current authority   │
      │                    │ publish into exact Tool VM view   │
      │◀─ exit/path/expiry ─│                                   │
      │── normal file tool ───────────────────────────────────▶│
      │                    │◀──── read-only FUSE reads ─────────│
      │                    │───── bounded file bytes ──────────▶│
```

The controller's staging owner owns directory allocation, publication, storage
accounting, expiry and cleanup. Its consumers are the configured-CLI executor,
Tool VM lifecycle and existing native attachment path. It changes when those
file-lifetime rules change, not when Google adds a scope or command.

The existing credentialed runtime manager continues to own Gog VM admission,
execution and containment. The lease manager owns the exact receiving Tool VM
generation and retirement. Neither VM closing a provider view may independently
delete storage owned by the staging owner.

The adapter translates neutral owned host-directory mounts into RealFS and the
existing hardened read-only wrapper. Provider handles remain inside the adapter.
ShadowProvider is path filtering, not an executable-specific security boundary.
Its memory-backed shadow mode is not payload storage. VFS hooks can observe
operations; they do not supply a timer or replace lifecycle cleanup.

### Ordinary providers and lifecycle cleanup

Use the existing owned-directory RealFS mount for the producer and its existing
read-only wrapper for the receiver. Do not add staging-specific mount leases,
dynamic provider registration, per-handle revocation or a custom quota filesystem.
Directory ownership, publication metadata and cleanup belong to controller code;
the provider remains ordinary filesystem access.

Only reviewed Gog commands execute in the producer VM. Publication waits for a
known stopped producer command and holds the existing command reservation through
inspection and movement. Unknown completion uses existing VM containment and
does not publish. The Tool VM never receives producer write access. This is not
a new sandbox against arbitrary code running inside the Gog VM.

## Storage separation

Use one controller-owned temporary staging subtree outside normal backups, with
separate private producer roots and published receiver roots. All identifiers and
host locations are controller-derived. No user-provided host path is accepted.

```text
owned staging root
  producer/<credentialed-runtime-generation>/
    <operation>/                 Gog-only read/write
  receiver/<tool-lease-generation>/
    <publication>/               Tool VM read-only
```

Gog sees only its private producer root, not published receiver roots or other
agents. The Tool VM sees only its receiver root. No operation files are visible
there before publication. Published regular files may include staged inputs;
their presence does not claim they were newly produced by Gog. Credentials, CLI configuration and caches remain in the
existing credentialed VM environment/rootfs, never this shared mount.

Published files use separate inodes from the producer. A bounded host copy into
a private receiver-side directory creates the delivered byte snapshot; the final
directory rename is on the receiver filesystem. A producer descriptor or hard-link
alias cannot modify that copy. Remove source data after successful publication;
failed source cleanup remains accounted for. Do not share one mutable backend
lifetime object between VMs; acquire independent owned directory views.

### Static mount creation

Controller staging allocates a producer root keyed to the already-reserved
credentialed runtime record before VM creation. Credentialed VM construction
receives its owned-directory capability and mounts it read/write at
/agent-vm/gog-work. File-bearing commands run in the operation child under that
mount; other command cwd/config/cache behavior stays unchanged.

The lease manager allocates the Tool VM leaf generation before its VM factory
call. That call passes the exact generation to controller staging, which allocates
its receiver root. Tool VM construction mounts that owned root read-only at
/agent-vm/files before boot. Extend the existing managed workspace constructor
with this single typed staging-root input; continue rejecting arbitrary additional
mount dictionaries. Publications are children created later under this static
root, not post-boot mounts. Returned paths are /agent-vm/files/<publication>/<name>.

These added creation edges reuse managed-vm owned-host-directory mount contracts
and adapter read-only translation. The staging owner closes unconsumed directory
capabilities on creation failure and cleans the exact owned root after any
provisional VM is contained. No mount handles or raw host paths enter agent RPCs.

The receiving mount is a temporary read-only working-file surface, not the
durable /workspace projection. Files may be opened directly or explicitly copied
by the agent into /work for modification or /workspace for durable retention.

## Publication and file meaning

The executor allocates a fresh operation folder only after call admission.
Qualified file-bearing Gog commands use it as cwd; non-file commands retain their
configured cwd. Original argv remains unchanged. Explicit relative output flags
are required; one leading ./ is allowed. Reject absolute paths, traversal,
control characters and expansion escapes. A directory output may name the
operation root. Command descriptors describe CLI argument positions, not
individual file permissions or inferred document purposes.

After known command termination, inspect the folder with bounded enumeration and
regular-file checks. Reject symlinks, special files and escaping path components.
Compute file length and digest incrementally. A nonzero Gog exit does not itself
withhold otherwise eligible files: report actual command status separately from
file availability. A stable file can still be a partial export or staged input;
publication does not assert semantic completeness or successful production.

Resolve the exact current receiving Tool VM through existing trusted Gateway
lease authority, holding active use during publication. Bind lease ID, generation
and VM ID; never publish into a successor selected by a stale request. If no
receiving Tool VM is available, return a delivery failure without replaying Gog.
Before making files visible, recheck call/account authority and destination
identity. Publication has one staging-owner linearization point: authorization
changes before it deny publication; changes after it do not recall delivered data.

Controller composition supplies one zone-scoped publication guard to staging and
all authorization-changing entrypoints. The guard serializes final publication
with disconnect, replacement, policy-save and config/zone fencing commits. Slow
Google calls, hashing and producer drain occur before it; VM containment occurs
after it. While holding the guard, publication checks the current authenticated
authorization snapshot and exact receiver binding, then performs the receiver
directory rename. The delivered outcome is fixed before releasing the guard.
Authorization mutations cannot commit between that check and rename. Receiver
retirement/expiry uses the same guard to withdraw publication admission. Lock
order is zone publication guard then staging state; neither waits for a runtime
lock or active reader while holding both. This is local orchestration, not a
database transaction held across filesystem I/O or a replacement policy store.

Stream checked regular files from the stopped producer into exclusively created
files in a fresh private publication directory, preserving relative names. Hash
and count the copied bytes and reject source identity/length changes during copying.
Use fixed-size host read/write buffers with awaited writes, never whole-file
collection. Reserve storage for the source and temporary copy while both exist;
capacity failure is a delivery failure, never a reason to rerun Gog.
Failed or unsupported siblings
stay private and receive typed failures; they do not prevent valid siblings from
being published. Expose the assembled publication directory at one fresh
controller-generated receiver child only after final checks. Do not replace
existing destinations or expose producer inodes as delivered files. Failure
preserves the known Gog outcome, with no complete destination path for
unsuccessful publication. Independently published sibling outputs remain available.

The result carries bounded file/directory metadata, actual filenames, Tool VM
paths and absolute expiresAt, plus the independent command outcome. Gog-reported
paths are untrusted hints and cannot expand the admitted folder. Export format
may change extensions, so return inspected names rather than guessing them.
No model-visible base64 or file bytes in Portal JSON.

## Input files

Input names continue to resolve relative to /work in the requesting Tool VM,
not a terminal's current directory. For name p, preflight reads /work/p and stages
it as p for Gog. Agents use ordinary tools to copy inputs from other locations
into /work. No public host/source-root selector or general workspace mount is
introduced.

Preflight retains the existing source lease active use only while streaming
hash/length, then releases it before human approval. Exact approval binds original
argv, normalized input path, source lease/generation/VM, hash and byte length.

After admission, reacquire that same source identity. Use the existing fixed
exec reader with piped byte output, buffer:false and stock flow control to stream
into an exclusively created host staging file. Await bounded host writes and
rehash during staging. Mismatch, source loss or cancellation prevents Gog dispatch
and cleans only owned incomplete input. No rootfs vm.fs.writeFile destination is
needed for an input already visible through Gog's staging mount.

## Expiry and cleanup

Publication starts a fixed one-hour deadline. Reads do not extend it. Published
storage belongs to the receiving Tool VM lifetime, not the producer VM lifetime.
Gog retirement removes only unpublished producer scratch.

```text
private staging
   │ known terminal outcome + checks + current publication authority
   ▼
published ── Google disconnect ──▶ published, original expiry unchanged
   │
   ├─ one hour elapsed
   └─ receiving Tool VM retirement
             │
             ▼
        mark expired
             │ stop new controller delivery; remove published paths
             ▼
        remove owned storage
             ├─ success → release quota
             └─ failure → cleanup pending; quota retained; retry
```

The staging owner consumes existing Tool VM retirement notifications and the
controller reaper. No separate cleanup service, per-file timer swarm or cleanup
responsibility delegated to an agent. Cleanup is idempotent and targets only the
recorded operation/receiver child.

Read-only enforcement does not implement expiry: the controller removes the
owned published directory at its deadline or receiver retirement. This uses
ordinary filesystem deletion semantics. An already open descriptor or cached
guest bytes may remain readable until closed or the VM ends; no custom provider
tries to recall delivered bytes or forcibly close guest descriptors. Unlinking
removes names, while physical blocks can remain until open handles close.
Verify actual FUSE visibility after deletion; do not promise instantaneous cache
invalidation or secure erasure. Controller-started copies settle or are cancelled
before their owned temporary targets are cleaned; ordinary guest reads do not
create another controller active-use or filesystem handle registry.

At startup, existing controller ownership locking and VM recovery run before
orphan staging cleanup. A root belongs to one controller run and is never adopted
as a fresh agent file inventory. Only after previous producer/consumer VM
containment is proven may recovery remove that run's staging root. Unknown
containment preserves storage and reports failure; it does not authorize a broad
temporary-directory sweep. Cleanup failure remains visible and accounted for.

Keep existing admission and retained-result limits: 64 MiB per agent,
16 MiB per published file, 32 retained operations and 4096 inspected entries.
Reserve expected maxima before dispatch, inspect actual output before publication,
and refuse to retain oversized results. Host-controlled input/attachment copies
enforce byte limits while streaming. Failed cleanup remains accounted for.
These are application admission/publication limits, not an OS quota on every
Gog filesystem write. Ordinary RealFS can temporarily contain oversized producer
output until the command stops and cleanup runs. Do not claim that the VM's
rootfs disk limit bounds this host directory or implement a quota filesystem to
make that claim. Disk-full remains a visible operation failure, never a reason
to collect payloads in MemoryProvider or replay a Google mutation.

## Agent instructions

Existing Tool Portal orientation and runtime instructions explain:

- explicit relative Gog outputs refer to the operation directory;
- Gog inputs resolve from Tool VM /work;
- published paths are read-only and usable by normal file tools;
- files expire at expiresAt or earlier when this Tool VM finishes;
- wanted files must be copied into durable workspace before expiry;
- reading does not extend retention;
- file availability does not imply Gog succeeded; inspect its exit status;
- disconnect does not recall already delivered files.

No additional in-VM copy executable, synthetic HTTP endpoint or projected command
identifier is needed merely to read a published file.

## Explicit native attachments

Hermes retains the captured profile/session/recipient checks and existing native
sender. Attachment is explicit, not a download side effect. Resolve the selected
published file through its agent/receiver binding and expiry; publication already
established delivery, so no fresh Google consent is required to read it.

Use the existing Gateway cache mount at /home/hermes/.cache, whose host directory
is already selected by Gateway lifecycle. Do not mount receiver or producer roots
into the shared Gateway, and do not add dynamic mounts. The controller streams
only the explicitly selected file into an exclusively created, profile/send-scoped
temporary cache child using bounded host filesystem writes. After length/hash and
current route checks, publish a no-overwrite cache filename and return its existing
Gateway-local path mapping to the plugin. This is a private per-send copy, not a
second exposed publication tree or rootfs vm.fs.writeFile operation.

The existing native-attachment owner controls this copy and its quota. Hold source
staging use through copy completion; the resulting verified copy has the existing
sender-settlement lifetime. Source expiry fences new attachment preparation but
does not tear down an already dispatched native send. The plugin rechecks its
captured route immediately before sending. Failed/unconfirmed sends remain visible
without automatic resend. Once the sender has settled, remove the exact per-send
cache child on success or failure, including a settled result with unknown delivery
status. Failed preparation also cleans its owned temporary child. Failed removal
is cleanup-pending and retried. Unknown sender settlement retains the copy and charge
until exact Gateway containment permits cleanup. Files from other Tool VM locations
use their existing authorized source reader and the same per-send host writer.

This reuses the cache mount defined by hermes-gateway/src/hermes-lifecycle.ts and
its host location from agent-vm/src/gateway/gateway-zone-orchestrator.ts. It changes
only the attachment owner's selected storage/write path. Ordinary Gateway cache,
other profiles' files and unrelated agent work are never cleanup targets.

Attachment children live only under the controller-created cache subtree
agent-vm-native/<controller-run>/<gateway-generation>/<send-id>. The controller
derives run and generation from existing ownership identities, not sender input.
Normal settlement removes the send child. Startup holds the existing controller
ownership lock, completes recorded Gateway/child-VM containment, then removes the
old run/generation subtree. A missing in-memory send record does not make these
owned leftovers undiscoverable. Never infer that an arbitrary similarly named
cache directory is ours; validate the fixed owned root and canonical descendants.
Unproven containment preserves that subtree for retry. No per-file audit table
or OAuth SQLite cleanup log is needed, and restart does not adopt pending sends.

## Current-to-target changes and evidence

| Current path | Target change | Preserved boundary |
| --- | --- | --- |
| Executor prepares rootfs operation folder | Prepare private disk-backed mounted operation folder | Exact argv, admission and known terminal outcome |
| Runtime-owned five-minute folder references | Staging owner publishes to exact receiver generation with one-hour deadline | Bounded metadata, quotas, no cross-agent lookup |
| Portal list/materialize RPC copies into Tool VM | Normal read-only mounted paths and bounded result metadata | Credential separation and path validation |
| Fixed exec reader → rootfs vm.fs writer | Bounded host publication copy between RealFS roots; input reader → host disk writer | Byte identity and bounded memory |
| Native attachment rootfs staging | Per-send copy through the existing host-backed Gateway cache | Captured native route, explicit send, no resend |
| Gog retirement drops every result | Receiver retirement/expiry cleans published results | Existing exact VM containment and no restart adoption |

Current anchors are controller/runner/configured-cli-managed-vm-executor.ts,
controller/credentialed-runtime/credentialed-operation-folder-session.ts,
controller/files/current-tool-vm-work-files.ts, controller/files/operation-file-relay.ts,
controller/files/native-attachment-staging.ts and controller/leases/lease-manager.ts.
The neutral mount types and existing owned/read-only translations are in
managed-vm/src/managed-vm-contracts.ts and gondolin-vm-adapter/src/managed-vm-provider.ts.

Gondolin's [VFS providers](https://earendil-works.github.io/gondolin/vfs/) describe
RealFS, read-only and shadow behavior. Host-side mounted-file access and guest
FUSE operations are distinct from the rootfs writeGuestFile protocol.
The [approved patch](../../architecture/gondolin-patches.md) remains until every
affected production path is removed or requalified against an unpatched package
and its removal is approved. This design does not declare the upstream bug fixed.

## Proof boundaries and cutover

R12/C12 and V9 require real two-VM FUSE observations: Gog-shaped producer output,
actual controller publication, ordinary Tool VM open, byte identity, read-only
mutation denial, cross-agent denial, path/symlink/special-file rejection, and
independent command/file status. Fake providers prove decisions, not those paths.
Keep a producer writable descriptor open across publication and mutate the original:
the delivered copy must retain its reported digest. Prove the two fixed mounts
are present at creation, later published children become readable, and an old or
different Tool VM generation never receives the new receiver root.

Use injected time for one-hour expiry and real lifecycle events for VM closure.
Prove producer closure preserves publication, receiver closure removes it,
expiry removes published names with ordinary open-file semantics. Verify
retained-result limits before publication, bounded host copies,
disk-full behavior, restart orphan cleanup after containment and failed cleanup
accounting. Disconnect before publication denies it; disconnect afterward does
not remove files or extend their deadline.

Input proof preserves approved bytes under source changes and lease replacement.
Recording native-sender proof exercises the actual plugin and staging view.
Cover sender success, settled failure and settled-but-unconfirmed delivery: each
removes only its per-send cache child and never retries sending. Separately keep
a sender pending and prove cleanup does not remove its input until settlement or
proven Gateway containment. Host-backed attachment files must be explicitly removed
after containment; closing the VM alone cannot count as host-file deletion.
Inject a deletion failure and verify cleanup-pending plus retry. Preserve sentinel
files in ordinary cache and other profiles throughout all cleanup scenarios.
Memory measurements must cover slow readers/writers and concurrent transfers.
Packaging proof follows the installed dependency chain, including whether the
approved patch is still required. Existing whole-file helpers cannot become
fallbacks. No production credentials, live sends or deployment changes are
implied by local proof.

Cut over portable results, instructions, lifecycle and all consumers together.
Do not retain an old copy-RPC path as a compatibility fallback. Preserve independent
non-Google artifact backends. Stale runtime rootfs references are unavailable;
there is no migration or adoption of files from prior controller runs.
