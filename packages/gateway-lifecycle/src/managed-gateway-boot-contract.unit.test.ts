import { describe, expect, it } from 'vitest';

import {
	parseManagedGatewayBootContract,
	type ManagedFrameworkKind,
} from './managed-gateway-boot-contract.js';

function createManagedGatewayBootContractInput(
	framework: ManagedFrameworkKind = 'hermes',
): Readonly<Record<string, unknown>> {
	return {
		contractVersion: 1,
		frameworkService: {
			bootEntry: 'hermes-gateway',
			configurationInputPath: `/run/agent-vm/boot/${framework}.json`,
			environmentInputPath: `/run/agent-vm/boot/${framework}.env`,
			framework,
			ingress: {
				guestPort: 18889,
				kind: 'framework-http',
			},
			logIdentity: {
				guestPath: `/var/log/agent-vm/${framework}.log`,
				serviceName: `agent-vm-${framework}`,
			},
			readiness: {
				guestPort: 18889,
				kind: 'framework-http',
				path: '/readyz',
			},
			role: 'framework-service',
		},
		kind: 'managed-gateway-exact-two-role',
		toolPortalService: {
			bootEntry: 'agent-vm-gateway-runtime',
			configurationInputPath: '/run/agent-vm/boot/tool-portal.json',
			environmentInputPath: '/run/agent-vm/boot/tool-portal.env',
			logIdentity: {
				guestPath: '/var/log/agent-vm/tool-portal.log',
				serviceName: 'agent-vm-tool-portal',
			},
			readiness: {
				evidencePath: '/run/agent-vm/gateway-runtime/ready.json',
				kind: 'tool-portal-evidence',
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
			},
			role: 'tool-portal-service',
		},
	};
}

function withRootField(
	input: Readonly<Record<string, unknown>>,
	fieldName: string,
	fieldValue: unknown,
): Readonly<Record<string, unknown>> {
	return { ...input, [fieldName]: fieldValue };
}

function withoutRootField(
	input: Readonly<Record<string, unknown>>,
	fieldName: string,
): Readonly<Record<string, unknown>> {
	return Object.fromEntries(Object.entries(input).filter(([key]) => key !== fieldName));
}

function withServiceField(
	input: Readonly<Record<string, unknown>>,
	serviceName: 'frameworkService' | 'toolPortalService',
	fieldName: string,
	fieldValue: unknown,
): Readonly<Record<string, unknown>> {
	const service = input[serviceName];
	if (service === null || typeof service !== 'object' || Array.isArray(service)) {
		throw new Error(`Expected ${serviceName} test fixture to be an object.`);
	}
	return {
		...input,
		[serviceName]: {
			...service,
			[fieldName]: fieldValue,
		},
	};
}

describe('managed Gateway boot contract', () => {
	it.each(['hermes'] as const)(
		'accepts exactly one Tool Portal service and one %s framework service',
		(framework) => {
			const contract = parseManagedGatewayBootContract(
				createManagedGatewayBootContractInput(framework),
			);

			expect(contract.toolPortalService).toMatchObject({
				bootEntry: 'agent-vm-gateway-runtime',
				role: 'tool-portal-service',
			});
			expect(contract.frameworkService).toMatchObject({
				bootEntry: 'hermes-gateway',
				framework,
				role: 'framework-service',
			});
		},
	);

	it('returns a deeply frozen copy rather than retaining caller-owned objects', () => {
		const input = createManagedGatewayBootContractInput();
		const contract = parseManagedGatewayBootContract(input);

		expect(contract).not.toBe(input);
		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.toolPortalService)).toBe(true);
		expect(Object.isFrozen(contract.toolPortalService.logIdentity)).toBe(true);
		expect(Object.isFrozen(contract.toolPortalService.readiness)).toBe(true);
		expect(Object.isFrozen(contract.frameworkService)).toBe(true);
		expect(Object.isFrozen(contract.frameworkService.ingress)).toBe(true);
		expect(Object.isFrozen(contract.frameworkService.logIdentity)).toBe(true);
		expect(Object.isFrozen(contract.frameworkService.readiness)).toBe(true);
		expect(Reflect.set(contract.frameworkService.readiness, 'path', '/health')).toBe(false);
	});

	it.each([
		['root array', []],
		[
			'missing Tool Portal role',
			withoutRootField(createManagedGatewayBootContractInput(), 'toolPortalService'),
		],
		[
			'missing framework role',
			withoutRootField(createManagedGatewayBootContractInput(), 'frameworkService'),
		],
		[
			'arbitrary service array',
			withRootField(createManagedGatewayBootContractInput(), 'services', [
				createManagedGatewayBootContractInput().toolPortalService,
				createManagedGatewayBootContractInput().frameworkService,
			]),
		],
		[
			'duplicate Tool Portal roles',
			withRootField(createManagedGatewayBootContractInput(), 'toolPortalServices', [
				createManagedGatewayBootContractInput().toolPortalService,
				createManagedGatewayBootContractInput().toolPortalService,
			]),
		],
		[
			'duplicate framework services',
			withRootField(createManagedGatewayBootContractInput(), 'frameworkServices', [
				createManagedGatewayBootContractInput('hermes').frameworkService,
				createManagedGatewayBootContractInput('hermes').frameworkService,
			]),
		],
		[
			'Worker contamination',
			withServiceField(
				createManagedGatewayBootContractInput(),
				'frameworkService',
				'framework',
				'worker',
			),
		],
		[
			'unknown framework role',
			withServiceField(
				createManagedGatewayBootContractInput(),
				'frameworkService',
				'framework',
				'unknown',
			),
		],
	])('rejects %s', (_label, input) => {
		expect(() => parseManagedGatewayBootContract(input)).toThrow();
	});

	it.each([
		['childRecipe', { kind: 'managed-framework-runtime' }],
		['supervisor', { kind: 'framework-supervisor' }],
		['launcher', { kind: 'framework-launcher' }],
		['command', 'openclaw gateway run'],
		['startCommand', 'openclaw gateway run'],
		['bootstrapCommand', 'install dependencies'],
		['argv', ['openclaw', 'gateway', 'run']],
		['spawn', () => undefined],
		['restart', () => undefined],
		['signal', () => undefined],
		['adopt', () => undefined],
		['resolvedSecrets', { OPENAI_API_KEY: 'resolved-secret-canary' }],
		['secret', 'resolved-secret-canary'],
		['managedVm', { start: () => undefined }],
		['nativeHandle', { provider: 'gondolin' }],
		['guestPid', 123],
		['children', []],
	])('rejects forbidden %s authority', (fieldName, fieldValue) => {
		const input = withServiceField(
			createManagedGatewayBootContractInput(),
			'frameworkService',
			fieldName,
			fieldValue,
		);

		expect(() => parseManagedGatewayBootContract(input)).toThrow(/unknown field/u);
	});

	it('rejects an environment value map instead of a protected environment input path', () => {
		const input = withServiceField(
			createManagedGatewayBootContractInput(),
			'toolPortalService',
			'environment',
			{ OPENAI_API_KEY: 'resolved-secret-canary' },
		);

		expect(() => parseManagedGatewayBootContract(input)).toThrow(/unknown field/u);
	});

	it('rejects symbol fields and accessor callbacks hidden outside JSON object keys', () => {
		const inputWithSymbol = {
			...createManagedGatewayBootContractInput(),
			[Symbol('nativeHandle')]: { provider: 'gondolin' },
		};
		let getterInvocations = 0;
		const inputWithAccessor = { ...createManagedGatewayBootContractInput() };
		Object.defineProperty(inputWithAccessor, 'frameworkService', {
			enumerable: true,
			get: () => {
				getterInvocations += 1;
				return createManagedGatewayBootContractInput().frameworkService;
			},
		});

		expect(() => parseManagedGatewayBootContract(inputWithSymbol)).toThrow(/symbol field/u);
		expect(() => parseManagedGatewayBootContract(inputWithAccessor)).toThrow(/data field/u);
		expect(getterInvocations).toBe(0);
	});

	it.each([['hermes', 'unknown-gateway']] as const)(
		'rejects %s paired with the wrong closed boot entry',
		(framework, bootEntry) => {
			const input = withServiceField(
				createManagedGatewayBootContractInput(framework),
				'frameworkService',
				'bootEntry',
				bootEntry,
			);

			expect(() => parseManagedGatewayBootContract(input)).toThrow(/bootEntry/u);
		},
	);

	it.each([
		['relative configuration input', 'configurationInputPath', 'run/config.json'],
		['relative environment input', 'environmentInputPath', 'run/environment'],
	] as const)('rejects %s', (_label, fieldName, fieldValue) => {
		const input = withServiceField(
			createManagedGatewayBootContractInput(),
			'frameworkService',
			fieldName,
			fieldValue,
		);

		expect(() => parseManagedGatewayBootContract(input)).toThrow(/absolute guest path/u);
	});

	it('rejects framework ingress and readiness identities that name different ports', () => {
		const baseInput = createManagedGatewayBootContractInput();
		const frameworkService = baseInput.frameworkService;
		if (
			frameworkService === null ||
			typeof frameworkService !== 'object' ||
			Array.isArray(frameworkService)
		) {
			throw new Error('Expected frameworkService test fixture to be an object.');
		}
		const input = {
			...baseInput,
			frameworkService: {
				...frameworkService,
				ingress: { guestPort: 18790, kind: 'framework-http' },
			},
		};

		expect(() => parseManagedGatewayBootContract(input)).toThrow(/same guest port/u);
	});
});
