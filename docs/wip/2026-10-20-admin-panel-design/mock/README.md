> **On this branch:** only this README and the evidence (screenshots and check logs) are committed. The runnable mock's source is kept out, because a prototype app here breaks the repository's lint and format gates. It lives in the design worktree at `agent-vm.design-portable-tool-portal-hosts/docs/wip/2026-10-20-admin-panel-design/mock/`.

# Tool Portal panel mock

Copy of `../../2026-10-18-agent-vm-review/react-prototype`, retaining base-mira components, the cn library, pinned dependency lock, shadcn/Oxlint rules and Oxfmt config. The old page components and fixture mutation API were replaced by the associated access view and browser-memory example proposals. Reload resets changes.

From the repository root:

```sh
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock install --frozen-lockfile
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock run typecheck
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock run lint
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock run format:check
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock run build
pnpm --dir docs/wip/2026-10-20-admin-panel-design/mock start
```

Start prints a loopback URL on an ephemeral port. Lint runs Oxlint with the configured `@shadcn/lint` plugin; it is the shadcn lint gate, not a separate guessed CLI command.

Try Show email access → Submit request. Then Block send email → Submit request. Change the proposed mode, deny it and observe no change, or accept it and inspect Audit log. Accounts → Open account shows account details and connection requirements. Show scan displays example connection results. Use `?scenario=unavailable` to retain a failed proposal draft. Auto is a labelled unavailable slot. Sign-in preview displays Better Auth's choices but performs no sign-in.

This is a presentation mock. No model, credentials, auth service, provider call, protected command, persistent store, VM or production authorization is exercised. The local static server serves assets only. Do not put real secrets into it.
