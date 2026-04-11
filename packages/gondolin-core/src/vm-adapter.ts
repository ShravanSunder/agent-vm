import {
	MemoryProvider,
	ReadonlyProvider,
	RealFSProvider,
	ShadowProvider,
	VM,
	createHttpHooks,
	createShadowPathPredicate,
} from '@earendil-works/gondolin';

import type { SecretSpec } from './types.js';

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface IngressRoute {
	readonly prefix: string;
	readonly port: number;
	readonly stripPrefix?: boolean;
}

export interface SshAccess {
	readonly host: string;
	readonly command?: string;
	readonly identityFile?: string;
	readonly port: number;
	readonly user?: string;
}

export interface IngressAccess {
	readonly host: string;
	readonly port: number;
}

export interface ManagedVmInstance {
	readonly id: string;
	exec(command: string): Promise<{
		readonly exitCode: number;
		readonly stdout?: string;
		readonly stderr?: string;
	}>;
	enableSsh(options?: unknown): Promise<SshAccess>;
	enableIngress(options?: unknown): Promise<IngressAccess>;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}

export interface ManagedVmDependencies {
	createVm(vmOptions: unknown): Promise<ManagedVmInstance>;
	createHttpHooks(options: {
		readonly allowedHosts: readonly string[];
		readonly secrets: Record<string, SecretSpec>;
		readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
		readonly onResponse?: (response: Response) => Promise<Response | void>;
	}): {
		readonly env: Record<string, string>;
		readonly httpHooks: unknown;
	};
	createRealFsProvider(hostPath: string): unknown;
	createReadonlyProvider(provider: unknown): unknown;
	createMemoryProvider(): unknown;
	createShadowProvider(provider: unknown, options: unknown): unknown;
	createShadowPathPredicate(paths: readonly string[]): unknown;
}

export interface VfsMountSpec {
	readonly kind: 'realfs' | 'realfs-readonly' | 'memory' | 'shadow';
	readonly hostPath?: string;
	readonly shadowConfig?: {
		readonly deny: readonly string[];
		readonly tmpfs: readonly string[];
	};
}

export interface CreateVmOptions {
	readonly imagePath: string;
	readonly memory: string;
	readonly cpus: number;
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly allowedHosts: readonly string[];
	readonly secrets: Record<string, SecretSpec>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly tcpHosts?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly sessionLabel?: string;
	readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
	readonly onResponse?: (response: Response) => Promise<Response | void>;
}

export interface ManagedVm {
	readonly id: string;
	exec(command: string): Promise<ExecResult>;
	enableSsh(options?: unknown): Promise<SshAccess>;
	enableIngress(options?: unknown): Promise<IngressAccess>;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Gondolin SDK boundary:
   The dependency injection pattern uses `unknown` to decouple from SDK internals.
   The `as never` casts bridge our unknown-typed providers to the SDK's concrete types. */
function createDefaultDependencies(): ManagedVmDependencies {
	return {
		createVm: async (vmOptions: unknown): Promise<ManagedVmInstance> =>
			(await VM.create(vmOptions as never)) as unknown as ManagedVmInstance,
		createHttpHooks: (hookOptions) =>
			createHttpHooks({
				allowedHosts: [...hookOptions.allowedHosts],
				secrets: Object.fromEntries(
					Object.entries(hookOptions.secrets).map(([secretName, secretSpec]) => [
						secretName,
						{
							hosts: [...secretSpec.hosts],
							value: secretSpec.value,
						},
					]),
				),
				...(hookOptions.onRequest ? { onRequest: hookOptions.onRequest } : {}),
				...(hookOptions.onResponse ? { onResponse: hookOptions.onResponse } : {}),
			}),
		createRealFsProvider: (hostPath: string): unknown => new RealFSProvider(hostPath),
		createReadonlyProvider: (provider: unknown): unknown => new ReadonlyProvider(provider as never),
		createMemoryProvider: (): unknown => new MemoryProvider(),
		createShadowProvider: (provider: unknown, shadowOptions: unknown): unknown =>
			new ShadowProvider(provider as never, shadowOptions as never),
		createShadowPathPredicate: (paths: readonly string[]): unknown =>
			createShadowPathPredicate([...paths]),
	};
}
/* oxlint-enable typescript-eslint/no-unsafe-type-assertion */

function normalizeShadowPath(pathValue: string): string {
	const trimmedPath = pathValue.trim();
	if (trimmedPath.startsWith('/')) {
		return trimmedPath;
	}

	const relativePath = trimmedPath.startsWith('./') ? trimmedPath.slice('./'.length) : trimmedPath;
	return `/${relativePath}`;
}

function createProviderFromSpec(
	mountSpec: VfsMountSpec,
	dependencies: ManagedVmDependencies,
): unknown {
	switch (mountSpec.kind) {
		case 'memory':
			return dependencies.createMemoryProvider();
		case 'realfs': {
			if (!mountSpec.hostPath) {
				throw new Error('realfs mounts require hostPath');
			}

			return dependencies.createRealFsProvider(mountSpec.hostPath);
		}
		case 'realfs-readonly': {
			if (!mountSpec.hostPath) {
				throw new Error('realfs-readonly mounts require hostPath');
			}

			return dependencies.createReadonlyProvider(
				dependencies.createRealFsProvider(mountSpec.hostPath),
			);
		}
		case 'shadow': {
			const baseProvider = mountSpec.hostPath
				? dependencies.createRealFsProvider(mountSpec.hostPath)
				: dependencies.createMemoryProvider();

			let shadowProvider = baseProvider;
			const shadowConfig = mountSpec.shadowConfig;

			if (shadowConfig?.deny.length) {
				shadowProvider = dependencies.createShadowProvider(shadowProvider, {
					shouldShadow: dependencies.createShadowPathPredicate(
						shadowConfig.deny.map((shadowPath) => normalizeShadowPath(shadowPath)),
					),
					writeMode: 'deny',
				});
			}

			if (shadowConfig?.tmpfs.length) {
				shadowProvider = dependencies.createShadowProvider(shadowProvider, {
					shouldShadow: dependencies.createShadowPathPredicate(
						shadowConfig.tmpfs.map((shadowPath) => normalizeShadowPath(shadowPath)),
					),
					writeMode: 'tmpfs',
				});
			}

			return shadowProvider;
		}
	}
}

function createVfsMounts(
	vfsMounts: Record<string, VfsMountSpec>,
	dependencies: ManagedVmDependencies,
): Record<string, unknown> {
	const mountMap: Record<string, unknown> = {};

	for (const [guestPath, mountSpec] of Object.entries(vfsMounts)) {
		mountMap[guestPath] = createProviderFromSpec(mountSpec, dependencies);
	}

	return mountMap;
}

export async function createManagedVm(
	options: CreateVmOptions,
	dependencies: ManagedVmDependencies = createDefaultDependencies(),
): Promise<ManagedVm> {
	const hookBundle = dependencies.createHttpHooks({
		allowedHosts: options.allowedHosts,
		secrets: options.secrets,
		...(options.onRequest ? { onRequest: options.onRequest } : {}),
		...(options.onResponse ? { onResponse: options.onResponse } : {}),
	});

	const hasTcpHosts = options.tcpHosts && Object.keys(options.tcpHosts).length > 0;
	const hasImagePath = options.imagePath !== undefined && options.imagePath.length > 0;
	const sandboxOptions = hasImagePath ? { imagePath: options.imagePath } : {};
	const vmInstance = await dependencies.createVm({
		...(Object.keys(sandboxOptions).length > 0 ? { sandbox: sandboxOptions } : {}),
		sessionLabel: options.sessionLabel,
		rootfs: {
			mode: options.rootfsMode,
		},
		memory: options.memory,
		cpus: options.cpus,
		env: {
			...hookBundle.env,
			...options.env,
		},
		httpHooks: hookBundle.httpHooks,
		vfs: {
			fuseMount: '/data',
			mounts: createVfsMounts(options.vfsMounts, dependencies),
		},
		...(hasTcpHosts
			? {
					dns: {
						mode: 'synthetic',
						syntheticHostMapping: 'per-host',
					},
					tcp: {
						hosts: options.tcpHosts,
					},
				}
			: {}),
	});

	return {
		id: vmInstance.id,
		async exec(command: string): Promise<ExecResult> {
			const executionResult = await vmInstance.exec(command);
			return {
				exitCode: executionResult.exitCode,
				stdout: executionResult.stdout ?? '',
				stderr: executionResult.stderr ?? '',
			};
		},
		async enableSsh(sshOptions?: unknown): Promise<SshAccess> {
			return await vmInstance.enableSsh(sshOptions);
		},
		async enableIngress(ingressOptions?: unknown): Promise<IngressAccess> {
			return await vmInstance.enableIngress(ingressOptions);
		},
		setIngressRoutes(routes: readonly IngressRoute[]): void {
			vmInstance.setIngressRoutes(routes);
		},
		async close(): Promise<void> {
			await vmInstance.close();
		},
	};
}
