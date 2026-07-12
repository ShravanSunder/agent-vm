import fs from 'node:fs/promises';
import path from 'node:path';

import {
	createOwnedHostDirectoryController,
	assertPositiveHostProcessId,
	type ManagedVm,
	type ManagedVmAccessHandle,
	type ManagedVmCreateRequest,
	type ManagedVmExecCommand,
	type ManagedVmExecOptions,
	type ManagedVmExecOutputChunk,
	type ManagedVmExecProcess,
	type ManagedVmExecResult,
	type ManagedVmIngressOptions,
	type ManagedVmIngressRoute,
	type ManagedVmProvider,
	type ManagedVmSshAccess,
	type OwnedHostDirectory,
	type OwnedHostDirectoryTransfer,
} from '@agent-vm/managed-vm';
import { validateBuildConfig } from '@earendil-works/gondolin';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';

import { buildImage } from './build-pipeline.js';
import {
	resolveGondolinMinimumZigVersion,
	resolveGondolinPackageSpec,
} from './gondolin-package.js';
import {
	assertPinnedRealFsRoot,
	closePinnedRealFsRoot,
	pinRealFsRoot,
	type PinnedRealFsRoot,
} from './pinned-realfs.js';
import {
	createGitReadOnlySshEgressOptions,
	createManagedVm as createNativeManagedVm,
	type ManagedExecOptions as NativeManagedExecOptions,
	type ManagedVm as NativeManagedVm,
	type VfsMountSpec,
} from './vm-adapter.js';

type OwnedDirectoryProvenance = WeakMap<OwnedHostDirectory, PinnedRealFsRoot>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatUnknownValue(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertCreateRequestSupported(request: ManagedVmCreateRequest): void {
	if (!['readonly', 'memory', 'cow'].includes(request.rootfsMode)) {
		throw new Error(
			`Unsupported managed VM rootfs mode: ${formatUnknownValue(request.rootfsMode)}`,
		);
	}
	if (!Number.isSafeInteger(request.resources.cpuCount) || request.resources.cpuCount <= 0) {
		throw new Error('Managed VM CPU count must be a positive safe integer.');
	}
	if (request.imageReference.length === 0 || request.resources.memory.length === 0) {
		throw new Error('Managed VM image reference and memory must be non-empty.');
	}
	if (request.sshEgress !== undefined && request.sshEgress.kind !== 'git-read-only') {
		throw new Error(
			`Unsupported managed VM SSH egress kind: ${formatUnknownValue(request.sshEgress.kind)}`,
		);
	}
	for (const [guestPath, mount] of Object.entries(request.mounts)) {
		if (!guestPath.startsWith('/')) {
			throw new Error(`Managed VM mount path must be absolute: ${guestPath}`);
		}
		if (!['host-directory', 'owned-host-directory', 'memory', 'shadow'].includes(mount.kind)) {
			throw new Error(`Unsupported managed VM mount kind: ${formatUnknownValue(mount.kind)}`);
		}
	}
	const mediatedSecretNames = new Set<string>();
	for (const secret of request.mediatedSecrets) {
		if (mediatedSecretNames.has(secret.environmentVariable)) {
			throw new Error(
				`Duplicate managed VM mediated-secret environment variable: ${secret.environmentVariable}`,
			);
		}
		mediatedSecretNames.add(secret.environmentVariable);
	}
	const tcpGuestHosts = new Set<string>();
	for (const mapping of request.tcpHosts) {
		if (tcpGuestHosts.has(mapping.guestHost)) {
			throw new Error(`Duplicate managed VM TCP guest host: ${mapping.guestHost}`);
		}
		tcpGuestHosts.add(mapping.guestHost);
	}
}

interface TranslatedMounts {
	readonly mounts: Record<string, VfsMountSpec>;
	readonly transfers: readonly OwnedHostDirectoryTransfer[];
}

function closeOwnedDirectoryTransfers(
	transfers: readonly OwnedHostDirectoryTransfer[],
): readonly unknown[] {
	const closeErrors: unknown[] = [];
	for (const transfer of transfers) {
		try {
			transfer.close();
		} catch (error) {
			closeErrors.push(error);
		}
	}
	return closeErrors;
}

function isReadonlyStringArray(
	value: readonly string[] | Readonly<Record<string, string>>,
): value is readonly string[] {
	return Array.isArray(value);
}

function translateExecEnvironment(
	environment: readonly string[] | Readonly<Record<string, string>>,
): string[] | Record<string, string> {
	return isReadonlyStringArray(environment) ? [...environment] : { ...environment };
}

function translateExecStdin(
	stdin: string | Uint8Array | AsyncIterable<Uint8Array>,
): string | Buffer | AsyncIterable<Buffer> {
	if (typeof stdin === 'string') {
		return stdin;
	}
	if (stdin instanceof Uint8Array) {
		return Buffer.from(stdin);
	}
	return (async function* (): AsyncIterable<Buffer> {
		for await (const chunk of stdin) {
			yield Buffer.from(chunk);
		}
	})();
}

function translateExecOptions(options: ManagedVmExecOptions): NativeManagedExecOptions {
	return {
		...(options.argv ? { argv: [...options.argv] } : {}),
		...(options.cwd ? { cwd: options.cwd } : {}),
		...(options.env ? { env: translateExecEnvironment(options.env) } : {}),
		...(options.pty === undefined ? {} : { pty: options.pty }),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.stdin === undefined ? {} : { stdin: translateExecStdin(options.stdin) }),
	};
}

function wrapExecProcess(nativeProcess: ReturnType<NativeManagedVm['exec']>): ManagedVmExecProcess {
	const result: Promise<ManagedVmExecResult> = nativeProcess.result;
	return Object.assign(result, {
		[Symbol.asyncIterator](): AsyncIterator<string> {
			return nativeProcess[Symbol.asyncIterator]();
		},
		end(): void {
			nativeProcess.end();
		},
		lines(): AsyncIterable<string> {
			return nativeProcess.lines();
		},
		output(): AsyncIterable<ManagedVmExecOutputChunk> {
			return nativeProcess.output();
		},
		resize(rows: number, columns: number): void {
			nativeProcess.resize(rows, columns);
		},
		result,
		write(data: string | Uint8Array): void {
			nativeProcess.write(typeof data === 'string' ? data : Buffer.from(data));
		},
	}) satisfies ManagedVmExecProcess;
}

function translateMounts(
	mounts: ManagedVmCreateRequest['mounts'],
	ownedDirectoryRoots: OwnedDirectoryProvenance,
): TranslatedMounts {
	const translatedMounts: Record<string, VfsMountSpec> = {};
	const transfers: OwnedHostDirectoryTransfer[] = [];
	try {
		for (const [guestPath, mount] of Object.entries(mounts)) {
			switch (mount.kind) {
				case 'host-directory':
					translatedMounts[guestPath] = {
						hostPath: mount.hostPath,
						kind: mount.access === 'read-only' ? 'realfs-readonly' : 'realfs',
					};
					break;
				case 'owned-host-directory': {
					const pinnedRoot = ownedDirectoryRoots.get(mount.directory);
					if (!pinnedRoot) {
						throw new Error('Owned host directory was not acquired by this Gondolin provider.');
					}
					assertPinnedRealFsRoot(pinnedRoot);
					transfers.push(mount.directory.consume());
					ownedDirectoryRoots.delete(mount.directory);
					translatedMounts[guestPath] = {
						kind: mount.access === 'read-only' ? 'realfs-readonly' : 'realfs',
						pinnedHostRoot: pinnedRoot,
					};
					break;
				}
				case 'memory':
					translatedMounts[guestPath] = { kind: 'memory' };
					break;
				case 'shadow':
					translatedMounts[guestPath] = {
						hostPath: mount.hostPath,
						kind: 'shadow',
						shadowConfig: {
							deny: mount.deny,
							tmpfs: mount.temporaryFilesystems,
						},
					};
					break;
			}
		}
	} catch (error) {
		const closeErrors = closeOwnedDirectoryTransfers(transfers);
		if (closeErrors.length > 0) {
			// oxlint-disable-next-line preserve-caught-error -- AggregateError cause and errors both retain the primary translation failure.
			throw new AggregateError(
				[error, ...closeErrors],
				'Managed VM mount translation and owned-directory cleanup both failed.',
				{ cause: error },
			);
		}
		throw error;
	}
	return { mounts: translatedMounts, transfers };
}

function wrapManagedVm(
	nativeVm: NativeManagedVm,
	ownedDirectoryTransfers: readonly OwnedHostDirectoryTransfer[],
): ManagedVm {
	type ManagedVmLifecycleState =
		| 'created'
		| 'starting'
		| 'started'
		| 'start-failed'
		| 'closing'
		| 'closed';
	let closePromise: Promise<void> | undefined;
	let hostProcessId: number | null = null;
	let lifecycleState: ManagedVmLifecycleState = 'created';
	let startPromise: Promise<void> | undefined;
	const closeOnce = async (): Promise<void> => {
		if (startPromise) {
			try {
				await startPromise;
			} catch {
				// Mechanical close must continue after either start success or failure.
			}
		}
		const closeErrors: unknown[] = [];
		try {
			await nativeVm.close();
		} catch (error) {
			closeErrors.push(error);
		}
		closeErrors.push(...closeOwnedDirectoryTransfers(ownedDirectoryTransfers));
		try {
			if (closeErrors.length === 1) {
				throw closeErrors[0];
			}
			if (closeErrors.length > 1) {
				throw new AggregateError(closeErrors, 'Managed VM cleanup failed.');
			}
		} finally {
			hostProcessId = null;
			lifecycleState = 'closed';
		}
	};
	return {
		async close(): Promise<void> {
			if (!closePromise) {
				lifecycleState = 'closing';
				closePromise = closeOnce();
			}
			await closePromise;
		},
		configureIngressRoutes(routes: readonly ManagedVmIngressRoute[]): void {
			nativeVm.setIngressRoutes(
				routes.map((route) => ({
					port: route.port,
					prefix: route.prefix,
					stripPrefix: route.stripPrefix,
				})),
			);
		},
		async enableIngress(options?: ManagedVmIngressOptions): Promise<ManagedVmAccessHandle> {
			return await nativeVm.enableIngress(options);
		},
		async enableSsh(options): Promise<ManagedVmSshAccess> {
			const access = await nativeVm.enableSsh(options);
			if (!access.command || !access.identityFile || !access.user) {
				await access.close();
				throw new Error('Gondolin SSH access omitted required neutral connection fields.');
			}
			return {
				close: async (): Promise<void> => await access.close(),
				command: access.command,
				host: access.host,
				identityFile: access.identityFile,
				port: access.port,
				serverHostKey: access.serverHostKey,
				user: access.user,
			};
		},
		exec(command: ManagedVmExecCommand, options?: ManagedVmExecOptions): ManagedVmExecProcess {
			const normalizedCommand = typeof command === 'string' ? command : [...command];
			const nativeProcess = nativeVm.exec(
				normalizedCommand,
				options ? translateExecOptions(options) : undefined,
			);
			return wrapExecProcess(nativeProcess);
		},
		getHostProcessId(): number | null {
			return hostProcessId;
		},
		id: nativeVm.id,
		async start(): Promise<void> {
			if (lifecycleState === 'closing' || lifecycleState === 'closed') {
				throw new Error('Managed VM cannot start after close has been requested.');
			}
			if (lifecycleState === 'started') {
				return;
			}
			if (!startPromise) {
				lifecycleState = 'starting';
				startPromise = (async (): Promise<void> => {
					try {
						await nativeVm.start();
						const startedHostProcessId = assertPositiveHostProcessId(nativeVm.getHostPid());
						if (lifecycleState !== 'starting') {
							throw new Error('Managed VM closed while startup was settling.');
						}
						hostProcessId = startedHostProcessId;
						lifecycleState = 'started';
					} catch (error) {
						if (lifecycleState === 'starting') {
							lifecycleState = 'start-failed';
						}
						throw error;
					}
				})();
			}
			await startPromise;
		},
	};
}

function openOwnedHostDirectory(
	hostPath: string,
	ownedDirectoryRoots: OwnedDirectoryProvenance,
): OwnedHostDirectory {
	const pinnedRoot = pinRealFsRoot(hostPath);
	const directory = createOwnedHostDirectoryController({
		identity: {
			canonicalPath: pinnedRoot.realPath,
			device: pinnedRoot.device,
			inode: pinnedRoot.inode,
		},
		onClose: () => closePinnedRealFsRoot(pinnedRoot),
		onConsume: () => assertPinnedRealFsRoot(pinnedRoot),
	});
	ownedDirectoryRoots.set(directory, pinnedRoot);
	return directory;
}

export function createGondolinManagedVmProvider(): ManagedVmProvider {
	const ownedDirectoryRoots: OwnedDirectoryProvenance = new WeakMap();
	return {
		diagnostics: {
			async checkCompatibility() {
				const diagnostics = [];
				try {
					await Promise.all([resolveGondolinPackageSpec(), resolveGondolinMinimumZigVersion()]);
				} catch (error) {
					diagnostics.push({
						code: 'gondolin-toolchain-unavailable',
						message: error instanceof Error ? error.message : String(error),
						severity: 'error' as const,
					});
				}
				return diagnostics;
			},
		},
		factory: {
			async createManagedVm(request: ManagedVmCreateRequest): Promise<ManagedVm> {
				assertCreateRequestSupported(request);
				const secrets = Object.fromEntries(
					request.mediatedSecrets.map((secret) => [
						secret.environmentVariable,
						{ hosts: [...secret.allowedHosts], value: secret.value },
					]),
				);
				const tcpHosts = Object.fromEntries(
					request.tcpHosts.map((mapping) => [mapping.guestHost, mapping.target]),
				);
				const translatedMounts = translateMounts(request.mounts, ownedDirectoryRoots);
				let nativeVm: NativeManagedVm;
				try {
					nativeVm = await createNativeManagedVm({
						allowedHosts: [...request.allowedHosts],
						cpus: request.resources.cpuCount,
						env: { ...request.environment },
						imagePath: request.imageReference,
						memory: request.resources.memory,
						...(request.mediation?.onRequest ? { onRequest: request.mediation.onRequest } : {}),
						...(request.mediation?.onResponse ? { onResponse: request.mediation.onResponse } : {}),
						rootfsMode: request.rootfsMode,
						...(request.runtimeRootfsSize ? { runtimeRootfsSize: request.runtimeRootfsSize } : {}),
						secrets,
						sessionLabel: request.sessionLabel,
						...(request.sshEgress
							? {
									sshEgress: createGitReadOnlySshEgressOptions({
										allowedHosts: request.sshEgress.allowedHosts,
										...(request.sshEgress.agentSocket
											? { agent: request.sshEgress.agentSocket }
											: {}),
										...(request.sshEgress.allowedRepositories
											? { allowedRepos: request.sshEgress.allowedRepositories }
											: {}),
										...(request.sshEgress.knownHostsFile
											? { knownHostsFile: request.sshEgress.knownHostsFile }
											: {}),
									}),
								}
							: {}),
						tcpHosts,
						vfsMounts: translatedMounts.mounts,
					});
				} catch (error) {
					const closeErrors = closeOwnedDirectoryTransfers(translatedMounts.transfers);
					if (closeErrors.length > 0) {
						// oxlint-disable-next-line preserve-caught-error -- AggregateError cause and errors both retain the primary construction failure.
						throw new AggregateError(
							[error, ...closeErrors],
							'Managed VM construction and owned-directory cleanup both failed.',
							{ cause: error },
						);
					}
					throw error;
				}
				return wrapManagedVm(nativeVm, translatedMounts.transfers);
			},
		},
		images: {
			async prepareImage(request) {
				const parseErrors: ParseError[] = [];
				const parsedRecipe: unknown = parse(
					await fs.readFile(request.recipePath, 'utf8'),
					parseErrors,
					{ allowTrailingComma: true },
				);
				if (parseErrors.length > 0) {
					throw new Error(
						`Invalid managed VM image recipe '${request.recipePath}': ${parseErrors
							.map((parseError) => printParseErrorCode(parseError.error))
							.join(', ')}`,
					);
				}
				if (!isRecord(parsedRecipe) || !validateBuildConfig(parsedRecipe)) {
					throw new Error(
						`Managed VM image recipe has an invalid build shape: ${request.recipePath}`,
					);
				}
				const result = await buildImage({
					buildConfig: parsedRecipe,
					cacheDir: request.cacheDirectory,
					configDir: path.dirname(request.recipePath),
					...(request.forceRebuild === undefined ? {} : { fullReset: request.forceRebuild }),
				});
				return {
					built: result.built,
					fingerprint: result.fingerprint,
					imageReference: result.imagePath,
				};
			},
		},
		ownedDirectories: {
			openHostDirectory: (hostPath: string): OwnedHostDirectory =>
				openOwnedHostDirectory(hostPath, ownedDirectoryRoots),
		},
	};
}
