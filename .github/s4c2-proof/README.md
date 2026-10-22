# S4c2 CI negative-proof approval packet

Prepared by paired Verifier. **Not executed in CI or a VM. Not applied or committed to a product/test checkout.** Exact proposed product target: `83fac91a6dcb9ccd9a5fdf67cb6ff2b61ef05994` (tree `36858927112050629e7bf035c4a5a31cdad31654`). Lead approval must cover the exact CHECKSUMS, ephemeral fixture patches, branches/PRs, commands and closure before execution.

## Proposed delivery route

The Implementer opens only the Lead-approved draft probes to master, labelled **CI probe — do not merge**. Main PR #255 remains a draft against S4b. First probe runs normal CI from the frozen feature. A disposable sibling branch based on the frozen feature contains only this scratch packet at `.github/s4c2-proof/` and `s4c2-negative-probe.yml` at `.github/workflows/`; no mutant ancestry goes into the feature branch. `workflow.patch` is the exact additional workflow input. Existing normal CI also runs on that probe.

The extra workflow checks out the probe input separately at `probe/`, and checks out the exact product commit at `product/`. Thus its product execution is exact feature-head proof even though normal PR CI uses a synthetic merge checkout. Record probe head, PR, run/attempt, checkout parents/tree and job identities; do not conflate them.

Each matrix job uses Node 24.7.0, pnpm 10.33.0, uv 0.11.31 and the repository's pinned mise VM toolchain, on Linux with native KVM. It builds the normal workspace in CI. No Docker/VM commands are permitted on the Mac.

Each mode runs: original real Hermes journey green; apply its exact scratch patch to the disposable product checkout; build/boot an independently selected mutant image and require a meaningful runtime/provenance red; restore exact original test bytes; verify source diff clean; repeat the original journey green. `run_negative.sh MODE FULL_SHA` owns this sequence and refuses non-CI/non-Linux/no-KVM execution. A timeout or unobserved mutation is inconclusive and fails the job.

Each mode's baseline and mutant image roots live only at `$RUNNER_TEMP/s4c2-negative-MODE/{baseline-cache,mutant-cache}`. No prepared-image cache restore or publication occurs. The negative root cannot overwrite a feature cache key. The restored run reuses only that job's original baseline root. The final normal feature probe remains a separate green gate.

## Stale wheel: actual retained artifact

The wheel `agent_vm_agent_portal_sdk-0.0.153-py3-none-any.whl` was built unchanged from commit `83e9683f00b26ff1772b8e130abd6dae727866f7`. SHA256 `a9ba71fe6dc2c57dc3c93305e8820309627b5f85d3b01297d2c9417380ef5d15`. I independently compared its standard transport bytes with that exact Git blob. See stale-wheel-identity.json.

It deliberately has the same 0.0.153 version as current code. Its installed Requires-Dist contains `mcp<2,>=1.28.1`; its standard transport SHA256 is `2e12968d1fa58fe3576126d042c1533e5774431c14cfd64ab4d1e2aa7e7f7062`, versus current `d5dbee011e18fbf227fb2612e85f89be0bd3cf55f9d319b0099f9f8323cd9f99`.

The patch appends COPY/install lines after the standard generated Gateway recipe. `uv pip install --no-deps --force-reinstall` installs that real old wheel without resolving a new dependency set or editing pyproject. Existing metadata/source/import guards and the native journey remain intact. Actual VM exec reads installed metadata and bytes without importing the SDK; it proves the old artifact reached the booted image. A version/filename-only check would be vacuous here.

Deciding stage must be read from the actual failure: old-wheel import/runtime incompatibility may refuse startup before the image provenance assertions; alternatively installed source/Requires-Dist assertions may refuse it. Claim only the layer reached. An image build failure without actual installed readback does not pass the negative assessor.

## Wrong managed transport: natural MCP failure

The generated recipe changes only the installed `gateway_runtime_client.py` default transport, with a before-byte hash guard and after hash. The wrong implementation delegates to the real StandardMcpToolPortalTransport. It never constructs/delegates to GatewayRuntimeUdsTransport. It makes real standard MCP requests to the existing controlled upstream. It does not send attachment or private request values there. There is no deliberately raised exception; real discovery/handshake/result validation must fail naturally.

The existing upstream fixture uses SDK v1.29 and has no server/discover handler. A modern discovery refusal may therefore decide the run before any tools/call. Report that exact stage; do not promise successful MCP negotiation or a completed private handshake. This deciding-stage limit is part of this proof plan.

The assessor requires actual standard MCP wire methods, actual mutated installed-client hash readback, failed native journey, zero controlled upstream write calls and zero durable controller approval records. Safe capture logs only method names, tool names, counts, selected VM imageReference/sessionLabel and installed hashes/requirements. It never logs headers, attachments, environment or mediated secrets. No new public endpoint, connection owner, test callback in shipped code, or additional modern fixture is introduced.

There is no global socket-traffic counter: the private-route negative is triangulated from the observed wrong default transport (which has no UDS delegate), actual MCP wire traffic, blocked native startup, zero counted writes and empty controller approval records. Do not generalize this to unrelated lifecycle traffic or claim a direct UDS request-counter measurement.

## Exact controls and evidence

`prepare_mutation.py render` produces patches/source captures only. `apply` verifies the target test's original frozen bytes and clean state; `restore` refuses unexpected intervening edits. `run_negative.sh` accepts only Vitest exit 1 as a potential red; `assess_negative.py` rejects absent installed/wire/controller observations and unintended writes. Its final line deliberately requires manual deciding-assertion review; a green wrapper alone is not acceptance.

Both patches were rendered, TypeScript parsed with zero diagnostics, and checked with `git apply --check`. Python drivers and the actual assembled wrong installed-client source compile; shell syntax passes; YAML parses with the two matrix modes. These are preparation/static checks only. No patch was applied and no VM/CI run happened during preparation.

Job logs retain baseline, mutant, restore identities and safe observations. The Implementer downloads complete run logs; the Verifier independently reads the run/attempt/jobs, actual deciding failures and restored green outputs. Selected-image proof must use this journey's actual VM imageReference and installed readback, not another job's cache manifest. Close both probe PRs after evidence capture, never merge them; keep #255's frozen product commit unchanged. Do not publish mutant caches or treat probe job success as product acceptance.

Pending: explicit Lead approval of this packet/branch execution plan; actual baseline/mutant/restored CI runs; independent final target host observations and wrong builds. No acceptance is claimed.
