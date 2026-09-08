import { createHash } from 'node:crypto';

// Shravan approved only PR136's two promise observers. Any byte/version change
// needs fresh approval; see docs/architecture/gondolin-patches.md.
export const APPROVED_GONDOLIN_PATCH_PATH = 'patches/@earendil-works__gondolin@0.12.0.patch';
export const APPROVED_GONDOLIN_PATCH_HASH =
	'c563880418a951c6b251f8ffef47c3b2f4784a3c3257b27901bd8d9ee1856473';
export const APPROVED_INSTALLED_GONDOLIN_PATH = `node_modules/.pnpm/@earendil-works+gondolin@0.12.0_patch_hash=${APPROVED_GONDOLIN_PATCH_HASH}/node_modules/@earendil-works/gondolin/package.json`;

interface PatchAuditSource {
	readonly filePath: string;
	readonly content: string;
}

export function isApprovedGondolinPatchPresent(sources: readonly PatchAuditSource[]): boolean {
	return sources.some(
		(source) =>
			source.filePath.replaceAll('\\', '/') === APPROVED_GONDOLIN_PATCH_PATH &&
			createHash('sha256').update(source.content).digest('hex') === APPROVED_GONDOLIN_PATCH_HASH,
	);
}

/** Exempt only the exact approved registration; residual patch/override data is audited normally. */
export function withoutApprovedGondolinPatchRegistration(source: PatchAuditSource): string {
	const approvedRegistration =
		source.filePath === 'pnpm-workspace.yaml'
			? `patchedDependencies:\n  '@earendil-works/gondolin@0.12.0': ${APPROVED_GONDOLIN_PATCH_PATH}`
			: source.filePath === 'pnpm-lock.yaml'
				? `patchedDependencies:\n  '@earendil-works/gondolin@0.12.0':\n    hash: ${APPROVED_GONDOLIN_PATCH_HASH}\n    path: ${APPROVED_GONDOLIN_PATCH_PATH}`
				: undefined;
	if (approvedRegistration === undefined) return source.content;
	return source.content.replace(/^patchedDependencies:\n(?:[ \t]+[^\n]*(?:\n|$))+/mu, (block) =>
		block.trimEnd() === approvedRegistration ? '' : block,
	);
}
