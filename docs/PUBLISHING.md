# Publishing Packages to npm

All packages are published under the `@shravansunder/` scope on npm (public).

## Packages (dependency order)

```
1. @shravansunder/gondolin-core        ← no internal deps
2. @shravansunder/gateway-interface     ← depends on gondolin-core
3. @shravansunder/openclaw-agent-vm-plugin  ← depends on gondolin-core
4. @shravansunder/openclaw-gateway      ← depends on gateway-interface, gondolin-core
5. @shravansunder/worker-gateway        ← depends on gateway-interface, gondolin-core
6. @shravansunder/agent-vm-worker       ← no internal deps (standalone)
7. @shravansunder/agent-vm              ← depends on all of the above
```

Always publish in this order. Leaves first, agent-vm last.

## How workspace:* Works

The monorepo uses `workspace:*` in package.json for internal deps. When `pnpm publish` runs, it **automatically rewrites** `workspace:*` to the concrete version from the sibling's local package.json.

**Critical:** If your deps say `workspace:0.0.7` (pinned) instead of `workspace:*`, pnpm publishes the literal `0.0.7` regardless of what version the sibling is at. Always use `workspace:*` for internal deps.

## Publishing Steps

### 1. Build everything

```bash
pnpm install
pnpm build
```

All packages must build successfully before publishing.

### 2. Bump versions

Set ALL packages to the same version:

```bash
for pkg in packages/gondolin-core packages/gateway-interface packages/openclaw-agent-vm-plugin packages/openclaw-gateway packages/worker-gateway packages/agent-vm-worker packages/agent-vm; do
  (cd "$pkg" && npm version 0.1.0 --no-git-tag-version) || break
done
pnpm install   # regenerate lockfile with new versions
```

### 3. Publish in dependency order

```bash
WD=$(pwd)
cd "$WD/packages/gondolin-core" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/gateway-interface" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/openclaw-agent-vm-plugin" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/openclaw-gateway" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/worker-gateway" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/agent-vm-worker" && pnpm publish --access public --no-git-checks && \
cd "$WD/packages/agent-vm" && pnpm publish --access public --no-git-checks
```

### 4. Verify

```bash
npm view @shravansunder/agent-vm@0.1.0 dependencies
# All @shravansunder/* deps should point to 0.1.0
```

### 5. Test global install

```bash
pnpm add -g @shravansunder/agent-vm@0.1.0
agent-vm --help
```

## Gotchas

### Use `pnpm publish`, not `npm publish`

`npm publish` returns 404 for scoped packages with our npm token. `pnpm publish` works. The token is a legacy automation token from 1Password (`op://agent-vm/npm-token/credential`).

### Never use `--ignore-scripts` with `pnpm publish`

`--ignore-scripts` skips the `workspace:*` rewriting. The published package will have `workspace:*` in its deps, which npm can't resolve.

### Don't use `workspace:X.X.X` (pinned)

Always use `workspace:*` (star). Pinned versions like `workspace:0.0.7` get published as the literal string `0.0.7`, even if the sibling is at a different version. This causes "version not found" errors.

### npm token setup

```bash
# Read token from 1Password
export NPM_TOKEN="$(op read 'op://agent-vm/npm-token/credential')"

# Set in .npmrc (project-level, gitignored)
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
```

Or rely on `pnpm publish` which reads the token from the environment or .npmrc.

### Version conflicts

If a version is already taken on npm, you can't republish it. Bump to a new version. npm versions are immutable — even if you unpublish, the version is reserved for 24 hours.

## One-Liner (after versions are bumped)

```bash
WD=$(pwd) && for pkg in gondolin-core gateway-interface openclaw-agent-vm-plugin openclaw-gateway worker-gateway agent-vm-worker agent-vm; do (cd "$WD/packages/$pkg" && pnpm publish --access public --no-git-checks) || break; done
```
