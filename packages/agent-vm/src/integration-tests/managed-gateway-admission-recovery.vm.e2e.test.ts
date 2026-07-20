import type { ManagedVm } from '@agent-vm/managed-vm';
import { describe, expect, it } from 'vitest';

import type {
	GatewayExpectedAdmissionCohort,
	GatewayIngressRouteIdentity,
	GatewayReadinessVector,
} from '../gateway/gateway-aggregate-admission-state.js';
import type { GatewayAtomicAdmissionCandidate } from '../gateway/gateway-atomic-admission-contract.js';
import { createGatewayAtomicAdmissionController } from '../gateway/gateway-atomic-admission-controller.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import {
	createManagedGatewayImageBootFixture,
	managedGatewayBootInputGuestRoot,
	type ManagedGatewayImageBootFixture,
} from './managed-gateway-image-boot-test-fixture.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const gatewayObservationTimeoutMs = 90_000;
const gatewayObservationRetryIntervalMs = 100;

type ManagedGatewayObservedRole = 'framework-service' | 'tool-portal-service';

interface ManagedGatewayRoleObservation {
	readonly processId: number;
	readonly role: ManagedGatewayObservedRole;
	readonly startIdentity: string;
}

interface ManagedGatewayLiveObservation {
	readonly readinessEvidence: Readonly<Record<string, unknown>> | null;
	readonly roles: readonly ManagedGatewayRoleObservation[];
}

interface ManagedGatewayCandidateHarness {
	readonly candidate: GatewayAtomicAdmissionCandidate;
	readonly close: () => Promise<void>;
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly fixture: ManagedGatewayImageBootFixture;
	readonly getHostProcessId: () => number;
	readonly routeHistory: readonly (readonly GatewayIngressRouteIdentity[])[];
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoleObservation(value: unknown): ManagedGatewayRoleObservation {
	if (
		!isObjectRecord(value) ||
		(value.role !== 'framework-service' && value.role !== 'tool-portal-service') ||
		typeof value.processId !== 'number' ||
		!Number.isSafeInteger(value.processId) ||
		value.processId <= 0 ||
		typeof value.startIdentity !== 'string' ||
		!/^\d+$/u.test(value.startIdentity)
	) {
		throw new Error(`Managed Gateway returned malformed role evidence: ${JSON.stringify(value)}.`);
	}
	return {
		processId: value.processId,
		role: value.role,
		startIdentity: value.startIdentity,
	};
}

function parseLiveObservation(stdout: string): ManagedGatewayLiveObservation {
	const parsed: unknown = JSON.parse(stdout);
	if (
		!isObjectRecord(parsed) ||
		!Array.isArray(parsed.roles) ||
		(parsed.readinessEvidence !== null && !isObjectRecord(parsed.readinessEvidence))
	) {
		throw new Error(`Managed Gateway returned malformed live evidence: ${stdout}`);
	}
	return {
		readinessEvidence: parsed.readinessEvidence,
		roles: parsed.roles.map(parseRoleObservation),
	};
}

function renderRoleObservationScript(): string {
	return String.raw`
import { readFile, readdir } from 'node:fs/promises';

function parseStatusName(statusText) {
	const nameLine = statusText.split('\n').find((line) => line.startsWith('Name:'));
	return nameLine === undefined ? '' : nameLine.slice('Name:'.length).trim();
}

function parseStartIdentity(statText) {
	const commandEnd = statText.lastIndexOf(')');
	if (commandEnd < 0) throw new Error('Malformed /proc stat process identity.');
	const fieldsAfterCommand = statText.slice(commandEnd + 1).trim().split(/\s+/u);
	const startIdentity = fieldsAfterCommand[19];
	if (typeof startIdentity !== 'string' || !/^\d+$/u.test(startIdentity)) {
		throw new Error('Missing /proc start identity.');
	}
	return startIdentity;
}

const roles = [];
for (const processDirectory of await readdir('/proc')) {
	if (!/^\d+$/u.test(processDirectory)) continue;
	try {
		const [commandLine, processStat, statusText] = await Promise.all([
			readFile('/proc/' + processDirectory + '/cmdline', 'utf8'),
			readFile('/proc/' + processDirectory + '/stat', 'utf8'),
			readFile('/proc/' + processDirectory + '/status', 'utf8'),
		]);
		const argv = commandLine.split('\0').filter((argument) => argument.length > 0);
		const command = argv.join(' ');
		let role;
		if (
			command.includes('agent-vm-gateway-runtime') &&
			command.includes(${JSON.stringify(`${managedGatewayBootInputGuestRoot}/tool-portal-service.json`)})
		) {
			role = 'tool-portal-service';
		} else if (
			parseStatusName(statusText) === 'openclaw' &&
			argv.length === 1 &&
			argv[0] === 'openclaw'
		) {
			role = 'framework-service';
		}
		if (role !== undefined) {
			roles.push({
				processId: Number.parseInt(processDirectory, 10),
				role,
				startIdentity: parseStartIdentity(processStat),
			});
		}
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
		throw error;
	}
}

let readinessEvidence = null;
try {
	readinessEvidence = JSON.parse(
		await readFile('/run/agent-vm/gateway-runtime/tool-portal.readiness.json', 'utf8'),
	);
} catch (error) {
	if (!(error && typeof error === 'object' && error.code === 'ENOENT')) throw error;
}
process.stdout.write(JSON.stringify({ readinessEvidence, roles }));
`;
}

async function observeGatewayRoles(vm: ManagedVm): Promise<ManagedGatewayLiveObservation> {
	const result = await vm.exec(
		['/bin/sh', '-c', 'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module'],
		{ stdin: renderRoleObservationScript() },
	);
	if (!result.ok) {
		throw new Error(
			`Managed Gateway role observation failed: exit=${String(result.exitCode)} stderr=${result.stderr}`,
		);
	}
	return parseLiveObservation(result.stdout);
}

async function waitForGatewayRoles(props: {
	readonly expectedGatewayEpoch: string;
	readonly expectedProcessEpoch: string;
	readonly vm: ManagedVm;
}): Promise<ManagedGatewayLiveObservation> {
	const startedAtMs = performance.now();
	let lastObservation: ManagedGatewayLiveObservation | undefined;
	while (performance.now() - startedAtMs <= gatewayObservationTimeoutMs) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- the guest exposes role readiness through files and /proc observations.
			lastObservation = await observeGatewayRoles(props.vm);
			const readinessEvidence = lastObservation.readinessEvidence;
			const attachment = readinessEvidence?.['uds'];
			const serviceIdentity = readinessEvidence?.['serviceIdentity'];
			const roleCounts = new Map<ManagedGatewayObservedRole, number>([
				['framework-service', 0],
				['tool-portal-service', 0],
			]);
			for (const role of lastObservation.roles) {
				roleCounts.set(role.role, (roleCounts.get(role.role) ?? 0) + 1);
			}
			if (
				readinessEvidence?.['kind'] === 'tool-portal-role-readiness' &&
				isObjectRecord(serviceIdentity) &&
				serviceIdentity['processEpoch'] === props.expectedProcessEpoch &&
				isObjectRecord(attachment) &&
				isObjectRecord(attachment['attachment']) &&
				isObjectRecord(attachment['attachment']['expected']) &&
				attachment['attachment']['expected']['gatewayEpoch'] === props.expectedGatewayEpoch &&
				roleCounts.get('tool-portal-service') === 1 &&
				roleCounts.get('framework-service') === 1
			) {
				return lastObservation;
			}
		} catch (error: unknown) {
			if (!isObjectRecord(error) || error['code'] !== 'ENOENT') throw error;
		}
		// oxlint-disable-next-line no-await-in-loop -- no cross-process event source exists before the readiness file is published.
		await waitForProtocolRetryInterval(gatewayObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway roles did not become ready: ${JSON.stringify(lastObservation)}.`,
	);
}

async function waitForHostProcessAbsence(hostProcessId: number): Promise<void> {
	const startedAtMs = performance.now();
	while (performance.now() - startedAtMs <= gatewayObservationTimeoutMs) {
		if (!isProcessAlive(hostProcessId)) return;
		// oxlint-disable-next-line no-await-in-loop -- the host exposes no portable QEMU process-exit event.
		await waitForProtocolRetryInterval(gatewayObservationRetryIntervalMs);
	}
	throw new Error(`Gateway VM host process '${String(hostProcessId)}' remained live after close.`);
}

function createExpectedCohort(props: {
	readonly identitySuffix: string;
	readonly vmId: string;
}): GatewayExpectedAdmissionCohort {
	const gatewayEpoch = `gateway-epoch-${props.identitySuffix}`;
	const processEpoch = `process-epoch-${props.identitySuffix}`;
	const frameworkEpoch = `framework-epoch-${props.identitySuffix}`;
	const runtimeEpoch = `runtime-epoch-${props.identitySuffix}`;
	return {
		controlIdentity: {
			controllerEpoch: 'controller-epoch-image-owned',
			generationId: `generation-${props.identitySuffix}`,
			peerId: 'peer-image-owned',
			processEpoch,
		},
		fence: {
			controllerEpoch: 'controller-epoch-image-owned',
			gatewayEpoch,
			vmId: props.vmId,
			zoneId: 'managed-gateway-image-boot',
		},
		frameworkIdentity: {
			attachmentGeneration: 1,
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['main'],
			frameworkEpoch,
			frameworkKind: 'openclaw',
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		},
		ingressIntent: {
			controlRoute: {
				audience: 'gateway-control',
				guestPort: 19_001,
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
		providerRevision: 'provider-image-boot',
		requiredBackendRevision: 'required-backends-image-boot',
		semanticRevision: 'semantic-image-boot',
		toolPortalIdentity: {
			processEpoch,
			role: 'tool-portal',
			runtimeEpoch,
			serviceId: `tool-portal-${props.identitySuffix}`,
		},
		udsIdentity: {
			frameworkEpoch,
			gatewayEpoch,
			runtimeEpoch,
			socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
		},
	};
}

function ready<TIdentity>(identity: TIdentity): {
	readonly identity: TIdentity;
	readonly kind: 'ready';
} {
	return { identity, kind: 'ready' };
}

function createReadyVector(props: {
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly ingressRoutes: readonly GatewayIngressRouteIdentity[];
	readonly role: 'framework-service' | 'tool-portal-service' | undefined;
}): GatewayReadinessVector {
	const { cohort } = props;
	return {
		authorityBearingControl: ready(cohort.controlIdentity),
		fatalEvidence:
			props.role === undefined
				? { kind: 'none' }
				: {
						kind: 'observed',
						observedGatewayEpoch: cohort.fence.gatewayEpoch,
						role: props.role,
					},
		frameworkIdentity: ready(cohort.frameworkIdentity),
		frameworkNativeReadiness: ready(cohort.frameworkIdentity),
		ingressRoutes: props.ingressRoutes,
		providerRevision: ready(cohort.providerRevision),
		requiredBackends: ready(cohort.requiredBackendRevision),
		semanticRevision: ready(cohort.semanticRevision),
		toolPortalIdentity: ready(cohort.toolPortalIdentity),
		toolPortalReadiness: ready(cohort.toolPortalIdentity),
		udsAttachment: ready({ ...cohort.frameworkIdentity, ...cohort.udsIdentity }),
		udsPublication: ready(cohort.udsIdentity),
		vmLiveness: ready(cohort.fence),
	};
}

function freezeRoutes(
	routes: readonly GatewayIngressRouteIdentity[],
): readonly GatewayIngressRouteIdentity[] {
	return Object.freeze(routes.map((route) => Object.freeze({ ...route })));
}

function createCandidateHarness(props: {
	readonly fixture: ManagedGatewayImageBootFixture;
	readonly identitySuffix: string;
}): ManagedGatewayCandidateHarness {
	const cohort = createExpectedCohort({
		identitySuffix: props.identitySuffix,
		vmId: props.fixture.vm.id,
	});
	const routeHistory: (readonly GatewayIngressRouteIdentity[])[] = [];
	let closed = false;
	let hostProcessId: number | undefined;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await props.fixture.close();
		if (hostProcessId !== undefined) await waitForHostProcessAbsence(hostProcessId);
	};
	return {
		candidate: {
			containGatewayVm: close,
			expectedCohort: cohort,
			replaceIngressRoutes: async (routes): Promise<void> => {
				const frozenRoutes = freezeRoutes(routes);
				props.fixture.vm.configureIngressRoutes(
					frozenRoutes.map((route) => ({
						port: route.guestPort,
						prefix: route.prefix,
						stripPrefix: route.stripPrefix,
					})),
				);
				routeHistory.push(frozenRoutes);
			},
			startGatewayVm: async (): Promise<void> => {
				await props.fixture.vm.start();
				const observedHostProcessId = props.fixture.vm.getHostProcessId();
				if (
					observedHostProcessId === null ||
					!Number.isSafeInteger(observedHostProcessId) ||
					observedHostProcessId <= 0
				) {
					throw new Error('Managed Gateway VM start omitted its host process identity.');
				}
				hostProcessId = observedHostProcessId;
			},
		},
		close,
		cohort,
		fixture: props.fixture,
		getHostProcessId: (): number => {
			if (hostProcessId === undefined) {
				throw new Error('Managed Gateway VM has no observed host process identity.');
			}
			return hostProcessId;
		},
		routeHistory,
	};
}

async function admitCandidate(props: {
	readonly candidate: ManagedGatewayCandidateHarness;
	readonly controller: ReturnType<typeof createGatewayAtomicAdmissionController>;
}): Promise<void> {
	await waitForGatewayRoles({
		expectedGatewayEpoch: props.candidate.cohort.fence.gatewayEpoch,
		expectedProcessEpoch: props.candidate.cohort.toolPortalIdentity.processEpoch,
		vm: props.candidate.fixture.vm,
	});
	await props.controller.observe(
		createReadyVector({
			cohort: props.candidate.cohort,
			ingressRoutes: [props.candidate.cohort.ingressIntent.controlRoute],
			role: undefined,
		}),
	);
	await props.controller.observe(
		createReadyVector({
			cohort: props.candidate.cohort,
			ingressRoutes: [
				props.candidate.cohort.ingressIntent.controlRoute,
				props.candidate.cohort.ingressIntent.frameworkRootRoute,
			],
			role: undefined,
		}),
	);
}

describeLiveVmIntegration('Managed Gateway atomic admission and replacement', () => {
	it('quiesces real G1 before creating and admitting a fresh real G2', async () => {
		const initialFixture = await createManagedGatewayImageBootFixture({
			identitySuffix: 'c05b-g1',
			sessionLabel: 'managed-gateway-atomic-admission-g1',
		});
		const initial = createCandidateHarness({
			fixture: initialFixture,
			identitySuffix: 'c05b-g1',
		});
		let successor: ManagedGatewayCandidateHarness | undefined;
		const controller = createGatewayAtomicAdmissionController({
			createSuccessorCandidate: async ({ predecessorQuiescence }) => {
				expect(predecessorQuiescence.predecessor).toBe(initial.cohort);
				expect(isProcessAlive(initial.getHostProcessId())).toBe(false);
				const successorFixture = await createManagedGatewayImageBootFixture({
					identitySuffix: 'c05b-g2',
					sessionLabel: 'managed-gateway-atomic-admission-g2',
				});
				successor = createCandidateHarness({
					fixture: successorFixture,
					identitySuffix: 'c05b-g2',
				});
				return successor.candidate;
			},
		});

		try {
			await controller.start(initial.candidate);
			const initialHostProcessId = initial.getHostProcessId();
			await admitCandidate({ candidate: initial, controller });
			expect(controller.getSnapshot()).toMatchObject({
				cohort: { fence: { vmId: initial.cohort.fence.vmId } },
				kind: 'admitted',
			});

			const replacement = await controller.observe(
				createReadyVector({
					cohort: initial.cohort,
					ingressRoutes: [
						initial.cohort.ingressIntent.controlRoute,
						initial.cohort.ingressIntent.frameworkRootRoute,
					],
					role: 'tool-portal-service',
				}),
			);
			if (successor === undefined) {
				throw new Error('Atomic replacement did not create the successor candidate.');
			}
			const createdSuccessor: ManagedGatewayCandidateHarness = successor;
			expect(replacement).toEqual({
				kind: 'replaced',
				predecessorQuiescence: {
					kind: 'predecessor-quiescence-proven',
					predecessor: initial.cohort,
				},
				successor: createdSuccessor.cohort,
				trigger: 'aggregate-containment',
			});
			expect(isProcessAlive(initialHostProcessId)).toBe(false);
			expect(createdSuccessor.cohort.fence.vmId).not.toBe(initial.cohort.fence.vmId);
			expect(createdSuccessor.getHostProcessId()).not.toBe(initialHostProcessId);
			expect(initial.routeHistory.map((routes) => routes.map((route) => route.kind))).toEqual([
				['tool-portal-control'],
				['tool-portal-control', 'framework-root'],
				[],
			]);
			expect(
				createdSuccessor.routeHistory.map((routes) => routes.map((route) => route.kind)),
			).toEqual([['tool-portal-control']]);

			await admitCandidate({ candidate: createdSuccessor, controller });
			expect(controller.getSnapshot()).toMatchObject({
				cohort: {
					fence: {
						gatewayEpoch: 'gateway-epoch-c05b-g2',
						vmId: createdSuccessor.cohort.fence.vmId,
					},
				},
				kind: 'admitted',
			});
			expect(
				createdSuccessor.routeHistory.map((routes) => routes.map((route) => route.kind)),
			).toEqual([['tool-portal-control'], ['tool-portal-control', 'framework-root']]);
		} finally {
			await successor?.close();
			await initial.close();
		}
	}, 900_000);
});
