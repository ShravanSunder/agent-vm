# Support package extraction closure at H

Target `2dfea38e8dcdd01fce28d811ed5ec8db45c25023`. Scope: production source and declarations in config-contracts, oauth-broker, oauth-approval-ui against the owner's ripped-package set. No build, test, network or runtime proof. Parent owns SDK/Node transitive closure.

source: No direct production import/export/dynamic-import/require or cross-package relative-path reference from these three packages to a ripped package was found. Searches covered full package trees for ripped names/paths and production src for all @agent workspace import specifiers; tests were excluded from production results. (H packages/config-contracts/src; packages/oauth-broker/src; packages/oauth-approval-ui/src; git grep exact ripped-package names and ../ cross-package paths)

source: No ripped package is declared in these three manifests, so there is no stale ripped dependency declaration here to remove. config-contracts workspace dependencies are tool-access, tool-host-node and oauth-broker-contracts, all kept; oauth-broker workspace dependencies are tool-access, config-contracts and oauth-broker-contracts, all kept; UI workspace dependency is oauth-broker-contracts, kept. (packages/config-contracts/package.json:37-42; packages/oauth-broker/package.json:42-49; packages/oauth-approval-ui/package.json:37-40)

source: config-contracts has a real source dependency on kept tool-host-node: `standaloneToolPortalConfigSchema`, `validateStandaloneToolPortalConfig`, and type `StandaloneToolPortalConfig`; the first two are used at runtime by the union schema/refinement, not merely manifest declarations. (packages/config-contracts/src/tool-portal-config.ts:19-23,673-678)

source: config-contracts has real kept tool-access imports for configured-CLI/Google/schema authorization contracts and `toolPortalNamespaceAllowsOperation`; OAuth contracts imports remain within kept oauth-broker-contracts. (packages/config-contracts/src/controller-configured-cli.ts:3-15; tool-portal-config.ts:1-18; oauth-tool-portal-config.ts:4-25)

source: Broker imports kept config-contracts types `OAuthConfig`/`ResolvedOAuthConfig`, kept tool-access Google identity types/schemas, and kept oauth-broker-contracts. UI imports kept OAuth application/service IDs and policy types/schemas. None is a source dependency on the removed Agent VM controller composition that formerly called them. (packages/oauth-broker/src/google/google-authorization-commit.ts:3-11; google-oauth-broker-service.ts:1-19; google-provider-authorization-callback.ts:1-11; packages/oauth-approval-ui/src/contracts.ts:1; server/oauth-account-policy-renderer.tsx:1-7)

source: `controller-configured-cli.ts` has no imported VM/controller/execution package. It contains schema/validation/serialization decisions, but is not platform-free: `isIP` is imported from node:net and used by `configuredCliExactNetworkHostSchema`; `Buffer.byteLength` enforces UTF-8 credential path size; prepared-image encode/decode uses Buffer base64url. (packages/config-contracts/src/controller-configured-cli.ts:1,101-129,319-365)

source: The config-contracts public root exports controller-configured-cli, JSON file loader, OAuth file/schema/compiler and Portal schema/loader. JSON loader imports Node fs and reads JSONC; `loadOAuthConfig`/`loadToolPortalConfig` call it. Thus Node loading is an actual public-root dependency, not a stale declaration or a ripped-package dependency. (packages/config-contracts/src/index.ts:1-10; json-config-file.ts:1-38; oauth-config.ts:264-265; tool-portal-config.ts:793-794)

source: The OAuth compiler in config-contracts imports Node crypto/path; it uses `path.basename` to validate Gog executable and SHA-256 to compute compiled-command/default revisions. These also are retained Node dependencies, not references to a ripped package. (packages/config-contracts/src/oauth-tool-portal-config.ts:1-2,110-125,206-211,505-519)

source: Broker still depends on Node crypto/fs/path/url, better-sqlite3 and Drizzle, and real Google HTTP, but those are external/runtime dependencies retained by its own source rather than any ripped package. (packages/oauth-broker/src/oauth-credential-catalog.ts:1-9,38-68; google/google-oauth-adapter.ts:210-222,249-266)

source: UI still depends on Node fs asset loading, Hono SSR and browser DOM, again without a ripped-package import. (packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx:1-5,53-69; src/browser/entry.tsx:1-24)

source: All three prepack scripts delegate to repository-root `pnpm -C ../.. build`; package-local tsdown entries are local source entrypoints. This is workspace build coupling, not a declaration/import requiring a ripped package. Root build adaptation is outside this bounded source-import question. (packages/config-contracts/package.json:31-35; packages/oauth-broker/package.json:36-40; packages/oauth-approval-ui/package.json:31-35; their tsdown.config.ts:6)

inference: There is no direct ripped-package source or manifest blocker in these three packages. This is not a whole-repository extraction success claim: config-contracts reaches kept tool-host-node and tool-access, whose transitive closure is the parent's assignment, and all package builds still need the surviving workspace's root tooling. (preceding anchors)

gaps: Transitive kept-package closure and actual compilation/runtime execution were not checked in this follow-up; parent owns SDK/Node closure, and separately authorized extraction validation would settle build/runtime behavior.
