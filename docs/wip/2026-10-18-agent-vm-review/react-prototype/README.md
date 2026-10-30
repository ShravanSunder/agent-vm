# React workspace review prototype

**Review-only frontend, not a production service.** Open the running [workspace preview](http://127.0.0.1:61691/) or the [captured review](../review.html#react-evidence).

The prototype uses React, Base UI, official shadcn `base-mira` components, `cn` and `@shadcn/lint`. AgentStudio Bridge supplies the theme. It demonstrates workspace tools, an agent in a harness, team-account confirmation and an audit view. All identities, resources and accounts are examples. The server binds loopback, keeps its authoritative fixture state in memory and resets it at restart. Its JSONL file is review evidence; it is not replayed as a durable store.

F-35 confirms the example account is a team resource: a manager cannot grant a shared agent a person's personal account. Requester attribution never supplies requester credentials. The example UI has no classification authority or identity issuer.

No Cloudflare login, agent identity service, membership attestation, credentials, real provider consent, resource execution or production authorization is implemented. The named harness describes an example agent; choosing Hermes does not register a Hermes server. Tool categories and the initial agent tool selection are illustrative, not new defaults or policy modes.

## Sources and boundaries

| Source | Use |
| --- | --- |
| AgentStudio `8d5d98a7`, `BridgeWeb/src/app/bridge-app.css`, token prefix and shared base reset | Dark semantic tokens, typography and border/focus reset; Oxfmt formatted. Portal adjusts only shared border and sidebar-accent tokens. Viewer-wide clipping, animation and native/RPC dependencies excluded. |
| Official shadcn registry, `base-mira`, generated with CLI `4.22.0` | Sidebar, Card, Table, Sheet, Switch, RadioGroup, AlertDialog, Item, Badge, Sonner, DropdownMenu, Tooltip, Field/Label, Checkbox, Select, Button, Input and supporting recipes. Feature code uses their variants and layout props. |
| [`cn` 0.5.0](https://github.com/shadcn-ui/cn/blob/8ebcbf09d1a3355c235295e804a6126f6f2f069a/README.md) | Class merging. Official `shadcn migrate cn --yes` ran; old `clsx`/`tailwind-merge` dependencies were removed. |
| [`@shadcn/lint` 0.2.1 React setup](https://github.com/shadcn-ui/lint/blob/93037f60bf0c2e96f4a25eb635fda24cd4761e47/docs/react.md) and [adoption guidance](https://github.com/shadcn-ui/lint/blob/93037f60bf0c2e96f4a25eb635fda24cd4761e47/docs/adoption.md) | Oxlint plugin, six configured rules and the documented component-implementation overrides. Feature code has no blanket exclusions. Generated component implementations use the plugin's documented overrides; the single named `toaster` allowance is Sonner's structural class. |
| [Fleet Framework](../../../specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md) | F-23/F-24 agent/subset model, F-27 team-account direction, F-28 audit presentation, F-29 workspace managers. F-32 union discovery and verified per-call workspace carriage remain outside this one-workspace fixture. |

The lockfile records exact inputs. npm listed CLI `4.22.1` at research time; the fixture resolver selected `4.22.0` under its release-age policy. Compatible `postcss 8.5.30` is pinned after a newly published transitive release failed that policy. Dependency scripts remain denied; no machine-wide policy was weakened. These pins do not change Agent VM's product dependencies.

## What each file does

- `src/review-application.tsx`: Sidebar composition, hash navigation and fixture loading.
- `src/workspace-tool-table.tsx`: bucket tables, allowance drafts and affected-agent removal dialog.
- `src/agent-registration.tsx`: agent table and registration Sheet, fields and subset selection.
- `src/accounts-view.tsx`: account table, provider summary, confirmation Sheet and cancellation dialog.
- `src/account-status-badge.tsx`: one status vocabulary and Badge mapping across account and tool views.
- `src/audit-event-table.tsx`: human labels and changed values in the event table.
- `src/review-forms.tsx`: shared command outcome and request-error presentation.
- `src/review-contracts.ts`: example catalog and input/response schemas shared by browser and fixture server.
- `src/review-server.ts`: independent input/revision/subset checks, fixture state and example events. No authenticated API contract is proposed by these routes.
- `src/components/ui/`: generated shadcn components. `src/bridge-theme.css` is the sole theme and base-reset file. There is no feature override stylesheet. Native layout wrappers and semantic headings supply document structure; registry components own control appearance.

Production ownership, command contracts, full provider-consent/policy screens, audit storage and authentication remain design work. The fixture's permissive account transition handler is not a proposed OAuth lifecycle.

## Run independently

Keep installation/build residue outside the Agent VM checkout. Copy this folder into an isolated task directory first. With that copy at `/private/tmp/2026-10-agent-vm-react-workspace`, the checked commands are:

```bash
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace install --ignore-scripts --frozen-lockfile
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run build
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run typecheck
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run lint
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run format:check
pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run start
```

The server prints its assigned loopback URL after listening. Each fresh process starts with the same example workspace. The URL hash opens `#tools`, `#agents`, `#accounts` or `#audit`. For review-only failed-save observation, add `?scenario=unavailable#agents`; the fixture returns `503` before changing its state.

## Verification

The owner rejected the first React iteration. The current composition follows the Advisor's concrete screen guidance and removes the footer slogan, decorative callouts, repeated architecture descriptions and blue metadata links. See `theme-provenance.json` for the retained Bridge input and deliberate shared-token changes. This source copy is byte-identical to the active prototype, apart from this README.

See [the review's proof and limits](../review.md#proof-and-limits) and its screenshot gallery. The retained checks cover the frontend and example server, not the protected production system. There is no automated product test suite in this artifact. Audit durability, complete keyboard/screen-reader behaviour and deployed integrations remain unverified.
