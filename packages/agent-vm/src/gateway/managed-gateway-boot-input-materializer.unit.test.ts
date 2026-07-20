import { createHash } from 'node:crypto';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';
import {
	finalizeManagedGatewayBootInputs,
	materializeManagedGatewayBootInputs,
	type MaterializeManagedGatewayBootInputsProps,
	releaseManagedGatewayBootInputDirectory,
	reserveManagedGatewayBootInputDirectory,
} from './managed-gateway-boot-input-materializer.js';

const cleanupDirectories: string[] = [];

interface AuthoredSourceTreeSnapshot {
	readonly directoryEntries: readonly string[];
	readonly directoryMetadata: {
		readonly changedAtMs: number;
		readonly deviceId: number;
		readonly inode: number;
		readonly mode: number;
		readonly modifiedAtMs: number;
		readonly ownerGid: number;
		readonly ownerUid: number;
	};
	readonly files: Readonly<
		Record<
			string,
			{
				readonly changedAtMs: number;
				readonly contents: string;
				readonly deviceId: number;
				readonly inode: number;
				readonly mode: number;
				readonly modifiedAtMs: number;
				readonly ownerGid: number;
				readonly ownerUid: number;
				readonly size: number;
			}
		>
	>;
}

type ManagedGatewayMaterializationTestInput = Omit<
	Extract<
		MaterializeManagedGatewayBootInputsProps,
		{ readonly frameworkInputKind: 'configuration-only' }
	>,
	'parentDirectory' | 'toolPortalServiceConfig'
> & {
	readonly toolPortalServiceConfig: {
		readonly controlEndpoint: {
			readonly listen: {
				readonly host: string;
				readonly port: number;
			};
		};
		readonly runtimeRoot: string;
		readonly schemaVersion: 1;
	};
};

const expectedCohort = {
	controlIdentity: {
		controllerEpoch: 'controller-1',
		generationId: 'control-generation-1',
		peerId: 'tool-portal-control',
		processEpoch: 'tool-portal-process-1',
	},
	fence: {
		controllerEpoch: 'controller-1',
		gatewayEpoch: 'gateway-1',
		vmId: 'pending-before-vm-start',
		zoneId: 'zone-a',
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'openclaw-managed-plugin',
		configuredAgentIds: ['agent-a'],
		frameworkEpoch: 'framework-1',
		frameworkKind: 'openclaw',
		projectionCohortDigest:
			'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	},
	ingressIntent: {
		controlRoute: {
			audience: 'gateway-control',
			guestPort: 18_790,
			kind: 'tool-portal-control',
			prefix: '/_agent-vm/control',
			stripPrefix: true,
		},
		frameworkRootRoute: {
			guestPort: 18_789,
			kind: 'framework-root',
			prefix: '/',
			stripPrefix: true,
		},
	},
	providerRevision: 'provider-1',
	requiredBackendRevision: 'required-backends-1',
	semanticRevision: 'semantic-1',
	toolPortalIdentity: {
		processEpoch: 'tool-portal-process-1',
		role: 'tool-portal',
		runtimeEpoch: 'runtime-1',
		serviceId: 'tool-portal-service-1',
	},
	udsIdentity: {
		frameworkEpoch: 'framework-1',
		gatewayEpoch: 'gateway-1',
		runtimeEpoch: 'runtime-1',
		socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
	},
} satisfies GatewayExpectedAdmissionCohort;

async function createParentDirectory(): Promise<string> {
	const parentDirectory = await mkdtemp(path.join(os.tmpdir(), 'managed-gateway-inputs-test-'));
	cleanupDirectories.push(parentDirectory);
	return parentDirectory;
}

async function captureAuthoredSourceTreeSnapshot(
	directoryPath: string,
): Promise<AuthoredSourceTreeSnapshot> {
	const directoryEntries = (await readdir(directoryPath)).toSorted();
	const directoryStatus = await stat(directoryPath);
	const fileEntries = await Promise.all(
		directoryEntries.map(async (fileName) => {
			const filePath = path.join(directoryPath, fileName);
			const [contents, fileStatus] = await Promise.all([
				readFile(filePath, 'utf8'),
				stat(filePath),
			]);
			return [
				fileName,
				{
					changedAtMs: fileStatus.ctimeMs,
					contents,
					deviceId: fileStatus.dev,
					inode: fileStatus.ino,
					mode: fileStatus.mode & 0o777,
					modifiedAtMs: fileStatus.mtimeMs,
					ownerGid: fileStatus.gid,
					ownerUid: fileStatus.uid,
					size: fileStatus.size,
				},
			] as const;
		}),
	);
	return {
		directoryEntries,
		directoryMetadata: {
			changedAtMs: directoryStatus.ctimeMs,
			deviceId: directoryStatus.dev,
			inode: directoryStatus.ino,
			mode: directoryStatus.mode & 0o777,
			modifiedAtMs: directoryStatus.mtimeMs,
			ownerGid: directoryStatus.gid,
			ownerUid: directoryStatus.uid,
		},
		files: Object.fromEntries(fileEntries),
	};
}

function createMaterializationInput(
	secretCanary = 'not-a-real-secret-canary',
): ManagedGatewayMaterializationTestInput {
	return {
		cohort: expectedCohort,
		createdAt: new Date('2026-07-14T08:00:00.000Z'),
		frameworkConfig: { gateway: { mode: 'local', port: 18_789 } },
		frameworkEnvironment: {
			OPENCLAW_CONFIG_PATH: '/run/agent-vm/managed-gateway/framework-service.json',
			OPENCLAW_GATEWAY_TOKEN: secretCanary,
		},
		frameworkInputKind: 'configuration-only',
		mcpConfig: { providers: {}, schemaVersion: 1 },
		toolPortalEnvironment: {
			HOME: '/home/openclaw',
			PATH: '/pnpm:/usr/local/bin:/usr/bin:/bin',
		},
		toolPortalServiceConfig: {
			controlEndpoint: {
				listen: { host: '127.0.0.1', port: 18_790 },
			},
			runtimeRoot: '/run/agent-vm/gateway-runtime',
			schemaVersion: 1,
		},
	};
}

afterEach(async () => {
	await Promise.all(
		cleanupDirectories.splice(0).map(async (directoryPath) => {
			await rm(directoryPath, { force: true, recursive: true });
		}),
	);
});

describe('managed Gateway boot input materializer', () => {
	it('reserves one empty protected inode and finalizes the exact configuration-only inputs after the VM identity is known', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const reservedStatus = await stat(reservation.directoryPath);
		const exactCohort = {
			...expectedCohort,
			fence: { ...expectedCohort.fence, vmId: 'managed-vm-exact-id' },
		} satisfies GatewayExpectedAdmissionCohort;

		expect(await readdir(reservation.directoryPath)).toEqual([]);
		const receipt = await finalizeManagedGatewayBootInputs({
			...createMaterializationInput(),
			cohort: exactCohort,
			reservation,
		});
		const finalizedStatus = await stat(receipt.directoryPath);

		expect(reservation.identity).toEqual({
			deviceId: reservedStatus.dev,
			inode: reservedStatus.ino,
			ownerGid: reservedStatus.gid,
			ownerUid: reservedStatus.uid,
		});
		expect(finalizedStatus.dev).toBe(reservedStatus.dev);
		expect(finalizedStatus.ino).toBe(reservedStatus.ino);
		expect((await readdir(receipt.directoryPath)).toSorted()).toEqual([
			'framework-service.json',
			'framework.environment.sh',
			'mcp.config.json',
			'tool-portal-service.json',
			'tool-portal.environment.sh',
		]);
		expect(receipt.cohort.fence.vmId).toBe('managed-vm-exact-id');
	});

	it('materializes the Hermes managed config as the sixth protected input', async () => {
		const parentDirectory = await createParentDirectory();
		const { frameworkInputKind: _frameworkInputKind, ...commonInput } =
			createMaterializationInput();
		const frameworkManagedConfigurationSource = `# preserve this authored comment
plugins:
  enabled: [agent-vm-tool-portal]
  disabled: []
`;

		const receipt = await materializeManagedGatewayBootInputs({
			...commonInput,
			frameworkInputKind: 'hermes-managed-scope',
			frameworkManagedConfigurationSource,
			parentDirectory,
		});

		expect((await readdir(receipt.directoryPath)).toSorted()).toEqual([
			'config.yaml',
			'framework-service.json',
			'framework.environment.sh',
			'mcp.config.json',
			'tool-portal-service.json',
			'tool-portal.environment.sh',
		]);
		expect(await readFile(path.join(receipt.directoryPath, 'config.yaml'), 'utf8')).toBe(
			frameworkManagedConfigurationSource,
		);
	});

	it('rejects a reserved-root swap without touching the replacement directory', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const displacedDirectory = path.join(parentDirectory, 'displaced-reservation');
		await rename(reservation.directoryPath, displacedDirectory);
		await mkdir(reservation.directoryPath, { mode: 0o700 });
		const replacementMarkerPath = path.join(reservation.directoryPath, 'replacement-marker');
		await writeFile(replacementMarkerPath, 'replacement-owned');

		await expect(
			finalizeManagedGatewayBootInputs({
				...createMaterializationInput(),
				reservation,
			}),
		).rejects.toThrow('changed after reservation');

		expect(await readFile(replacementMarkerPath, 'utf8')).toBe('replacement-owned');
		expect((await stat(displacedDirectory)).isDirectory()).toBe(true);
	});

	it('rejects a symlink replacement without touching its target', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const displacedDirectory = path.join(parentDirectory, 'displaced-reservation');
		const replacementTarget = path.join(parentDirectory, 'replacement-target');
		await rename(reservation.directoryPath, displacedDirectory);
		await mkdir(replacementTarget, { mode: 0o700 });
		const targetMarkerPath = path.join(replacementTarget, 'target-marker');
		await writeFile(targetMarkerPath, 'target-owned');
		await symlink(replacementTarget, reservation.directoryPath, 'dir');

		await expect(
			finalizeManagedGatewayBootInputs({
				...createMaterializationInput(),
				reservation,
			}),
		).rejects.toThrow('changed after reservation');

		expect(await readFile(targetMarkerPath, 'utf8')).toBe('target-owned');
	});

	it('fails closed on unexpected input inventory and cannot finalize a failed reservation twice', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const unexpectedFilePath = path.join(reservation.directoryPath, 'unexpected-input');
		await writeFile(unexpectedFilePath, 'not-owned-by-materializer');

		await expect(
			finalizeManagedGatewayBootInputs({
				...createMaterializationInput(),
				reservation,
			}),
		).rejects.toThrow('unexpected inventory');
		expect(await readFile(unexpectedFilePath, 'utf8')).toBe('not-owned-by-materializer');
		await expect(
			finalizeManagedGatewayBootInputs({
				...createMaterializationInput(),
				reservation,
			}),
		).rejects.toThrow('cannot be finalized');
	});

	it('rejects second finalization after publishing the exact input cohort', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const input = createMaterializationInput();
		await finalizeManagedGatewayBootInputs({ ...input, reservation });

		await expect(finalizeManagedGatewayBootInputs({ ...input, reservation })).rejects.toThrow(
			'cannot be finalized',
		);
	});

	it('removes only owned partial inputs when finalization fails', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		const parentMarkerPath = path.join(parentDirectory, 'parent-marker');
		await writeFile(parentMarkerPath, 'parent-owned');

		await expect(
			finalizeManagedGatewayBootInputs({
				...createMaterializationInput(),
				mcpConfig: { providers: {}, unsupported: 1n },
				reservation,
			}),
		).rejects.toThrow('must contain only JSON values');

		await expect(stat(reservation.directoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(parentMarkerPath, 'utf8')).toBe('parent-owned');
	});

	it('releases only the finalized directory and files owned by the reservation', async () => {
		const parentDirectory = await createParentDirectory();
		const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
		await finalizeManagedGatewayBootInputs({
			...createMaterializationInput(),
			reservation,
		});

		await releaseManagedGatewayBootInputDirectory(reservation);

		await expect(stat(reservation.directoryPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('writes the exact protected input cohort and returns only non-secret hashes and identities', async () => {
		const parentDirectory = await createParentDirectory();
		const secretCanary = 'not-a-real-secret-canary';

		const receipt = await materializeManagedGatewayBootInputs({
			...createMaterializationInput(secretCanary),
			parentDirectory,
		});

		expect((await stat(receipt.directoryPath)).mode & 0o777).toBe(0o700);
		expect(receipt.files.map((file) => file.fileName)).toEqual([
			'framework-service.json',
			'framework.environment.sh',
			'mcp.config.json',
			'tool-portal-service.json',
			'tool-portal.environment.sh',
		]);
		await Promise.all(
			receipt.files.map(async (fileReceipt) => {
				const filePath = path.join(receipt.directoryPath, fileReceipt.fileName);
				const [fileContents, fileStatus] = await Promise.all([readFile(filePath), stat(filePath)]);
				expect(fileStatus.mode & 0o777).toBe(0o600);
				expect(fileReceipt).toMatchObject({
					byteLength: fileContents.byteLength,
					mode: '0600',
					sha256: createHash('sha256').update(fileContents).digest('hex'),
				});
			}),
		);
		expect(JSON.stringify(receipt)).not.toContain(secretCanary);
		expect(receipt.cohort).toEqual(expectedCohort);
		expect(receipt.createdAt).toBe('2026-07-14T08:00:00.000Z');
		expect(receipt.schemaVersion).toBe(1);
	});

	it('excludes host authority paths from immutable inputs without mutating authored source state', async () => {
		const temporaryRoot = await createParentDirectory();
		const authoredSourceDirectory = path.join(temporaryRoot, 'authored-configuration');
		await mkdir(authoredSourceDirectory, { mode: 0o750 });
		const authoredConfigurationPath = path.join(authoredSourceDirectory, 'system.jsonc');
		await Promise.all([
			writeFile(authoredConfigurationPath, '{ /* operator-authored */ }\n', {
				encoding: 'utf8',
				mode: 0o640,
			}),
			writeFile(path.join(authoredSourceDirectory, 'operator-owned-note.txt'), 'operator-owned\n', {
				encoding: 'utf8',
				mode: 0o600,
			}),
		]);
		const controllerStateDirectory = path.join(temporaryRoot, 'controller-state-authority');
		const beforeSnapshot = await captureAuthoredSourceTreeSnapshot(authoredSourceDirectory);
		const bootInputParentDirectory = path.join(temporaryRoot, 'runtime', 'boot-inputs');

		const receipt = await materializeManagedGatewayBootInputs({
			...createMaterializationInput(),
			parentDirectory: bootInputParentDirectory,
		});
		const immutableInputContents = (
			await Promise.all(
				receipt.files.map((fileReceipt) =>
					readFile(path.join(receipt.directoryPath, fileReceipt.fileName), 'utf8'),
				),
			)
		).join('\n');
		const afterSnapshot = await captureAuthoredSourceTreeSnapshot(authoredSourceDirectory);

		expect(path.dirname(receipt.directoryPath)).toBe(bootInputParentDirectory);
		expect(immutableInputContents).not.toContain(controllerStateDirectory);
		expect(immutableInputContents).not.toContain(authoredSourceDirectory);
		expect(immutableInputContents).not.toContain(authoredConfigurationPath);
		expect(afterSnapshot).toEqual(beforeSnapshot);
	});

	it('renders environment values structurally without granting shell-script authority', async () => {
		const parentDirectory = await createParentDirectory();
		const receipt = await materializeManagedGatewayBootInputs({
			...createMaterializationInput("value with spaces and 'quotes'\nnext-line"),
			parentDirectory,
		});

		const environmentFile = await readFile(
			path.join(receipt.directoryPath, 'framework.environment.sh'),
			'utf8',
		);
		expect(environmentFile).toContain(
			"export OPENCLAW_GATEWAY_TOKEN='value with spaces and '\\''quotes'\\''\nnext-line'",
		);
		expect(environmentFile).not.toContain('eval ');
		expect(environmentFile).not.toContain('source ');
	});

	it('canonicalizes JSON key order so equivalent boot inputs have identical hashes', async () => {
		const firstParentDirectory = await createParentDirectory();
		const secondParentDirectory = await createParentDirectory();
		const firstInput = createMaterializationInput();
		const secondInput = {
			...createMaterializationInput(),
			frameworkConfig: { gateway: { port: 18_789, mode: 'local' } },
		};

		const [firstReceipt, secondReceipt] = await Promise.all([
			materializeManagedGatewayBootInputs({ ...firstInput, parentDirectory: firstParentDirectory }),
			materializeManagedGatewayBootInputs({
				...secondInput,
				parentDirectory: secondParentDirectory,
			}),
		]);

		expect(firstReceipt.files).toEqual(secondReceipt.files);
		expect(firstReceipt.directoryPath).not.toBe(secondReceipt.directoryPath);
	});

	it('returns deeply frozen receipt state', async () => {
		const parentDirectory = await createParentDirectory();

		const receipt = await materializeManagedGatewayBootInputs({
			...createMaterializationInput(),
			parentDirectory,
		});

		expect(Object.isFrozen(receipt)).toBe(true);
		expect(Object.isFrozen(receipt.cohort)).toBe(true);
		expect(Object.isFrozen(receipt.cohort.frameworkIdentity.configuredAgentIds)).toBe(true);
		expect(Object.isFrozen(receipt.files)).toBe(true);
		expect(receipt.files.every((file) => Object.isFrozen(file))).toBe(true);
	});

	it('rejects invalid environment names before publishing an input directory', async () => {
		const parentDirectory = await createParentDirectory();

		await expect(
			materializeManagedGatewayBootInputs({
				...createMaterializationInput(),
				frameworkEnvironment: { 'BAD-NAME': 'value' },
				parentDirectory,
			}),
		).rejects.toThrow('environment variable name');
	});

	it('rejects a Tool Portal control listener that does not match protected ingress intent', async () => {
		const parentDirectory = await createParentDirectory();
		const input = createMaterializationInput();

		await expect(
			materializeManagedGatewayBootInputs({
				...input,
				parentDirectory,
				toolPortalServiceConfig: {
					...input.toolPortalServiceConfig,
					controlEndpoint: {
						listen: { host: '127.0.0.1', port: 18_791 },
					},
				},
			}),
		).rejects.toThrow('Tool Portal control listener must match protected ingress intent');
	});

	it('rejects a non-production Tool Portal control listener before publishing inputs', async () => {
		const parentDirectory = await createParentDirectory();
		const input = createMaterializationInput();

		await expect(
			materializeManagedGatewayBootInputs({
				...input,
				parentDirectory,
				toolPortalServiceConfig: {
					...input.toolPortalServiceConfig,
					controlEndpoint: {
						listen: { host: '0.0.0.0', port: 18_790 },
					},
				},
			}),
		).rejects.toThrow();
	});

	it('rejects a symlinked parent without changing the target directory', async () => {
		const targetDirectory = await createParentDirectory();
		const linkContainer = await createParentDirectory();
		const linkedParentDirectory = path.join(linkContainer, 'linked-parent');
		await chmod(targetDirectory, 0o750);
		await symlink(targetDirectory, linkedParentDirectory, 'dir');

		await expect(
			materializeManagedGatewayBootInputs({
				...createMaterializationInput(),
				parentDirectory: linkedParentDirectory,
			}),
		).rejects.toThrow('must be a non-symlink directory');
		expect((await stat(targetDirectory)).mode & 0o777).toBe(0o750);
	});
});
