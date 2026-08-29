import { describe, expect, it } from 'vitest';

import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';
import {
	serializeManagedGatewayBootInputs,
	type SerializeManagedGatewayBootInputsProps,
} from './managed-gateway-boot-input-materializer.js';

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
		vmId: 'managed-vm-exact-id',
		zoneId: 'zone-a',
	},
	frameworkIdentity: {
		attachmentGeneration: 1,
		clientKind: 'hermes-managed-plugin',
		configuredAgentIds: ['agent-a'],
		frameworkEpoch: 'framework-1',
		frameworkKind: 'hermes',
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

type TestSerializationInput = SerializeManagedGatewayBootInputsProps & {
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

function createSerializationInput(
	secretCanary = 'not-a-real-secret-canary',
): TestSerializationInput {
	return {
		cohort: expectedCohort,
		frameworkConfig: { apiServer: { host: '127.0.0.1', port: 8642 } },
		frameworkEnvironment: {
			API_SERVER_KEY: secretCanary,
			DISCORD_BOT_TOKEN: 'unrelated-framework-secret',
		},
		mcpConfig: { providers: {}, schemaVersion: 1 },
		toolPortalEnvironment: {
			HOME: '/home/hermes',
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

function decodeFiles(
	files: readonly {
		readonly contents: Uint8Array;
		readonly mode: number;
		readonly relativePath: string;
	}[],
): Readonly<Record<string, { readonly contents: string; readonly mode: number }>> {
	return Object.fromEntries(
		files.map((file) => [
			file.relativePath,
			{ contents: new TextDecoder().decode(file.contents), mode: file.mode },
		]),
	);
}

describe('serializeManagedGatewayBootInputs', () => {
	it('returns separate environment and structured inventories without filesystem identity', () => {
		const inputs = serializeManagedGatewayBootInputs(createSerializationInput());

		expect(decodeFiles(inputs.environmentFiles)).toEqual({
			'framework.environment.sh': {
				contents:
					"export API_SERVER_KEY='not-a-real-secret-canary'\nexport DISCORD_BOT_TOKEN='unrelated-framework-secret'\n",
				mode: 0o600,
			},
			'tool-portal.environment.sh': {
				contents: "export HOME='/home/hermes'\nexport PATH='/pnpm:/usr/local/bin:/usr/bin:/bin'\n",
				mode: 0o600,
			},
		});
		expect(decodeFiles(inputs.structuredInputFiles)).toEqual({
			'framework-service.json': {
				contents: '{\n\t"apiServer": {\n\t\t"host": "127.0.0.1",\n\t\t"port": 8642\n\t}\n}\n',
				mode: 0o600,
			},
			'mcp.config.json': {
				contents: '{\n\t"providers": {},\n\t"schemaVersion": 1\n}\n',
				mode: 0o600,
			},
			'tool-portal-service.json': {
				contents:
					'{\n\t"controlEndpoint": {\n\t\t"listen": {\n\t\t\t"host": "127.0.0.1",\n\t\t\t"port": 18790\n\t\t}\n\t},\n\t"runtimeRoot": "/run/agent-vm/gateway-runtime",\n\t"schemaVersion": 1\n}\n',
				mode: 0o600,
			},
		});
		expect(inputs).not.toHaveProperty('directoryPath');
		expect(inputs).not.toHaveProperty('receiptId');
	});

	it('rejects unsafe environment and noncanonical JSON before returning either inventory', () => {
		expect(() =>
			serializeManagedGatewayBootInputs({
				...createSerializationInput(),
				frameworkEnvironment: { 'UNSAFE-NAME': 'value' },
			}),
		).toThrow('environment variable name');
		expect(() =>
			serializeManagedGatewayBootInputs({
				...createSerializationInput(),
				mcpConfig: { invalid: Number.NaN },
			}),
		).toThrow('finite JSON number');
	});

	it('rejects a Tool Portal listener outside the protected ingress intent', () => {
		expect(() =>
			serializeManagedGatewayBootInputs({
				...createSerializationInput(),
				toolPortalServiceConfig: {
					...createSerializationInput().toolPortalServiceConfig,
					controlEndpoint: {
						listen: { host: '127.0.0.1', port: 18_791 },
					},
				},
			}),
		).toThrow('must match protected ingress intent');
	});
});
