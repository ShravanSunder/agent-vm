import { JsonObjectSchema, type JsonObject } from '@agent-vm/agent-portal-sdk';
import type { GogCommandDescriptor } from '@agent-vm/oauth-broker-contracts';

/** Describe the same finite file argument positions enforced by the controller. */
export function configuredGogFileDiscovery(
	descriptors: readonly GogCommandDescriptor[],
): JsonObject | undefined {
	const commands = descriptors.filter(
		(descriptor) =>
			(descriptor.positionals.fileInputs?.length ?? 0) > 0 ||
			descriptor.flags.some((flag) => flag.kind === 'file-path'),
	);
	if (commands.length === 0) return undefined;
	return JsonObjectSchema.parse({
		inputRoot: '/work',
		maximumFileBytes: 16 * 1024 * 1024,
		maximumRetainedBytes: 64 * 1024 * 1024,
		operationReferenceTtlMs: 60 * 60_000,
		instructions:
			'Inputs are relative to /work in your current Tool VM, not the terminal cwd. Gog file commands run in a private operation folder; specify an explicit relative --out or --out-dir. Terminal-based tools can read the actual returned read-only /agent-vm/files path directly. Structured Sandbox filesystem requests remain /work-relative: copy the selected file into /work first for that API. Files expire at expiresAtMs or when this Tool VM closes, whichever comes first; reads do not extend the one-hour lifetime. Copy wanted files into /workspace before expiry. File availability does not mean Gog succeeded; check exitCode. Google disconnect does not recall published files. Absolute CLI paths, traversal, raw stdout and inline payloads are not admitted.',
		commands: commands.map((descriptor) => ({
			operationId: descriptor.operationId,
			paths: descriptor.paths,
			inputPositions: descriptor.positionals.fileInputs ?? [],
			fileFlags: descriptor.flags.filter((flag) => flag.kind === 'file-path'),
		})),
	});
}
