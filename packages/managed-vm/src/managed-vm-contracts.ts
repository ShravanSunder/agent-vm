/** A command executed in the guest. */
export type ManagedVmExecCommand = string | readonly string[];

export type ManagedVmExecStreamMode = { readonly kind: 'discard' } | { readonly kind: 'pipe' };

/**
 * Explicit bounded streaming policy. Omitting this group preserves the
 * backend's buffered execution behavior for existing non-streaming callers.
 */
export interface ManagedVmExecStreamingOptions {
	readonly stderr: ManagedVmExecStreamMode;
	readonly stdout: ManagedVmExecStreamMode;
	readonly windowBytes: number;
}

export interface ManagedVmExecOptions {
	readonly argv?: readonly string[];
	readonly cwd?: string;
	readonly env?: readonly string[] | Readonly<Record<string, string>>;
	readonly output?: ManagedVmExecStreamingOptions;
	readonly pty?: boolean;
	readonly signal?: AbortSignal;
	readonly stdin?: string | Uint8Array | AsyncIterable<Uint8Array>;
}

export interface ManagedVmExecResult {
	readonly exitCode: number;
	readonly ok: boolean;
	readonly signal?: number;
	readonly stderr: string;
	readonly stderrBuffer: Uint8Array;
	readonly stdout: string;
	readonly stdoutBuffer: Uint8Array;
	json<TValue>(): TValue;
	lines(): readonly string[];
	toString(): string;
}

/**
 * A guest execution is awaitable and may also stream decoded output. The
 * contract deliberately excludes backend process handles and Node streams.
 */
export interface ManagedVmExecProcess
	extends PromiseLike<ManagedVmExecResult>, AsyncIterable<string> {
	catch<TResult = never>(
		onRejected?: (reason: Error) => TResult | PromiseLike<TResult>,
	): Promise<ManagedVmExecResult | TResult>;
	end(): void;
	finally(onFinally?: () => void): Promise<ManagedVmExecResult>;
	lines(): AsyncIterable<string>;
	output(): AsyncIterable<ManagedVmExecOutputChunk>;
	readonly result: Promise<ManagedVmExecResult>;
	resize(rows: number, columns: number): void;
	write(data: string | Uint8Array): void;
}

export interface ManagedVmExecOutputChunk {
	readonly data: Uint8Array;
	readonly stream: 'stderr' | 'stdout';
	readonly text: string;
}

export interface ManagedVmSshServerHostKey {
	readonly algorithm: 'ssh-ed25519';
	readonly publicKeyBase64: string;
}

export interface ManagedVmAccessHandle {
	close(): Promise<void>;
	readonly host: string;
	readonly port: number;
	readonly url?: string;
}

export interface ManagedVmSshAccess extends ManagedVmAccessHandle {
	readonly command: string;
	readonly identityFile: string;
	readonly serverHostKey: ManagedVmSshServerHostKey;
	readonly user: string;
}

export interface ManagedVmEnableSshOptions {
	readonly listenHost?: string;
	readonly listenPort?: number;
	readonly user?: string;
}

export interface ManagedVmIngressOptions {
	readonly allowWebSockets?: boolean;
	readonly listenHost?: string;
	readonly bufferResponseBody?: boolean;
	readonly listenPort?: number;
	readonly maxBufferedResponseBodyBytes?: number;
	readonly upstreamHeaderTimeoutMs?: number;
	readonly upstreamResponseTimeoutMs?: number;
}

export interface ManagedVmIngressRoute {
	readonly port: number;
	readonly prefix: string;
	readonly stripPrefix: boolean;
}

export interface ManagedVmResources {
	readonly cpuCount: number;
	readonly memory: string;
}

export type ManagedVmRootfsMode = 'readonly' | 'memory' | 'cow';

export interface ManagedVmCanonicalDirectoryIdentity {
	/** Canonical path is descriptive identity; it is never a mount authority. */
	readonly canonicalPath: string;
	readonly device: number;
	readonly inode: number;
}

export type OwnedHostDirectoryState = 'acquired' | 'adapter-owned' | 'closed';

/**
 * Single-use host-directory authority. Passing this object to createManagedVm
 * authorizes the provider to call consume exactly once. It exposes no native
 * handle, file descriptor, or raw-path fallback.
 */
export interface OwnedHostDirectory {
	close(): void;
	consume(): OwnedHostDirectoryTransfer;
	readonly identity: ManagedVmCanonicalDirectoryIdentity;
	readonly state: OwnedHostDirectoryState;
}

/** Ownership retained by the provider after successful consumption. */
export interface OwnedHostDirectoryTransfer {
	close(): void;
	readonly identity: ManagedVmCanonicalDirectoryIdentity;
	readonly state: 'adapter-owned' | 'closed';
}

export type ManagedVmFilteredWorkspaceVisibility =
	| { readonly kind: 'whole-root-writable' }
	| {
			readonly kind: 'positive-paths';
			readonly visiblePaths: readonly string[];
			readonly writablePaths: readonly string[];
	  };

export interface ManagedVmFilteredWorkspaceReadonlyInput {
	readonly destinationRelativePath: string;
	readonly sourceRelativePath: string;
}

/** Controller-authored policy over one owned canonical workspace root. */
export interface ManagedVmFilteredWorkspacePolicy {
	readonly hiddenPaths: readonly string[];
	readonly readonlyInputs: readonly ManagedVmFilteredWorkspaceReadonlyInput[];
	readonly temporaryPaths: readonly string[];
	readonly visibility: ManagedVmFilteredWorkspaceVisibility;
}

export type ManagedVmMount =
	| {
			readonly access: 'read-only' | 'read-write';
			readonly hostPath: string;
			readonly kind: 'host-directory';
	  }
	| {
			readonly access: 'read-only' | 'read-write';
			readonly directory: OwnedHostDirectory;
			readonly kind: 'owned-host-directory';
	  }
	| {
			readonly directory: OwnedHostDirectory;
			readonly kind: 'owned-filtered-workspace';
			readonly policy: ManagedVmFilteredWorkspacePolicy;
	  }
	| { readonly kind: 'memory' }
	| {
			readonly deny: readonly string[];
			readonly hostPath: string;
			readonly kind: 'shadow';
			readonly temporaryFilesystems: readonly string[];
	  };

export interface ManagedVmMediatedSecretDescriptor {
	readonly allowedHosts: readonly string[];
	readonly environmentVariable: string;
	/** Opaque, non-secret token used to represent the mediated value inside the guest. */
	readonly guestPlaceholder?: string;
	/**
	 * Resolved only at the trusted host/provider boundary. The provider must use
	 * this value solely for outbound HTTP mediation and must never inject the raw
	 * value into the guest environment or VM image.
	 */
	readonly value: string;
}

export interface ManagedVmRequestMediation {
	readonly onRequest?: (request: Request) => Promise<Request | Response | void>;
	readonly onResponse?: (response: Response) => Promise<Response | void>;
}

export interface ManagedVmTcpHostMapping {
	readonly guestHost: string;
	readonly target: string;
}

export interface ManagedVmGitReadOnlySshEgress {
	readonly allowedHosts: readonly string[];
	readonly allowedRepositories?: readonly string[];
	readonly agentSocket?: string;
	readonly kind: 'git-read-only';
	readonly knownHostsFile?: string;
}

export interface ManagedVmCreateRequest {
	readonly allowedHosts: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly imageReference: string;
	readonly mediatedSecrets: readonly ManagedVmMediatedSecretDescriptor[];
	readonly mediation?: ManagedVmRequestMediation;
	readonly mounts: Readonly<Record<string, ManagedVmMount>>;
	readonly resources: ManagedVmResources;
	readonly rootfsMode: ManagedVmRootfsMode;
	readonly runtimeRootfsSize?: string;
	readonly sessionLabel: string;
	readonly sshEgress?: ManagedVmGitReadOnlySshEgress;
	readonly tcpHosts: readonly ManagedVmTcpHostMapping[];
}

export interface ManagedVm {
	close(): Promise<void>;
	configureIngressRoutes(routes: readonly ManagedVmIngressRoute[]): void;
	enableIngress(options?: ManagedVmIngressOptions): Promise<ManagedVmAccessHandle>;
	enableSsh(options?: ManagedVmEnableSshOptions): Promise<ManagedVmSshAccess>;
	exec(command: ManagedVmExecCommand, options?: ManagedVmExecOptions): ManagedVmExecProcess;
	/** Null before start succeeds or after the owned host process exits. */
	getHostProcessId(): number | null;
	readonly id: string;
	start(): Promise<void>;
}

/** Durable controller identity captured before authority admission. */
export interface ManagedVmHostProcessIdentity {
	readonly command: string;
	readonly hostProcessId: number;
	readonly processStartIdentity: string;
	readonly vmId: string;
}

export interface ManagedVmExactProcessTerminationRequest {
	readonly contextLabel: string;
	readonly identity: ManagedVmHostProcessIdentity;
}

export type ManagedVmExactProcessTerminationOutcome =
	| { readonly hostProcessId: number; readonly kind: 'already-absent' }
	| { readonly hostProcessId: number; readonly kind: 'terminated' };

export interface ManagedVmExactProcessTerminationCapability {
	terminateRecordedHostProcess(
		request: ManagedVmExactProcessTerminationRequest,
	): Promise<ManagedVmExactProcessTerminationOutcome>;
}

export interface ManagedVmFactory {
	createManagedVm(request: ManagedVmCreateRequest): Promise<ManagedVm>;
}

export interface ManagedVmImageBuildRequest {
	readonly cacheDirectory: string;
	readonly forceRebuild?: boolean;
	readonly recipePath: string;
}

export interface ManagedVmImageBuildResult {
	readonly built: boolean;
	readonly fingerprint: string;
	readonly imageReference: string;
}

export interface ManagedVmImageCapability {
	prepareImage(request: ManagedVmImageBuildRequest): Promise<ManagedVmImageBuildResult>;
}

export interface ManagedVmCompatibilityDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly severity: 'error' | 'warning';
}

export interface ManagedVmDiagnosticsCapability {
	checkCompatibility(): Promise<readonly ManagedVmCompatibilityDiagnostic[]>;
}

export interface ManagedVmOwnedDirectoryCapability {
	openHostDirectory(hostPath: string): OwnedHostDirectory;
}

/** Aggregate available only at application composition boundaries. */
export interface ManagedVmProvider {
	readonly diagnostics: ManagedVmDiagnosticsCapability;
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly factory: ManagedVmFactory;
	readonly images: ManagedVmImageCapability;
	readonly ownedDirectories: ManagedVmOwnedDirectoryCapability;
}
