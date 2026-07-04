# 13 - S5b MCP Portal Identity Removal

Purpose:
- Remove the managed OpenClaw MCP Portal plugin identity from the delivered
  managed runtime and image.

Source anchors:
- CUT managed OpenClaw residue rules.
- CUT Tool Portal backend taxonomy.

Owned write surface:
- `packages/agent-vm/package.json`
- `packages/agent-vm/src/image/managed-image-dockerfile.ts`
- `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/e2e-harness.ts`
- `tsconfig.base.json`
- Any managed-image/package load identity references to
  `@agent-vm/openclaw-mcp-portal-plugin`

Dependencies:
- S7.
- Runs in final removal phase with S5a.

Checkpoint:
- Managed OpenClaw installs/registers Tool Portal surface, not MCP Portal
  plugin identity.
- Image build claim has smoke proof or is removed from the claim.

Proof rows:
- RESIDUE-4
- RESIDUE-1 shippable identity subset

Commands:
- `pnpm test:unit`
- `pnpm check`
- `pnpm run test:e2e:host-docker` if claiming image rebuild proof

Split trigger:
- Split image build proof if host Docker prerequisites are unavailable.
