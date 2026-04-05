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
	readonly port: number;
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

function isExecResult(value: unknown): value is ExecResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { exitCode?: unknown }).exitCode === 'number' &&
		typeof (value as { stdout?: unknown }).stdout === 'string' &&
		typeof (value as { stderr?: unknown }).stderr === 'string'
	);
}

function isHostPortAccess(
	value: unknown,
): value is { readonly host: string; readonly port: number } {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { host?: unknown }).host === 'string' &&
		typeof (value as { port?: unknown }).port === 'number'
	);
}

function createDefaultDependencies(): ManagedVmDependencies {
	return {
		createVm: async (vmOptions: unknown): Promise<ManagedVmInstance> => {
			const vm = await Reflect.apply(VM.create, VM, [vmOptions]);
			return {
				close: async (): Promise<void> => vm.close(),
				enableIngress: async (ingressOptions?: unknown): Promise<IngressAccess> => {
					const ingressAccess = await Reflect.apply(vm.enableIngress, vm, [ingressOptions]);
					if (!isHostPortAccess(ingressAccess)) {
						throw new TypeError('Gondolin enableIngress returned an unexpected result');
					}
					return {
						host: ingressAccess.host,
						port: ingressAccess.port,
					};
				},
				enableSsh: async (sshOptions?: unknown): Promise<SshAccess> => {
					const sshAccess = await Reflect.apply(vm.enableSsh, vm, [sshOptions]);
					if (!isHostPortAccess(sshAccess)) {
						throw new TypeError('Gondolin enableSsh returned an unexpected result');
					}
					return {
						host: sshAccess.host,
						port: sshAccess.port,
					};
				},
				exec: async (command: string): Promise<ExecResult> => {
					const executionResult = await vm.exec(command);
					if (!isExecResult(executionResult)) {
						throw new TypeError('Gondolin exec returned an unexpected result');
					}
					return {
						exitCode: executionResult.exitCode,
						stderr: executionResult.stderr ?? '',
						stdout: executionResult.stdout ?? '',
					};
				},
				id: vm.id,
				setIngressRoutes: (routes: readonly IngressRoute[]): void => {
					void Reflect.apply(vm.setIngressRoutes, vm, [[...routes]]);
				},
			};
		},
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
		createReadonlyProvider: (provider: unknown): unknown =>
			Reflect.construct(ReadonlyProvider, [provider]),
		createMemoryProvider: (): unknown => new MemoryProvider(),
		createShadowProvider: (provider: unknown, shadowOptions: unknown): unknown =>
			Reflect.construct(ShadowProvider, [provider, shadowOptions]),
		createShadowPathPredicate: (paths: readonly string[]): unknown =>
			createShadowPathPredicate([...paths]),
	};
}

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
	const vmInstance = await dependencies.createVm({
		sandbox: {
			imagePath: options.imagePath,
		},
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
