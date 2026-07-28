import type { Stats } from 'node:fs';
import net from 'node:net';

import {
	validateManagedVmFinalizeMemoryMountRequest,
	type ManagedVmFilteredWorkspacePolicy,
	type ManagedVmFinalizeMemoryMountRequest,
} from '@agent-vm/managed-vm';
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
	type HttpHooks,
	type IngressRoute as GondolinIngressRoute,
	type ShadowPredicate,
	type ShadowProviderOptions,
	type SshOptions,
	type VMOptions,
	type VmFs as GondolinVmFs,
	type VirtualFileHandle,
	type VirtualProvider,
	ERRNO,
	getInfoFromSshExecRequest,
	isWriteFlag,
} from '@earendil-works/gondolin';

import { createFilteredWorkspaceProvider } from './filtered-workspace-provider.js';
import {
	configureHostNetworkDefaults,
	type HostNetworkDefaultsResult,
} from './host-network-defaults.js';
import {
	closePinnedRealFsRoot,
	createPinnedRealFsProvider,
	type PinnedRealFsRoot,
} from './pinned-realfs.js';

export const SYNTHETIC_DNS_IPV4_BENCHMARK = '198.18.0.1';
export const SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK = '::ffff:198.18.0.1';
export const MANAGED_VM_DEFAULT_INGRESS_MAX_BUFFERED_RESPONSE_BODY_BYTES = 512 * 1024 * 1024;
export const MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
export const MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_RESPONSE_TIMEOUT_MS = 120_000;

export const MANAGED_VM_DEFAULT_INGRESS_OPTIONS = {
	allowWebSockets: true,
	bufferResponseBody: false,
	maxBufferedResponseBodyBytes: MANAGED_VM_DEFAULT_INGRESS_MAX_BUFFERED_RESPONSE_BODY_BYTES,
	upstreamHeaderTimeoutMs: MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_HEADER_TIMEOUT_MS,
	upstreamResponseTimeoutMs: MANAGED_VM_DEFAULT_INGRESS_UPSTREAM_RESPONSE_TIMEOUT_MS,
} satisfies EnableIngressOptions;

export type ManagedExecInput = string | readonly string[];
export type ManagedExecOptions = GondolinExecOptions;
export type ManagedExecProcess = GondolinExecProcess;
export type ManagedExecResult = GondolinExecResult;
export type ManagedVmFs = GondolinVmFs;
export type ManagedSshEgressOptions = SshOptions;

export type IngressRoute = GondolinIngressRoute;

type VirtualProviderMethod = (...methodArguments: readonly unknown[]) => unknown;

function createGuestRootOwnedStats(stats: Stats): Stats {
	return new Proxy(stats, {
		get(target: Stats, property: string | symbol, receiver: unknown): unknown {
			if (property === 'gid' || property === 'uid') {
				return 0;
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

function createGuestRootOwnedFileHandle(handle: VirtualFileHandle): VirtualFileHandle {
	return new Proxy(handle, {
		get(target: VirtualFileHandle, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'stat') {
				return async (options?: object): Promise<Stats> =>
					createGuestRootOwnedStats(await target.stat(options));
			}
			if (property === 'statSync') {
				return (options?: object): Stats => createGuestRootOwnedStats(target.statSync(options));
			}
			return typeof value === 'function'
				? (...methodArguments: readonly unknown[]): unknown =>
						Reflect.apply(value as VirtualProviderMethod, target, methodArguments)
				: value;
		},
	});
}

function createGuestRootOwnedProvider(provider: VirtualProvider): VirtualProvider {
	return new Proxy(provider, {
		get(target: VirtualProvider, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'open') {
				return async (
					entryPath: string,
					flags: string,
					mode?: number,
				): Promise<VirtualFileHandle> =>
					createGuestRootOwnedFileHandle(await target.open(entryPath, flags, mode));
			}
			if (property === 'openSync') {
				return (entryPath: string, flags: string, mode?: number): VirtualFileHandle =>
					createGuestRootOwnedFileHandle(target.openSync(entryPath, flags, mode));
			}
			if (property === 'stat') {
				return async (entryPath: string, options?: object): Promise<Stats> =>
					createGuestRootOwnedStats(await target.stat(entryPath, options));
			}
			if (property === 'statSync') {
				return (entryPath: string, options?: object): Stats =>
					createGuestRootOwnedStats(target.statSync(entryPath, options));
			}
			if (property === 'lstat') {
				return async (entryPath: string, options?: object): Promise<Stats> =>
					createGuestRootOwnedStats(await target.lstat(entryPath, options));
			}
			if (property === 'lstatSync') {
				return (entryPath: string, options?: object): Stats =>
					createGuestRootOwnedStats(target.lstatSync(entryPath, options));
			}
			return typeof value === 'function'
				? (...methodArguments: readonly unknown[]): unknown =>
						Reflect.apply(value as VirtualProviderMethod, target, methodArguments)
				: value;
		},
	});
}

function createReadonlyMutationError(
	syscall: string,
	filePath: string | undefined,
): Error & {
	readonly code: 'EROFS';
	readonly errno: number;
	readonly path?: string;
	readonly syscall: string;
} {
	const pathSuffix = filePath === undefined ? '' : ` '${filePath}'`;
	return Object.assign(new Error(`EROFS: ${syscall}${pathSuffix}`), {
		code: 'EROFS' as const,
		errno: ERRNO.EROFS,
		...(filePath === undefined ? {} : { path: filePath }),
		syscall,
	});
}

function createHardenedReadonlyFileHandle(handle: VirtualFileHandle): VirtualFileHandle {
	return new Proxy(handle, {
		get(target: VirtualFileHandle, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'write' || property === 'writeFile' || property === 'truncate') {
				return async (): Promise<never> => {
					throw createReadonlyMutationError(String(property), target.path);
				};
			}
			if (property === 'writeSync' || property === 'writeFileSync' || property === 'truncateSync') {
				return (): never => {
					throw createReadonlyMutationError(String(property), target.path);
				};
			}
			return typeof value === 'function'
				? (...methodArguments: readonly unknown[]): unknown =>
						Reflect.apply(value as VirtualProviderMethod, target, methodArguments)
				: value;
		},
	});
}

export function createHardenedReadonlyProvider(provider: VirtualProvider): VirtualProvider {
	const readonlyProvider = new ReadonlyProvider(provider);
	return new Proxy(readonlyProvider, {
		get(target: VirtualProvider, property: string | symbol, receiver: unknown): unknown {
			const value = Reflect.get(target, property, receiver) as unknown;
			if (property === 'open') {
				return async (
					entryPath: string,
					flags: string,
					mode?: number,
				): Promise<VirtualFileHandle> => {
					if (isWriteFlag(flags)) {
						throw createReadonlyMutationError('open', entryPath);
					}
					return createHardenedReadonlyFileHandle(await target.open(entryPath, flags, mode));
				};
			}
			if (property === 'openSync') {
				return (entryPath: string, flags: string, mode?: number): VirtualFileHandle => {
					if (isWriteFlag(flags)) {
						throw createReadonlyMutationError('openSync', entryPath);
					}
					return createHardenedReadonlyFileHandle(target.openSync(entryPath, flags, mode));
				};
			}
			if (
				property === 'mkdir' ||
				property === 'rmdir' ||
				property === 'unlink' ||
				property === 'rename' ||
				property === 'link' ||
				property === 'writeFile' ||
				property === 'appendFile' ||
				property === 'copyFile' ||
				property === 'symlink'
			) {
				return async (entryPath: string): Promise<never> => {
					throw createReadonlyMutationError(String(property), entryPath);
				};
			}
			if (
				property === 'mkdirSync' ||
				property === 'rmdirSync' ||
				property === 'unlinkSync' ||
				property === 'renameSync' ||
				property === 'linkSync' ||
				property === 'writeFileSync' ||
				property === 'appendFileSync' ||
				property === 'copyFileSync' ||
				property === 'symlinkSync'
			) {
				return (entryPath: string): never => {
					throw createReadonlyMutationError(String(property), entryPath);
				};
			}
			return typeof value === 'function'
				? (...methodArguments: readonly unknown[]): unknown =>
						Reflect.apply(value as VirtualProviderMethod, target, methodArguments)
				: value;
		},
	});
}

export interface GitReadOnlySshEgressOptions {
	readonly allowedHosts: readonly string[];
	readonly allowedRepos?: readonly string[];
	readonly agent?: string;
	readonly knownHostsFile?: SshOptions['knownHostsFile'];
}

export interface SshAccess {
	close(): Promise<void>;
	readonly host: string;
	readonly command?: string;
	readonly identityFile?: string;
	readonly port: number;
	readonly serverHostKey: SshServerHostKey;
	readonly user?: string;
}

export interface ManagedVmSshAccess {
	close(): Promise<void>;
	readonly command: string;
	readonly host: string;
	readonly identityFile: string;
	readonly port: number;
	readonly user: string;
}

export interface SshServerHostKey {
	readonly algorithm: 'ssh-ed25519';
	readonly publicKeyBase64: string;
}

export function isSshServerHostKey(value: unknown): value is SshServerHostKey {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	if (!('algorithm' in value) || !('publicKeyBase64' in value)) {
		return false;
	}
	const algorithm = value.algorithm;
	const publicKeyBase64 = value.publicKeyBase64;
	if (
		algorithm !== 'ssh-ed25519' ||
		typeof publicKeyBase64 !== 'string' ||
		!/^[A-Za-z0-9+/]+={0,2}$/u.test(publicKeyBase64)
	) {
		return false;
	}

	try {
		const decodedPublicKey = Buffer.from(publicKeyBase64, 'base64');
		if (decodedPublicKey.toString('base64') !== publicKeyBase64 || decodedPublicKey.length < 4) {
			return false;
		}
		const algorithmLength = decodedPublicKey.readUInt32BE(0);
		const algorithmStart = 4;
		const algorithmEnd = algorithmStart + algorithmLength;
		const publicKeyLengthOffset = algorithmEnd;
		const publicKeyStart = publicKeyLengthOffset + 4;
		return (
			algorithmEnd + 4 <= decodedPublicKey.length &&
			decodedPublicKey.subarray(algorithmStart, algorithmEnd).toString('utf8') === 'ssh-ed25519' &&
			decodedPublicKey.readUInt32BE(publicKeyLengthOffset) === 32 &&
			decodedPublicKey.length === publicKeyStart + 32
		);
	} catch {
		return false;
	}
}

export function parseSshServerHostKey(publicKeyText: string): SshServerHostKey {
	const publicKeyLines = publicKeyText
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (publicKeyLines.length !== 1) {
		throw new Error('Tool VM did not expose exactly one ssh-ed25519 server host key.');
	}
	const publicKeyFields = publicKeyLines[0]?.split(/\s+/u);
	const serverHostKey = {
		algorithm: publicKeyFields?.[0],
		publicKeyBase64: publicKeyFields?.[1],
	};
	if (!isSshServerHostKey(serverHostKey)) {
		throw new Error('Tool VM did not expose a valid ssh-ed25519 server host key.');
	}
	return serverHostKey;
}

async function readSshServerHostKey(vmInstance: ManagedVmInstance): Promise<SshServerHostKey> {
	const publicKeyResult = await vmInstance.exec(['/bin/cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
	if (publicKeyResult.exitCode !== 0) {
		throw new Error(
			`Tool VM server host key read failed with exit ${String(publicKeyResult.exitCode)}.`,
		);
	}
	return parseSshServerHostKey(publicKeyResult.stdout);
}

async function closeSshAccessAfterIdentityFailure(
	sshAccess: Awaited<ReturnType<ManagedVmInstance['enableSsh']>>,
	identityError: unknown,
): Promise<never> {
	try {
		await sshAccess.close();
	} catch (closeError) {
		// oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves closeError while cause retains the primary identity failure.
		throw new AggregateError(
			[identityError, closeError],
			'Tool VM SSH server identity validation and SSH access cleanup both failed.',
			{ cause: identityError },
		);
	}
	throw identityError;
}

export interface IngressAccess {
	close(): Promise<void>;
	readonly host: string;
	readonly port: number;
}

export interface ManagedVmInstance {
	readonly fs: ManagedVmFs;
	readonly id: string;
	exec(command: string | string[], options?: ManagedExecOptions): ManagedExecProcess;
	enableSsh(options?: EnableSshOptions): Promise<ManagedVmSshAccess>;
	enableIngress(options?: EnableIngressOptions): Promise<IngressAccess>;
	getHostPid?(): number | null;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	start(): Promise<void>;
	close(): Promise<void>;
}

export interface ManagedVmDependencies {
	configureHostNetworkDefaults?: () => HostNetworkDefaultsResult;
	createVm(vmOptions: VMOptions): Promise<ManagedVmInstance>;
	createHttpHooks(options: {
		readonly allowedHosts: readonly string[];
		readonly allowedInternalHosts?: readonly string[];
		readonly isIpAllowed?: HttpHooks['isIpAllowed'];
		readonly secrets: Record<string, ManagedHttpMediatedSecretSpec>;
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

interface ManagedHttpMediatedSecretSpec {
	readonly hosts: readonly string[];
	readonly placeholder?: string;
	readonly value: string;
}

type RealFsVfsMountSpec = {
	readonly hostPath?: string;
	readonly kind: 'realfs' | 'realfs-readonly';
	readonly pinnedHostRoot?: PinnedRealFsRoot;
};

export type VfsMountSpec =
	| RealFsVfsMountSpec
	| {
			readonly access: 'read-only' | 'read-write';
			readonly kind: 'finalizable-memory';
	  }
	| {
			readonly kind: 'filtered-workspace';
			readonly pinnedHostRoot: PinnedRealFsRoot;
			readonly policy: ManagedVmFilteredWorkspacePolicy;
	  }
	| { readonly kind: 'memory' }
	| {
			readonly hostPath?: string;
			readonly kind: 'shadow';
			readonly pinnedHostRoot?: PinnedRealFsRoot;
			readonly shadowConfig?: {
				readonly deny: readonly string[];
				readonly tmpfs: readonly string[];
			};
	  };

export interface CreateVmOptions {
	readonly imagePath: string;
	readonly memory: string;
	readonly cpus: number;
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly runtimeRootfsSize?: string;
	readonly allowedHosts: readonly string[];
	readonly secrets: Record<string, ManagedHttpMediatedSecretSpec>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly tcpHosts?: Record<string, string>;
	readonly sshEgress?: ManagedSshEgressOptions;
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
	finalizeMemoryMount(request: ManagedVmFinalizeMemoryMountRequest): Promise<void>;
	getHostPid(): number | null;
	getVmInstance(): ManagedVmInstance;
	setIngressRoutes(routes: readonly IngressRoute[]): void;
	start(): Promise<void>;
	close(): Promise<void>;
}

/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- VM.create() returns
   Gondolin's concrete VM class; this adapter exposes only the narrower
   ManagedVmInstance interface used by agent-vm. */
function createDefaultDependencies(): ManagedVmDependencies {
	const createDefaultRealFsProvider = (hostPath: string): VirtualProvider =>
		new RealFSProvider(hostPath);
	return {
		configureHostNetworkDefaults,
		createVm: async (vmOptions: VMOptions): Promise<ManagedVmInstance> =>
			(await VM.create(vmOptions)) as unknown as ManagedVmInstance,
		createHttpHooks: (hookOptions) =>
			createHttpHooks({
				allowedHosts: [...hookOptions.allowedHosts],
				...(hookOptions.allowedInternalHosts === undefined
					? {}
					: { allowedInternalHosts: [...hookOptions.allowedInternalHosts] }),
				...(hookOptions.isIpAllowed ? { isIpAllowed: hookOptions.isIpAllowed } : {}),
				secrets: Object.fromEntries(
					Object.entries(hookOptions.secrets).map(([secretName, secretSpec]) => [
						secretName,
						{
							hosts: [...secretSpec.hosts],
							...(secretSpec.placeholder === undefined
								? {}
								: { placeholder: secretSpec.placeholder }),
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
		createReadonlyProvider: createHardenedReadonlyProvider,
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
	mountSpec: RealFsVfsMountSpec | Extract<VfsMountSpec, { readonly kind: 'shadow' }>,
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
		case 'finalizable-memory':
			throw new Error('Finalizable memory mounts require retained provider construction.');
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
		case 'filtered-workspace': {
			return createFilteredWorkspaceProvider({
				baseProvider: dependencies.createPinnedRealFsProvider(mountSpec.pinnedHostRoot),
				dependencies,
				policy: mountSpec.policy,
			});
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
			throw new Error('Unsupported VFS mount kind.');
		}
	}
}

interface FinalizableMemoryMount {
	readonly provider: VirtualProvider;
	state: 'failed' | 'finalized' | 'finalizing' | 'pending';
}

interface CreatedVfsMounts {
	readonly finalizableMemoryMounts: Map<string, FinalizableMemoryMount>;
	readonly mounts: Record<string, VirtualProvider>;
}

function createVfsMounts(
	vfsMounts: Record<string, VfsMountSpec>,
	dependencies: ManagedVmDependencies,
): CreatedVfsMounts {
	const mountMap: Record<string, VirtualProvider> = {};
	const finalizableMemoryMounts = new Map<string, FinalizableMemoryMount>();

	for (const [guestPath, mountSpec] of Object.entries(vfsMounts)) {
		if (mountSpec.kind === 'finalizable-memory') {
			const provider = dependencies.createMemoryProvider();
			finalizableMemoryMounts.set(guestPath, { provider, state: 'pending' });
			const guestProvider = createGuestRootOwnedProvider(provider);
			mountMap[guestPath] =
				mountSpec.access === 'read-only'
					? dependencies.createReadonlyProvider(guestProvider)
					: guestProvider;
			continue;
		}
		mountMap[guestPath] = createProviderFromSpec(mountSpec, dependencies);
	}

	return { finalizableMemoryMounts, mounts: mountMap };
}

function collectPinnedRealFsRoots(
	vfsMounts: Record<string, VfsMountSpec>,
): readonly PinnedRealFsRoot[] {
	const roots = new Map<number, PinnedRealFsRoot>();
	for (const mountSpec of Object.values(vfsMounts)) {
		if ('pinnedHostRoot' in mountSpec && mountSpec.pinnedHostRoot) {
			roots.set(mountSpec.pinnedHostRoot.fd, mountSpec.pinnedHostRoot);
		}
	}
	return [...roots.values()];
}

function closePinnedRealFsRoots(
	roots: readonly PinnedRealFsRoot[],
	dependencies: ManagedVmDependencies,
): void {
	const closeErrors: unknown[] = [];
	for (const root of roots) {
		try {
			dependencies.closePinnedRealFsRoot(root);
		} catch (error) {
			closeErrors.push(error);
		}
	}
	if (closeErrors.length === 1) {
		throw closeErrors[0];
	}
	if (closeErrors.length > 1) {
		throw new AggregateError(closeErrors, 'Multiple pinned RealFS roots failed to close.');
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

function resolveManagedVmIngressOptions(
	ingressOptions: EnableIngressOptions = {},
): EnableIngressOptions {
	const resolvedOptions: EnableIngressOptions = {
		...MANAGED_VM_DEFAULT_INGRESS_OPTIONS,
	};

	if (ingressOptions.listenHost !== undefined) {
		resolvedOptions.listenHost = ingressOptions.listenHost;
	}
	if (ingressOptions.listenPort !== undefined) {
		resolvedOptions.listenPort = ingressOptions.listenPort;
	}
	if (ingressOptions.allowWebSockets !== undefined) {
		resolvedOptions.allowWebSockets = ingressOptions.allowWebSockets;
	}
	if (ingressOptions.hooks !== undefined) {
		resolvedOptions.hooks = ingressOptions.hooks;
	}
	if (ingressOptions.bufferResponseBody !== undefined) {
		resolvedOptions.bufferResponseBody = ingressOptions.bufferResponseBody;
	}
	if (ingressOptions.maxBufferedResponseBodyBytes !== undefined) {
		resolvedOptions.maxBufferedResponseBodyBytes = ingressOptions.maxBufferedResponseBodyBytes;
	}
	if (ingressOptions.upstreamHeaderTimeoutMs !== undefined) {
		resolvedOptions.upstreamHeaderTimeoutMs = ingressOptions.upstreamHeaderTimeoutMs;
	}
	if (ingressOptions.upstreamResponseTimeoutMs !== undefined) {
		resolvedOptions.upstreamResponseTimeoutMs = ingressOptions.upstreamResponseTimeoutMs;
	}

	return resolvedOptions;
}

interface TcpHostEndpoint {
	readonly hostname: string;
	readonly port: number;
}

interface InternalTcpHostRule extends TcpHostEndpoint {}

function normalizePolicyHostname(hostname: string): string {
	return hostname.toLowerCase();
}

function parseTcpHostEndpoint(endpoint: string): TcpHostEndpoint | undefined {
	if (endpoint.startsWith('[')) {
		const closingBracketIndex = endpoint.indexOf(']');
		if (closingBracketIndex > 1) {
			const portValue = Number.parseInt(endpoint.slice(closingBracketIndex + 2), 10);
			if (!Number.isFinite(portValue)) {
				return undefined;
			}
			return {
				hostname: normalizePolicyHostname(endpoint.slice(1, closingBracketIndex)),
				port: portValue,
			};
		}
	}

	const portSeparatorIndex = endpoint.lastIndexOf(':');
	if (portSeparatorIndex <= 0) {
		return undefined;
	}
	const portValue = Number.parseInt(endpoint.slice(portSeparatorIndex + 1), 10);
	if (!Number.isFinite(portValue)) {
		return undefined;
	}
	return {
		hostname: normalizePolicyHostname(endpoint.slice(0, portSeparatorIndex)),
		port: portValue,
	};
}

function ipv4AddressIsInternal(ipAddress: string): boolean {
	const octets = ipAddress.split('.').map((segment) => Number.parseInt(segment, 10));
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
		return false;
	}
	const firstOctet = octets[0];
	const secondOctet = octets[1];
	if (firstOctet === undefined || secondOctet === undefined) {
		return false;
	}
	return (
		firstOctet === 10 ||
		firstOctet === 127 ||
		(firstOctet === 169 && secondOctet === 254) ||
		(firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
		(firstOctet === 192 && secondOctet === 168) ||
		(firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127)
	);
}

function ipAddressIsInternal(ipAddress: string): boolean {
	if (net.isIP(ipAddress) === 4) {
		return ipv4AddressIsInternal(ipAddress);
	}
	const normalizedIpAddress = ipAddress.toLowerCase();
	if (normalizedIpAddress.startsWith('::ffff:')) {
		return ipv4AddressIsInternal(normalizedIpAddress.slice('::ffff:'.length));
	}
	return (
		normalizedIpAddress === '::1' ||
		normalizedIpAddress.startsWith('fc') ||
		normalizedIpAddress.startsWith('fd') ||
		normalizedIpAddress.startsWith('fe80:')
	);
}

function endpointHostnameIsInternal(hostname: string): boolean {
	const normalizedHostname = normalizePolicyHostname(hostname);
	return (
		normalizedHostname === 'localhost' ||
		normalizedHostname === 'host.docker.internal' ||
		ipAddressIsInternal(normalizedHostname)
	);
}

function deriveInternalTcpHostRules(
	tcpHosts: Record<string, string> | undefined,
): readonly InternalTcpHostRule[] {
	if (!tcpHosts) {
		return [];
	}

	const rules: InternalTcpHostRule[] = [];
	for (const [tcpHostKey, tcpHostTarget] of Object.entries(tcpHosts)) {
		const exposedEndpoint = parseTcpHostEndpoint(tcpHostKey);
		const targetEndpoint = parseTcpHostEndpoint(tcpHostTarget);
		if (
			!exposedEndpoint ||
			!targetEndpoint ||
			!endpointHostnameIsInternal(targetEndpoint.hostname)
		) {
			continue;
		}
		if (
			!rules.some(
				(rule) => rule.hostname === exposedEndpoint.hostname && rule.port === exposedEndpoint.port,
			)
		) {
			rules.push(exposedEndpoint);
		}
	}
	return rules;
}

function mergeUniqueHosts(
	hosts: readonly string[],
	additionalHosts: readonly string[],
): readonly string[] {
	const mergedHosts = [...hosts];
	for (const host of additionalHosts) {
		if (!mergedHosts.includes(host)) {
			mergedHosts.push(host);
		}
	}
	return mergedHosts;
}

function normalizeGitRepoPath(repoPath: string): string {
	return repoPath.replace(/^\/+/u, '').replace(/\.git$/u, '');
}

export function createGitReadOnlySshEgressOptions(
	options: GitReadOnlySshEgressOptions,
): ManagedSshEgressOptions {
	const allowedRepos =
		options.allowedRepos === undefined
			? undefined
			: new Set(options.allowedRepos.map((repoPath) => normalizeGitRepoPath(repoPath)));

	return {
		allowedHosts: [...options.allowedHosts],
		...(options.agent ? { agent: options.agent } : {}),
		...(options.knownHostsFile ? { knownHostsFile: options.knownHostsFile } : {}),
		execPolicy: (request) => {
			const gitExec = getInfoFromSshExecRequest(request);
			if (!gitExec) {
				return {
					allow: false,
					message: 'agent-vm: non-git SSH exec is denied',
				};
			}
			if (gitExec.service === 'git-receive-pack') {
				return {
					allow: false,
					message: 'agent-vm: git push over guest SSH is denied',
				};
			}
			if (gitExec.service !== 'git-upload-pack') {
				return {
					allow: false,
					message: 'agent-vm: unsupported git SSH service is denied',
				};
			}
			if (allowedRepos && !allowedRepos.has(normalizeGitRepoPath(gitExec.repo))) {
				return {
					allow: false,
					message: 'agent-vm: git repository is not allowlisted for guest SSH reads',
				};
			}
			return { allow: true };
		},
	};
}

function createInternalTcpHostPolicy(
	rules: readonly InternalTcpHostRule[],
): HttpHooks['isIpAllowed'] | undefined {
	if (rules.length === 0) {
		return undefined;
	}
	const ruleHostnames = new Set(rules.map((rule) => rule.hostname));
	return (info) => {
		const hostname = normalizePolicyHostname(info.hostname);
		const exactRuleMatched = rules.some(
			(rule) => rule.hostname === hostname && rule.port === info.port,
		);
		if (ruleHostnames.has(hostname)) {
			return exactRuleMatched;
		}
		if (ipAddressIsInternal(info.ip)) {
			return false;
		}
		return true;
	};
}

export async function createManagedVm(
	options: CreateVmOptions,
	dependencies: ManagedVmDependencies = createDefaultDependencies(),
): Promise<ManagedVm> {
	dependencies.configureHostNetworkDefaults?.();
	const hasTcpHosts = options.tcpHosts && Object.keys(options.tcpHosts).length > 0;
	const hasSshEgress = options.sshEgress !== undefined && options.sshEgress.allowedHosts.length > 0;
	const internalTcpHostRules = deriveInternalTcpHostRules(options.tcpHosts);
	const allowedInternalHosts = mergeUniqueHosts(
		[],
		internalTcpHostRules.map((rule) => rule.hostname),
	);
	const isIpAllowed = createInternalTcpHostPolicy(internalTcpHostRules);
	const pinnedRealFsRoots = collectPinnedRealFsRoots(options.vfsMounts);
	let createdVfsMounts: CreatedVfsMounts;
	let vmInstance: ManagedVmInstance;
	try {
		createdVfsMounts = createVfsMounts(options.vfsMounts, dependencies);
		const hookBundle = dependencies.createHttpHooks({
			allowedHosts: options.allowedHosts,
			...(allowedInternalHosts.length > 0 ? { allowedInternalHosts } : {}),
			...(isIpAllowed ? { isIpAllowed } : {}),
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
				mounts: createdVfsMounts.mounts,
			},
			...(hasTcpHosts || hasSshEgress
				? {
						dns: {
							mode: 'synthetic',
							syntheticIPv4: SYNTHETIC_DNS_IPV4_BENCHMARK,
							syntheticIPv6: SYNTHETIC_DNS_IPV6_IPV4_MAPPED_BENCHMARK,
							syntheticHostMapping: 'per-host',
						},
						...(hasSshEgress ? { ssh: options.sshEgress } : {}),
						...(hasTcpHosts
							? {
									tcp: {
										hosts: options.tcpHosts,
									},
								}
							: {}),
					}
				: {}),
		});
	} catch (error) {
		closePinnedRealFsRootsAfterFailure(pinnedRealFsRoots, dependencies);
		throw error;
	}

	let finalizationPoison: unknown;
	let lifecycleState: 'closed' | 'created' | 'started' = 'created';
	const poisonFinalization = (error: unknown): void => {
		finalizationPoison ??= error;
	};
	return {
		fs: vmInstance.fs,
		id: vmInstance.id,
		exec(command: ManagedExecInput, execOptions?: ManagedExecOptions): ManagedExecProcess {
			const normalizedCommand = typeof command === 'string' ? command : [...command];
			return vmInstance.exec(normalizedCommand, execOptions);
		},
		async enableSsh(sshOptions?: EnableSshOptions): Promise<SshAccess> {
			const sshAccess = await vmInstance.enableSsh(sshOptions);
			let serverHostKey: SshServerHostKey;
			try {
				serverHostKey = await readSshServerHostKey(vmInstance);
			} catch (identityError) {
				return await closeSshAccessAfterIdentityFailure(sshAccess, identityError);
			}
			return {
				close: async (): Promise<void> => await sshAccess.close(),
				command: sshAccess.command,
				host: sshAccess.host,
				identityFile: sshAccess.identityFile,
				port: sshAccess.port,
				serverHostKey,
				user: sshAccess.user,
			};
		},
		async enableIngress(ingressOptions?: EnableIngressOptions): Promise<IngressAccess> {
			return await vmInstance.enableIngress(resolveManagedVmIngressOptions(ingressOptions));
		},
		async finalizeMemoryMount(request: ManagedVmFinalizeMemoryMountRequest): Promise<void> {
			if (lifecycleState === 'closed') {
				throw new Error('Managed Gondolin VM memory mounts cannot be finalized after close.');
			}
			if (lifecycleState === 'started') {
				throw new Error('Managed Gondolin VM memory mounts cannot be finalized after start.');
			}
			if (finalizationPoison !== undefined) {
				throw new Error('Managed Gondolin VM memory mount finalization is poisoned.', {
					cause: finalizationPoison,
				});
			}
			let validatedRequest: ManagedVmFinalizeMemoryMountRequest;
			try {
				validatedRequest = validateManagedVmFinalizeMemoryMountRequest(request);
				const mount = createdVfsMounts.finalizableMemoryMounts.get(validatedRequest.guestPath);
				if (mount === undefined) {
					throw new Error(
						`Managed Gondolin VM has no declared finalizable memory mount at '${validatedRequest.guestPath}'.`,
					);
				}
				if (mount.state !== 'pending') {
					throw new Error(
						`Managed Gondolin VM memory mount '${validatedRequest.guestPath}' must be finalized exactly once.`,
					);
				}
				mount.state = 'finalizing';
				if (mount.provider.writeFile === undefined) {
					throw new Error('Gondolin memory provider does not support file writes.');
				}
				for (const file of validatedRequest.files) {
					// oxlint-disable-next-line no-await-in-loop -- one-shot inventory publication is intentionally ordered.
					await mount.provider.writeFile(`/${file.relativePath}`, Buffer.from(file.contents), {
						mode: file.mode,
					});
				}
				mount.state = 'finalized';
			} catch (error) {
				const mount = createdVfsMounts.finalizableMemoryMounts.get(request.guestPath);
				if (mount !== undefined) mount.state = 'failed';
				poisonFinalization(error);
				throw error;
			}
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
		async start(): Promise<void> {
			if (finalizationPoison !== undefined) {
				throw new Error(
					'Managed Gondolin VM cannot start after memory finalization was poisoned.',
					{
						cause: finalizationPoison,
					},
				);
			}
			const incompleteMount = [...createdVfsMounts.finalizableMemoryMounts].find(
				([, mount]) => mount.state !== 'finalized',
			);
			if (incompleteMount !== undefined) {
				const error = new Error(
					`Managed Gondolin VM memory mount '${incompleteMount[0]}' must be finalized before start.`,
				);
				poisonFinalization(error);
				throw error;
			}
			await vmInstance.start();
			lifecycleState = 'started';
		},
		async close(): Promise<void> {
			const closeErrors: unknown[] = [];
			try {
				await vmInstance.close();
			} catch (error) {
				closeErrors.push(error);
			}
			lifecycleState = 'closed';
			createdVfsMounts.finalizableMemoryMounts.clear();
			try {
				closePinnedRealFsRoots(pinnedRealFsRoots, dependencies);
			} catch (error) {
				if (error instanceof AggregateError) {
					closeErrors.push(...error.errors);
				} else {
					closeErrors.push(error);
				}
			}
			if (closeErrors.length === 1) {
				throw closeErrors[0];
			}
			if (closeErrors.length > 1) {
				throw new AggregateError(closeErrors, 'Managed Gondolin VM cleanup failed.');
			}
		},
	};
}
