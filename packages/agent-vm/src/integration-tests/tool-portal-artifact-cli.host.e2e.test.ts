import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	startStandaloneToolPortalMcpHttpServer,
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalArtifactReader,
	type StandaloneToolPortalFixedCredentialPrincipal,
	type StandaloneToolPortalMcpHttpServer,
	type StandaloneToolPortalProjectionService,
} from '@agent-vm/tool-portal';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	encodeCanonicalJson,
	type ArtifactReference,
	type PortalArtifactReadRequest,
} from '../../../agent-portal-sdk/src/index.js';
import {
	createGatewayRuntimeArtifactReadAuthorityResolver,
	createGatewayRuntimeArtifactStore,
	type GatewayRuntimeArtifactAuthorization,
	type GatewayRuntimeArtifactCurrentAuthorityDecision,
	type GatewayRuntimeArtifactStorageBackend,
	type GatewayRuntimeArtifactStorageWriter,
	type GatewayRuntimeArtifactStore,
} from '../../../gateway-runtime/src/index.js';

const repoRoot = process.cwd();
const sdkDirectory = path.join(repoRoot, 'packages', 'agent-portal-sdk');
const artifactCredentialA = 'test-only-artifact-credential-a';
const artifactCredentialB = 'test-only-artifact-credential-b';
const artifactNowMilliseconds = Date.parse('2026-07-13T12:00:00.000Z');
const artifactBytes = Uint8Array.from([1, 2, 3, 4]);
const standaloneServiceGeneration = 'standalone-service:artifact-cli:1';
const standaloneArtifactDenialDiagnostic =
	'tool-portal: MCP error -32600: MCP error -32600: Standalone Tool Portal artifact read failed.\n';

interface PackedCliFixture {
	readonly binPath: string | undefined;
	readonly packageManifest: Readonly<Record<string, unknown>>;
	readonly rootDirectory: string;
}

interface InMemoryArtifactStorage {
	readonly backend: GatewayRuntimeArtifactStorageBackend;
	readonly readRequests: Array<{
		readonly artifactId: string;
		readonly maxBytes: number;
		readonly offsetBytes: number;
	}>;
}

interface StandaloneArtifactCliFixture {
	readonly authorization: GatewayRuntimeArtifactAuthorization;
	readonly close: () => Promise<void>;
	readonly controls: {
		currentOwningGeneration: string;
		nowMilliseconds: number;
	};
	readonly endpoint: string;
	readonly reference: ArtifactReference;
	readonly storageReadRequests: InMemoryArtifactStorage['readRequests'];
	readonly store: GatewayRuntimeArtifactStore;
}

const artifactPrincipalA = {
	agentId: 'artifact-agent-a',
	profileAssignmentRevision: 'profile-assignment:artifact-agent-a:1',
	toolPortalProfileId: 'artifact-reader',
} satisfies StandaloneToolPortalFixedCredentialPrincipal;

const artifactPrincipalB = {
	agentId: 'artifact-agent-b',
	profileAssignmentRevision: 'profile-assignment:artifact-agent-b:1',
	toolPortalProfileId: 'artifact-reader',
} satisfies StandaloneToolPortalFixedCredentialPrincipal;

const storedArtifactFrameworkIdentity = {
	agentId: artifactPrincipalA.agentId,
	kind: 'openclaw',
} as const;

const artifactAuthorization = {
	agentId: artifactPrincipalA.agentId,
	capability: { name: 'read_artifact', namespace: 'fixture' },
	executionFingerprint: 'execution-fingerprint-artifact-cli-a',
	frameworkIdentity: storedArtifactFrameworkIdentity,
	operationId: 'artifact-operation-a',
	owningGeneration: 'artifact-generation-a',
	profileAssignmentRevision: artifactPrincipalA.profileAssignmentRevision,
	surfaceClass: 'mcp',
	toolPortalProfileId: artifactPrincipalA.toolPortalProfileId,
} as const satisfies GatewayRuntimeArtifactAuthorization;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createInMemoryArtifactStorage(): InMemoryArtifactStorage {
	const bytesByArtifactId = new Map<string, Uint8Array>();
	const readRequests: InMemoryArtifactStorage['readRequests'] = [];
	const backend: GatewayRuntimeArtifactStorageBackend = {
		createWriter: async (artifactId: string): Promise<GatewayRuntimeArtifactStorageWriter> => {
			const chunks: Uint8Array[] = [];
			return {
				commit: async (): Promise<void> => {
					const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
					bytesByArtifactId.set(artifactId, Uint8Array.from(bytes));
				},
				discard: async (): Promise<void> => {
					bytesByArtifactId.delete(artifactId);
				},
				write: async (chunk: Uint8Array): Promise<void> => {
					chunks.push(Uint8Array.from(chunk));
				},
			};
		},
		readRange: async (request): Promise<Uint8Array> => {
			readRequests.push(request);
			const bytes = bytesByArtifactId.get(request.artifactId);
			if (bytes === undefined) throw new Error('In-memory artifact bytes are unavailable.');
			return bytes.slice(request.offsetBytes, request.offsetBytes + request.maxBytes);
		},
		remove: async (artifactId: string): Promise<void> => {
			bytesByArtifactId.delete(artifactId);
		},
	};
	return { backend, readRequests };
}

async function rejectUnexpectedToolPortalCall(): Promise<never> {
	throw new Error('Artifact CLI proof must not invoke a Tool Portal tool.');
}

function createArtifactOnlyToolPortalService(): StandaloneToolPortalProjectionService {
	return {
		call: rejectUnexpectedToolPortalCall,
		describe: rejectUnexpectedToolPortalCall,
		list: rejectUnexpectedToolPortalCall,
		search: rejectUnexpectedToolPortalCall,
	};
}

function createStandaloneArtifactReaderAdapter(
	store: GatewayRuntimeArtifactStore,
): StandaloneToolPortalArtifactReader {
	return {
		read: async ({ caller, request }) => {
			const authenticatedPrincipal = caller.authenticatedEnvelope.principal;
			if (
				caller.authenticatedEnvelope.audience !== TOOL_PORTAL_MCP_BEARER_AUDIENCE ||
				caller.authenticatedEnvelope.serviceGeneration !== standaloneServiceGeneration ||
				authenticatedPrincipal.agentId !== artifactAuthorization.agentId ||
				authenticatedPrincipal.profileAssignmentRevision !==
					artifactAuthorization.profileAssignmentRevision ||
				authenticatedPrincipal.toolPortalProfileId !== artifactAuthorization.toolPortalProfileId
			) {
				throw new Error('Standalone Tool Portal artifact read is not authorized.');
			}
			return await store.read({
				caller: {
					principal: {
						agentId: artifactAuthorization.agentId,
						frameworkIdentity: artifactAuthorization.frameworkIdentity,
						profileAssignmentRevision: artifactAuthorization.profileAssignmentRevision,
						toolPortalProfileId: artifactAuthorization.toolPortalProfileId,
					},
					surfaceClass: caller.surfaceClass,
				},
				request,
			});
		},
	};
}

function artifactReadRequest(
	reference: ArtifactReference,
	overrides: Partial<Omit<PortalArtifactReadRequest, 'reference'>> = {},
): PortalArtifactReadRequest {
	return { maxBytes: 2, offsetBytes: 0, reference, ...overrides };
}

async function startStandaloneArtifactCliFixture(): Promise<StandaloneArtifactCliFixture> {
	const controls = {
		currentOwningGeneration: artifactAuthorization.owningGeneration,
		nowMilliseconds: artifactNowMilliseconds,
	};
	const storage = createInMemoryArtifactStorage();
	const authorityResolver = createGatewayRuntimeArtifactReadAuthorityResolver({
		currentAuthority: {
			authorizeStoredArtifact: (authorization): GatewayRuntimeArtifactCurrentAuthorityDecision =>
				authorization.owningGeneration === controls.currentOwningGeneration
					? { kind: 'current' }
					: { kind: 'retired', reason: 'owning-generation' },
		},
	});
	const store = createGatewayRuntimeArtifactStore({
		authorityResolver,
		createArtifactId: () => 'artifact-cli-a',
		epochId: 'gateway-epoch-artifact-cli-a',
		limits: {
			maximumArtifactBytes: 16,
			maximumArtifactCount: 4,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 64,
		},
		now: () => controls.nowMilliseconds,
		storageBackend: storage.backend,
	});
	const writeHandle = await store.beginWrite({
		authorization: artifactAuthorization,
		lifetimeMs: 30_000,
		maximumBytes: artifactBytes.byteLength,
		mediaType: 'application/octet-stream',
	});
	await writeHandle.write(artifactBytes);
	const reference = await writeHandle.commit();
	const server: StandaloneToolPortalMcpHttpServer = await startStandaloneToolPortalMcpHttpServer({
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		artifactReader: createStandaloneArtifactReaderAdapter(store),
		credentialSet: {
			audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
			credentials: [
				{
					bearerToken: artifactCredentialA,
					credentialVersion: 1,
					principal: artifactPrincipalA,
				},
				{
					bearerToken: artifactCredentialB,
					credentialVersion: 1,
					principal: artifactPrincipalB,
				},
			],
			serviceGeneration: standaloneServiceGeneration,
		},
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/agent-vm/tool-portal/mcp',
		service: createArtifactOnlyToolPortalService(),
	});
	return {
		authorization: artifactAuthorization,
		close: async (): Promise<void> => {
			await server.retire();
			await store.retireEpoch();
		},
		controls,
		endpoint: server.endpoint.href,
		reference,
		storageReadRequests: storage.readRequests,
		store,
	};
}

async function preparePackedCliFixture(): Promise<PackedCliFixture> {
	const rootDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-tool-portal-artifact-cli-'));
	const packDirectory = path.join(rootDirectory, 'pack');
	const consumerDirectory = path.join(rootDirectory, 'consumer');
	await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);
	await writeFile(
		path.join(consumerDirectory, 'package.json'),
		JSON.stringify({
			name: 'tool-portal-artifact-cli-host-fixture',
			private: true,
			type: 'module',
		}),
		'utf8',
	);
	await execa(
		'pnpm',
		[
			'--dir',
			sdkDirectory,
			'pack',
			'--pack-destination',
			packDirectory,
			'--config.ignore-scripts=true',
		],
		{ cwd: repoRoot, timeout: 60_000 },
	);
	const tarballNames = (await readdir(packDirectory)).filter((name) => name.endsWith('.tgz'));
	if (tarballNames.length !== 1) {
		throw new Error(
			`Expected one packed Agent Portal SDK tarball; found ${String(tarballNames.length)}.`,
		);
	}
	await execa(
		'pnpm',
		[
			'--dir',
			consumerDirectory,
			'add',
			'--offline',
			'--config.ignore-scripts=true',
			path.join(packDirectory, tarballNames[0] ?? ''),
		],
		{ cwd: repoRoot, timeout: 60_000 },
	);
	const packageDirectory = path.join(
		consumerDirectory,
		'node_modules',
		'@agent-vm',
		'agent-portal-sdk',
	);
	const packageManifest = JSON.parse(
		await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
	) as unknown;
	if (!isObjectRecord(packageManifest)) {
		throw new Error('Packed Agent Portal SDK manifest must be an object.');
	}
	const manifestBin = packageManifest['bin'];
	const binRelativePath = isObjectRecord(manifestBin) ? manifestBin['tool-portal'] : manifestBin;
	return {
		binPath:
			typeof binRelativePath === 'string'
				? path.join(packageDirectory, binRelativePath)
				: undefined,
		packageManifest,
		rootDirectory,
	};
}

function requireCliPath(fixture: PackedCliFixture): string {
	expect(fixture.packageManifest['bin']).toEqual({ 'tool-portal': 'dist/cli/tool-portal.js' });
	if (fixture.binPath === undefined) {
		throw new Error('Packed Agent Portal SDK does not expose the tool-portal executable.');
	}
	return fixture.binPath;
}

function explicitArtifactReadHttpArgs(props: {
	readonly endpoint: string;
	readonly request: PortalArtifactReadRequest;
}): readonly string[] {
	return [
		'artifact-read',
		'--input-json',
		encodeCanonicalJson(props.request),
		'--transport',
		'http',
		'--endpoint',
		props.endpoint,
		'--authorization-env',
		'TOOL_PORTAL_TEST_AUTHORIZATION',
	];
}

function cliEnvironment(homeDirectory: string, credential: string): NodeJS.ProcessEnv {
	return {
		HOME: homeDirectory,
		PATH: path.dirname(process.execPath),
		TOOL_PORTAL_TEST_AUTHORIZATION: credential,
	};
}

async function runCli(props: {
	readonly args: readonly string[];
	readonly cliPath: string;
	readonly env: NodeJS.ProcessEnv;
}): Promise<{
	readonly exitCode: number | undefined;
	readonly stderr: string;
	readonly stdout: string;
}> {
	const result = await execa(props.cliPath, props.args, {
		env: props.env,
		extendEnv: false,
		reject: false,
		stripFinalNewline: false,
		timeout: 15_000,
	});
	return {
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

describe('packed Tool Portal artifact CLI', () => {
	let fixture: PackedCliFixture;

	beforeAll(async () => {
		fixture = await preparePackedCliFixture();
	}, 120_000);

	afterAll(async () => {
		if (fixture?.rootDirectory !== undefined) {
			await rm(fixture.rootDirectory, { force: true, recursive: true });
		}
	});

	it('reads an authorized artifact range through MCP resources without a fifth tool', async () => {
		// Arrange
		const cliPath = requireCliPath(fixture);
		const artifactFixture = await startStandaloneArtifactCliFixture();
		const request = artifactReadRequest(artifactFixture.reference);

		try {
			// Act
			const result = await runCli({
				args: explicitArtifactReadHttpArgs({
					endpoint: artifactFixture.endpoint,
					request,
				}),
				cliPath,
				env: cliEnvironment(fixture.rootDirectory, artifactCredentialA),
			});

			// Assert
			expect(result).toEqual({
				exitCode: 0,
				stderr: '',
				stdout: `${encodeCanonicalJson({
					contentBase64: 'AQI=',
					mediaType: 'application/octet-stream',
					offsetBytes: 0,
					reference: artifactFixture.reference,
					truncated: true,
				})}\n`,
			});
			expect(artifactFixture.storageReadRequests).toEqual([
				{ artifactId: artifactFixture.reference.id, maxBytes: 2, offsetBytes: 0 },
			]);
		} finally {
			await artifactFixture.close();
		}
	});

	it.each([
		{ failureKind: 'expired', label: 'an expired artifact' },
		{ failureKind: 'cross-principal', label: 'a cross-principal credential' },
		{ failureKind: 'retired-epoch', label: 'a retired epoch' },
		{ failureKind: 'wrong-generation', label: 'retired current-generation authority' },
		{ failureKind: 'id-only', label: 'a matching ID with a tampered reference' },
		{ failureKind: 'invalid-range', label: 'an invalid range' },
	] as const)(
		'rejects $label through the real artifact authority chain',
		async ({ failureKind }) => {
			// Arrange
			const cliPath = requireCliPath(fixture);
			const artifactFixture = await startStandaloneArtifactCliFixture();
			let credential = artifactCredentialA;
			let request = artifactReadRequest(artifactFixture.reference);
			if (failureKind === 'expired') {
				artifactFixture.controls.nowMilliseconds = Date.parse(artifactFixture.reference.expiresAt);
			} else if (failureKind === 'cross-principal') {
				credential = artifactCredentialB;
			} else if (failureKind === 'retired-epoch') {
				await artifactFixture.store.retireEpoch();
			} else if (failureKind === 'wrong-generation') {
				artifactFixture.controls.currentOwningGeneration = 'artifact-generation-b';
			} else if (failureKind === 'id-only') {
				request = artifactReadRequest({
					...artifactFixture.reference,
					fingerprint: `sha256:${'b'.repeat(64)}`,
				});
			} else {
				request = artifactReadRequest(artifactFixture.reference, {
					offsetBytes: artifactFixture.reference.byteLength + 1,
				});
			}

			try {
				// Act
				const result = await runCli({
					args: explicitArtifactReadHttpArgs({
						endpoint: artifactFixture.endpoint,
						request,
					}),
					cliPath,
					env: cliEnvironment(fixture.rootDirectory, credential),
				});

				// Assert
				expect(result.exitCode).toBe(2);
				expect(result.stdout).toBe('');
				expect(result.stderr).toBe(standaloneArtifactDenialDiagnostic);
				expect(artifactFixture.storageReadRequests).toEqual([]);
				for (const forbiddenDiagnostic of [
					artifactCredentialA,
					artifactCredentialB,
					'/run/',
					'/work/',
					artifactFixture.reference.fingerprint,
					artifactFixture.authorization.executionFingerprint,
					artifactFixture.authorization.operationId,
					artifactFixture.authorization.owningGeneration,
					'In-memory artifact',
				]) {
					expect(result.stderr).not.toContain(forbiddenDiagnostic);
				}
			} finally {
				await artifactFixture.close();
			}
		},
	);
});
