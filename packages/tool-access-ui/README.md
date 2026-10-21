# Tool Access UI

Reusable React panel for inspecting Tool Portal access and reviewing one editable
proposal at a time. Its publication name is `@agent-collaboration/tool-access-ui`.
The package has no dependency on agent-vm, a host runtime, authorization, credentials
or storage. It ports the checked October 20 admin-panel design and its base-mira
shadcn registry components, `cn` compositions and `#1C2026` theme.

Provide a stable `ToolAccessPanelPort` to `ToolAccessPanel` and import
`@agent-collaboration/tool-access-ui/styles.css` in the consuming application.
React and React DOM 19 are peer dependencies. The public entry exports the view
contracts; `@agent-collaboration/tool-access-ui/fixture` exports the demonstration port.

## Ownership

The panel owns navigation, filters and unaccepted draft edits. The port owns the
organization/person view, confirmed associations, accounts and audit events. Its
`read(filters)` returns both the complete association view (for scope and account
details) and the filtered rows. Filtering by agent does not narrow a profile edit.
Personal account rules carry account, agent and application scope explicitly.

`proposeChange` returns an editable draft with its base revision and current scope.
`acceptProposal` receives the edited draft and returns `accepted`, `rejected`,
`stale` or `unconfirmed`. Only `accepted` replaces the view, closes the draft and
shows success. A stale result refreshes current values for renewed review. An
unconfirmed result, including a lost response, requires a state read before another
decision. Hosts remain responsible for command idempotency and resolving ambiguous
outcomes. A thrown error never implies that a write failed to happen.

`denyProposal` retires a draft without changing configuration or audit. `scan`
returns explicitly labelled example, static or live results with a check time.
Adapters must parse their untrusted inputs, authorize every command independently,
retain real audit records, and return only confirmed state. The port is a browser
view contract, not an authorization protocol or a persisted data format.

## Stand-ins and slots

`createToolAccessPanelFixture()` is an **in-memory stand-in**. It performs no host,
provider, auth, model or credential calls. Reload resets it. Its revision and audit
exist only for demonstrating the panel contract; they establish no durable or
production authorization guarantee. The request bar uses deterministic fixture
routing. It never calls Jev or OpenRouter and never reads a credential.

Only mode proposals are implemented editors. Auto remains a labelled slot with
acceptance disabled. Approved until is disabled and describes the future return
to the prior mode. Full profile/agent/provider configuration, people/organization,
credential/OAuth entry, account rename/assignment/disconnection, exact-call approval,
Fleet and Tool VM remain labelled integration slots. Workspaces are a later layer;
the current scope is the organization. No configuration fields or storage are
invented for these slots.

## Run from the monorepo root

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-access-ui build
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-access-ui preview --host 127.0.0.1 --port 50826
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-access-ui typecheck
mise exec node@24.7.0 -- pnpm vitest run --project unit packages/tool-access-ui/src
mise exec node@24.7.0 -- pnpm vitest run --project e2e-host packages/tool-access-ui/src/panel-packed-consumer.host.e2e.test.ts
mise exec node@24.7.0 -- pnpm check
mise exec node@24.7.0 -- pnpm test:unit
```

The demo is a built browser composition of the same exported panel and fixture.
The unit lane runs real React/registry components and fixture readback in jsdom,
including held/rejected/unconfirmed port outcomes. The packed-consumer host test
requires the build, packs and installs into an isolated OS-temp project, imports
both JavaScript entrypoints and CSS, and blocks Node/host imports at runtime.
These checks prove the panel contract; they do not prove a real host integration.

Registry changes are limited to import paths, explicit return types and strict
TypeScript/lint corrections; the stock sidebar cookie write was removed because
this panel does not choose a storage mechanism. Registry recipes retain their
visual classes. The 686-line sidebar remains one upstream registry composition,
with no product policy in it. Theme CSS is retained from the mock; no new control
paint or layout stylesheet is introduced.

## Workspace wiring

- `packages/*` already registers the package in pnpm.
- Root TypeScript excludes this React package from its Hono JSX compilation;
  recursive package typechecking checks every panel `.ts` and `.tsx` with React.
- Vitest adds the package-local source alias. Tests keep the existing audited
  `.unit.test.ts` suffix; only the component test selects jsdom.
- Oxlint's existing automatic-JSX override also covers this package.
- `pnpm-lock.yaml` records the UI/runtime/test dependencies. No existing package
  source or runtime is changed.
