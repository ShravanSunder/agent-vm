import type { MediatedSecretSpec } from '@agent-vm/secret-management';
import {
	MemoryProvider,
	ReadonlyProvider,
	RealFSProvider,
	ShadowProvider,
	VM,
	createHttpHooks,
	createShadowPathPredicate,
	type CreateHttpHooksResult,
	type EnableIngressOptions,
	type EnableSshOptions,
	type ExecOptions as GondolinExecOptions,
	type ExecProcess as GondolinExecProcess,
	type ExecResult as GondolinExecResult,
	type IngressRoute as GondolinIngressRoute,
	type ShadowPredicate,
	type ShadowProviderOptions,
	type VMOptions,
	type VmFs as GondolinVmFs,
	type VirtualProvider,
} from '@earendil-works/gondolin';

import {
	closePinnedRealFsRoot,
	createPinnedRealFsProvider,
	type PinnedRealFsRoot,
} from './pinned-realfs.js';

export const SYNTHETIC_DNS_IPV4_BENCHMARK = '198.18.0.1';
export const SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK = '::ffff:198.18.0.1';

export type ManagedExecInput = string | readonly string[];
export type ManagedExecOptions = GondolinExecOptions;
export type ManagedExecProcess = GondolinExecProcess;
export type ManagedExecResult = GondolinExecResult;
export type ManagedVmFs = GondolinVmFs;

export type IngressRoute = GondolinIngressRoute;

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
	readonly fs: ManagedVmFs;
	readonly id: string;
	exec(command: string | string[], options?: ManagedExecOptions): ManagedExecProcess;
	enableSsh(options?: EnableSshOptions): Promise<SshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	getHostPid?(): number | null;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}

export interface ManagedVmDependencies {
	createVm(vmOptions: VMOptions): Promise<ManagedVmInstance>;
	createHttpHooks(options: {
		readonly allowedHosts: readonly string[];
		readonly secrets: Record<string, MediatedSecretSpec>;
		readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
		readonly onResponse?: (response: Response) => Promise<Response | void>;
	}): Pick<CreateHttpHooksResult, 'env' | 'httpHooks'>;
	closePinnedRealFsRoot(root: PinnedRealFsRoot): void;
	createPinnedRealFsProvider(root: PinnedRealFsRoot): VirtualProvider;
	createRealFsProvider(hostPath: string): VirtualProvider;
	createReadonlyProvider(provider: VirtualProvider): VirtualProvider;
	createMemoryProvider(): VirtualProvider;
	createShadowProvider(provider: VirtualProvider, options: ShadowProviderOptions): VirtualProvider;
	createShadowPathPredicate(paths: readonly string[]): ShadowPredicate;
}

export interface VfsMountSpec {
	readonly kind: 'realfs' | 'realfs-readonly' | 'memory' | 'shadow';
	readonly hostPath?: string;
	readonly pinnedHostRoot?: PinnedRealFsRoot;
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
	readonly runtimeRootfsSize?: string;
	readonly allowedHosts: readonly string[];
	readonly secrets: Record<string, MediatedSecretSpec>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly tcpHosts?: Record<string, string>;
	readonly env?: Record<string, string>;
	readonly sessionLabel?: string;
	readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
	readonly onResponse?: (response: Response) => Promise<Response | void>;
}

export interface ManagedVm {
	readonly fs: ManagedVmFs;
	readonly id: string;
	exec(command: ManagedExecInput, options?: ManagedExecOptions): ManagedExecProcess;
	enableSsh(options?: EnableSshOptions): Promise<SshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	getHostPid(): number | null;
	getVmInstance(): ManagedVmInstance;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	close(): Promise<void>;
}

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- VM.create() returns
   Gondolin's concrete VM class; this adapter exposes only the narrower
   ManagedVmInstance interface used by agent-vm. */
function createDefaultDependencies(): ManagedVmDependencies {
	const createDefaultRealFsProvider = (hostPath: string): VirtualProvider =>
		new RealFSProvider(hostPath);
	return {
		createVm: async (vmOptions: VMOptions): Promise<ManagedVmInstance> =>
			(await VM.create(vmOptions)) as unknown as ManagedVmInstance,
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
		closePinnedRealFsRoot,
		createPinnedRealFsProvider: (root: PinnedRealFsRoot): VirtualProvider =>
			createPinnedRealFsProvider({
				createRealFsProvider: createDefaultRealFsProvider,
				root,
			}),
		createRealFsProvider: createDefaultRealFsProvider,
		createReadonlyProvider: (provider: VirtualProvider): VirtualProvider =>
			new ReadonlyProvider(provider),
		createMemoryProvider: (): VirtualProvider => new MemoryProvider(),
		createShadowProvider: (
			provider: VirtualProvider,
			shadowOptions: ShadowProviderOptions,
		): VirtualProvider => new ShadowProvider(provider, shadowOptions),
		createShadowPathPredicate: (paths: readonly string[]): ShadowPredicate =>
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

function createRealFsProviderForSpec(
	mountSpec: VfsMountSpec,
	dependencies: ManagedVmDependencies,
	mountKind: string,
): VirtualProvider {
	if (mountSpec.pinnedHostRoot) {
		return dependencies.createPinnedRealFsProvider(mountSpec.pinnedHostRoot);
	}
	if (mountSpec.hostPath) {
		return dependencies.createRealFsProvider(mountSpec.hostPath);
	}

	throw new Error(`${mountKind} mounts require hostPath or pinnedHostRoot`);
}

function createProviderFromSpec(
	mountSpec: VfsMountSpec,
	dependencies: ManagedVmDependencies,
): VirtualProvider {
	switch (mountSpec.kind) {
		case 'memory':
			return dependencies.createMemoryProvider();
		case 'realfs': {
			return createRealFsProviderForSpec(mountSpec, dependencies, 'realfs');
		}
		case 'realfs-readonly': {
			return dependencies.createReadonlyProvider(
				createRealFsProviderForSpec(mountSpec, dependencies, 'realfs-readonly'),
			);
		}
		case 'shadow': {
			const baseProvider =
				mountSpec.hostPath || mountSpec.pinnedHostRoot
					? createRealFsProviderForSpec(mountSpec, dependencies, 'shadow')
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
		default: {
			throw new Error(`Unsupported VFS mount kind: ${String(mountSpec.kind)}`);
		}
	}
}

function createVfsMounts(
	vfsMounts: Record<string, VfsMountSpec>,
	dependencies: ManagedVmDependencies,
): Record<string, VirtualProvider> {
	const mountMap: Record<string, VirtualProvider> = {};

	for (const [guestPath, mountSpec] of Object.entries(vfsMounts)) {
		mountMap[guestPath] = createProviderFromSpec(mountSpec, dependencies);
	}

	return mountMap;
}

function collectPinnedRealFsRoots(
	vfsMounts: Record<string, VfsMountSpec>,
): readonly PinnedRealFsRoot[] {
	const roots = new Map<number, PinnedRealFsRoot>();
	for (const mountSpec of Object.values(vfsMounts)) {
		if (mountSpec.pinnedHostRoot) {
			roots.set(mountSpec.pinnedHostRoot.fd, mountSpec.pinnedHostRoot);
		}
	}
	return [...roots.values()];
}

function closePinnedRealFsRoots(
	roots: readonly PinnedRealFsRoot[],
	dependencies: ManagedVmDependencies,
): void {
	for (const root of roots) {
		dependencies.closePinnedRealFsRoot(root);
	}
}

function closePinnedRealFsRootsAfterFailure(
	roots: readonly PinnedRealFsRoot[],
	dependencies: ManagedVmDependencies,
): void {
	try {
		closePinnedRealFsRoots(roots, dependencies);
	} catch {
		// Preserve the VM creation failure; leaked-fd risk is lower than hiding
		// the root cause of a failed lease.
	}
}

export async function createManagedVm(
	options: CreateVmOptions,
	dependencies: ManagedVmDependencies = createDefaultDependencies(),
): Promise<ManagedVm> {
	const hasTcpHosts = options.tcpHosts && Object.keys(options.tcpHosts).length > 0;
	const pinnedRealFsRoots = collectPinnedRealFsRoots(options.vfsMounts);
	let vmInstance: ManagedVmInstance;
	try {
		const hookBundle = dependencies.createHttpHooks({
			allowedHosts: options.allowedHosts,
			secrets: options.secrets,
			...(options.onRequest ? { onRequest: options.onRequest } : {}),
			...(options.onResponse ? { onResponse: options.onResponse } : {}),
		});
		vmInstance = await dependencies.createVm({
			...(options.imagePath.length > 0 ? { sandbox: { imagePath: options.imagePath } } : {}),
			...(options.sessionLabel ? { sessionLabel: options.sessionLabel } : {}),
			rootfs: {
				mode: options.rootfsMode,
				...(options.runtimeRootfsSize === undefined ? {} : { size: options.runtimeRootfsSize }),
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
							syntheticIPv4: SYNTHETIC_DNS_IPV4_BENCHMARK,
							syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
							syntheticHostMapping: 'per-host',
						},
						tcp: {
							hosts: options.tcpHosts,
						},
					}
				: {}),
		});
	} catch (error) {
		closePinnedRealFsRootsAfterFailure(pinnedRealFsRoots, dependencies);
		throw error;
	}

	return {
		fs: vmInstance.fs,
		id: vmInstance.id,
		exec(command: ManagedExecInput, execOptions?: ManagedExecOptions): ManagedExecProcess {
			const normalizedCommand = typeof command === 'string' ? command : [...command];
			return vmInstance.exec(normalizedCommand, execOptions);
		},
		async enableSsh(sshOptions?: EnableSshOptions): Promise<SshAccess> {
			return await vmInstance.enableSsh(sshOptions);
		},
		async enableIngress(ingressOptions?: EnableIngressOptions): Promise<IngressAccess> {
			return await vmInstance.enableIngress(ingressOptions);
		},
		getHostPid(): number | null {
			return vmInstance.getHostPid?.() ?? null;
		},
		getVmInstance(): ManagedVmInstance {
			return vmInstance;
		},
		setIngressRoutes(routes: readonly IngressRoute[]): void {
			vmInstance.setIngressRoutes(routes);
		},
		async close(): Promise<void> {
			let closeError: unknown;
			try {
				await vmInstance.close();
			} catch (error) {
				closeError = error;
			}
			try {
				closePinnedRealFsRoots(pinnedRealFsRoots, dependencies);
			} catch (error) {
				closeError ??= error;
			}
			if (closeError !== undefined) {
				throw closeError;
			}
		},
	};
}
