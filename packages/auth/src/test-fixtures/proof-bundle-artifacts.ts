import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import { z } from 'zod';

import { requirePrivateRuntimePath } from '#auth/native-owner-cli/auth-target';

const proofEntries = {
	auth: 'packages/auth/src/test-fixtures/auth-proof-entrypoint.ts',
	gateway: 'packages/tool-host-cloudflare/src/test-fixtures/auth-gateway-proof-entrypoint.ts',
} as const;

const bundleIdentitySchema = z.strictObject({ file: z.string(), sha256: z.string().length(64) });
export const proofBundleManifestSchema = z.strictObject({
	auth: bundleIdentitySchema,
	gateway: bundleIdentitySchema,
	configurationSource: z.string().length(64),
	clientSource: z.string().length(64),
});
export type ProofBundleManifest = z.infer<typeof proofBundleManifestSchema>;

export function proofDigest(contents: string): string {
	return createHash('sha256').update(contents).digest('hex');
}

export async function proofSourceIdentities(root: string): Promise<{
	readonly configurationSource: string;
	readonly clientSource: string;
}> {
	const sources = await Promise.all(
		[
			'packages/auth/src/test-fixtures/local-auth-harness.ts',
			'packages/auth/src/test-fixtures/native-cli-proof.ts',
			'packages/auth/src/native-owner-cli/owner-cli.ts',
			'packages/auth/src/native-owner-cli/owner-cli-login.ts',
		].map((file) => readFile(path.join(root, file), 'utf8')),
	);
	return {
		configurationSource: proofDigest(sources[0] ?? ''),
		clientSource: proofDigest(JSON.stringify(sources.slice(1))),
	};
}

async function bundleProofWorker(root: string, name: keyof typeof proofEntries): Promise<string> {
	const result = await build({
		absWorkingDir: root,
		entryPoints: [proofEntries[name]],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		conditions: ['workerd', 'worker', 'browser'],
		mainFields: ['module', 'main'],
		external: ['cloudflare:workers', 'node:*'],
		logLevel: 'silent',
	});
	const output = result.outputFiles?.[0];
	if (output === undefined) throw new Error('Worker bundle is empty');
	return output.text;
}

/** Freeze the exact executable module bytes before the runner discovers or executes observations. */
export async function prepareProofBundles(
	root: string,
	evidence: string,
): Promise<ProofBundleManifest> {
	const identities = await Promise.all(
		(['auth', 'gateway'] as const).map(async (name) => {
			const contents = await bundleProofWorker(root, name);
			const file = path.join(evidence, `${name}.mjs`);
			await writeFile(file, contents, { mode: 0o600, flag: 'wx' });
			return { file, sha256: proofDigest(contents) };
		}),
	);
	return proofBundleManifestSchema.parse({
		auth: identities[0],
		gateway: identities[1],
		...(await proofSourceIdentities(root)),
	});
}

/** C4 executes only predeclared bytes. Direct diagnostic tests may still bundle their current source. */
export async function loadProofBundles(root: string): Promise<{
	readonly auth: string;
	readonly gateway: string;
	readonly identity: ProofBundleManifest | null;
}> {
	const manifestFile = process.env.AUTH_PROOF_MANIFEST_FILE;
	if (manifestFile === undefined) {
		const [auth, gateway] = await Promise.all([
			bundleProofWorker(root, 'auth'),
			bundleProofWorker(root, 'gateway'),
		]);
		return { auth, gateway, identity: null };
	}
	const identity = proofBundleManifestSchema.parse(
		JSON.parse(await readFile(await requirePrivateRuntimePath(manifestFile, true), 'utf8')),
	);
	const actualSources = await proofSourceIdentities(root);
	if (
		actualSources.configurationSource !== identity.configurationSource ||
		actualSources.clientSource !== identity.clientSource
	)
		throw new Error('Proof fixture source differs from the declared configuration/client');
	const [auth, gateway] = await Promise.all(
		(['auth', 'gateway'] as const).map(async (name) => {
			const contents = await readFile(
				await requirePrivateRuntimePath(identity[name].file, true),
				'utf8',
			);
			if (proofDigest(contents) !== identity[name].sha256)
				throw new Error('Executed proof module differs from its declared artifact');
			return contents;
		}),
	);
	if (auth === undefined || gateway === undefined) throw new Error('Incomplete proof bundle');
	return { auth, gateway, identity };
}

/** The receipt identifies actual runtime inputs without copying cookies, tokens or private key material. */
export async function recordProofHarness(props: {
	readonly receiptId: string;
	readonly identity: ProofBundleManifest | null;
	readonly configuration: unknown;
	readonly client: unknown;
	readonly ready: boolean;
}): Promise<void> {
	const manifestFile = process.env.AUTH_PROOF_MANIFEST_FILE;
	if (manifestFile === undefined || props.identity === null) return;
	const directory = path.dirname(await requirePrivateRuntimePath(manifestFile, true));
	await writeFile(path.join(directory, `harness-${props.receiptId}.json`), JSON.stringify(props), {
		mode: 0o600,
	});
}
