import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmExecProcess,
	ManagedVmExactProcessTerminationRequest,
	ManagedVmAccessHandle,
	ManagedVmMediatedSecretDescriptor,
	ManagedVmRequestMediation,
	ManagedVmProvider,
	ManagedVmSshAccess,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';

declare function createNeutralExecProcess(): ManagedVmExecProcess;
declare function openNeutralHostDirectory(hostPath: string): OwnedHostDirectory;

const mediatedSecret = {
	allowedHosts: ['api.example.test'],
	environmentVariable: 'EXAMPLE_TOKEN',
	value: 'resolved-only-at-trusted-host-boundary',
} satisfies ManagedVmMediatedSecretDescriptor;

const mediationHooks = {
	onRequest: async (_request: Request) => {},
	onResponse: async (_response: Response) => {},
} satisfies ManagedVmRequestMediation;

class FakeManagedVm implements ManagedVm {
	readonly id = 'fake-managed-vm';
	private started = false;

	async close(): Promise<void> {}

	configureIngressRoutes(): void {}

	async enableIngress(): Promise<ManagedVmAccessHandle> {
		return { close: async (): Promise<void> => {}, host: '127.0.0.1', port: 17001 };
	}

	async enableSsh(): Promise<ManagedVmSshAccess> {
		return {
			close: async (): Promise<void> => {},
			command: 'ssh fake',
			host: '127.0.0.1',
			identityFile: '/tmp/fake-identity',
			port: 17002,
			serverHostKey: { algorithm: 'ssh-ed25519' as const, publicKeyBase64: 'ZmFrZQ==' },
			user: 'root',
		};
	}

	exec(): ManagedVmExecProcess {
		return createNeutralExecProcess();
	}

	getHostProcessId(): number | null {
		return this.started ? 4242 : null;
	}

	async start(): Promise<void> {
		this.started = true;
	}
}

const fakeProvider = {
	diagnostics: {
		checkCompatibility: async () => [],
	},
	exactProcessTermination: {
		terminateRecordedHostProcess: async (request: ManagedVmExactProcessTerminationRequest) => ({
			hostProcessId: request.identity.hostProcessId,
			kind: 'already-absent',
		}),
	},
	factory: {
		createManagedVm: async (_request: ManagedVmCreateRequest): Promise<ManagedVm> =>
			new FakeManagedVm(),
	},
	images: {
		prepareImage: async () => ({
			built: false,
			fingerprint: 'fake-fingerprint',
			imageReference: '/fake/image',
		}),
	},
	ownedDirectories: {
		openHostDirectory: (hostPath: string) => openNeutralHostDirectory(hostPath),
	},
} satisfies ManagedVmProvider;

void [fakeProvider, mediatedSecret, mediationHooks];
