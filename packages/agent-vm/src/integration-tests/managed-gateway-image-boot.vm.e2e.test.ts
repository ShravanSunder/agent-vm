import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';
import {
	wrapWithOpenClawGatewayTokenShellEnvironment,
	wrapWithOpenClawShellEnvironment,
} from '@agent-vm/openclaw-gateway';
import { describe, expect, it } from 'vitest';

import { readPreparedManagedVmImage } from '../build/prepared-gondolin-image-cache.js';
import { createManagedVmRuntimeComposition } from '../composition/gondolin-managed-vm-provider.js';
import { isProcessAlive } from '../shared/managed-vm-process.js';
import {
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldWorkerE2eProject,
} from './e2e-harness.js';
import { waitForProtocolRetryInterval } from './e2e-protocol-wait.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import {
	managedGatewayBootEnvironmentGuestRoot,
	managedGatewayBootInputGuestRoot,
	managedGatewayBootSecretCanary,
	startManagedGatewayImageBootFixture,
} from './managed-gateway-image-boot-test-fixture.js';

const describeLiveVmIntegration = shouldRunLiveVmE2e() ? describe : describe.skip;
const processObservationTimeoutMs = 90_000;
const processObservationRetryIntervalMs = 100;
const stableSiblingTerminationObservationCount = 10;
const toolPortalReadinessPath = '/run/agent-vm/gateway-runtime/tool-portal.readiness.json';

interface GuestProcessObservation {
	readonly argv: readonly string[];
	readonly command: string;
	readonly executablePath: string;
	readonly groupId: number;
	readonly name: string;
	readonly parentProcessId: number;
	readonly processId: number;
	readonly startIdentity: string;
	readonly userId: number;
}

interface ManagedGatewayBootObservation {
	readonly fatalEvidence: Readonly<Record<string, unknown>> | null;
	readonly observerStartIdentity: string;
	readonly processes: readonly GuestProcessObservation[];
	readonly readinessEvidence: Readonly<Record<string, unknown>> | null;
}

type ManagedGatewaySiblingRole = 'openclaw' | 'tool-portal';

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalRoleEvidence(
	value: unknown,
	evidenceName: string,
): Readonly<Record<string, unknown>> | null {
	if (value === undefined || value === null) return null;
	if (!isObjectRecord(value)) {
		throw new Error(`Managed Gateway boot returned malformed ${evidenceName} evidence.`);
	}
	return value;
}

function parseGuestProcessObservation(value: unknown): GuestProcessObservation {
	if (
		!isObjectRecord(value) ||
		!Array.isArray(value.argv) ||
		!value.argv.every((argument) => typeof argument === 'string') ||
		typeof value.command !== 'string' ||
		typeof value.executablePath !== 'string' ||
		typeof value.groupId !== 'number' ||
		typeof value.name !== 'string' ||
		typeof value.parentProcessId !== 'number' ||
		typeof value.processId !== 'number' ||
		typeof value.startIdentity !== 'string' ||
		typeof value.userId !== 'number'
	) {
		throw new Error(
			`Managed Gateway boot returned malformed process evidence: ${JSON.stringify(value)}`,
		);
	}
	return {
		argv: value.argv,
		command: value.command,
		executablePath: value.executablePath,
		groupId: value.groupId,
		name: value.name,
		parentProcessId: value.parentProcessId,
		processId: value.processId,
		startIdentity: value.startIdentity,
		userId: value.userId,
	};
}

function parseManagedGatewayBootObservation(stdout: string): ManagedGatewayBootObservation {
	const parsed: unknown = JSON.parse(stdout);
	if (
		!isObjectRecord(parsed) ||
		!Array.isArray(parsed.processes) ||
		typeof parsed.observerStartIdentity !== 'string' ||
		!/^[0-9]+$/u.test(parsed.observerStartIdentity)
	) {
		throw new Error(`Managed Gateway boot returned malformed evidence: ${stdout}`);
	}
	return {
		fatalEvidence: parseOptionalRoleEvidence(parsed.fatalEvidence, 'fatal'),
		observerStartIdentity: parsed.observerStartIdentity,
		processes: parsed.processes.map(parseGuestProcessObservation),
		readinessEvidence: parseOptionalRoleEvidence(parsed.readinessEvidence, 'readiness'),
	};
}

function renderGuestProcessObservationScript(): string {
	return String.raw`
import { readFile, readdir, readlink } from 'node:fs/promises';

async function readTextIfPresent(filePath) {
	try {
		return await readFile(filePath, 'utf8');
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
		throw error;
	}
}

function parseStatus(statusText) {
	const fields = Object.fromEntries(
		statusText
			.split('\n')
			.filter((line) => line.includes(':'))
			.map((line) => {
				const separator = line.indexOf(':');
				return [line.slice(0, separator), line.slice(separator + 1).trim()];
			}),
	);
	return {
		groupId: Number.parseInt((fields.Gid ?? '-1').split(/\s+/u)[0] ?? '-1', 10),
		name: fields.Name ?? '',
		parentProcessId: Number.parseInt(fields.PPid ?? '-1', 10),
		userId: Number.parseInt((fields.Uid ?? '-1').split(/\s+/u)[0] ?? '-1', 10),
	};
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

const observerStartIdentity = parseStartIdentity(await readFile('/proc/self/stat', 'utf8'));
const processIds = (await readdir('/proc'))
	.filter((entry) => /^\d+$/u.test(entry))
	.map((entry) => Number.parseInt(entry, 10))
	.filter((processId) => processId !== process.pid)
	.toSorted((left, right) => left - right);
const processes = [];
for (const processId of processIds) {
	try {
		const [commandLine, executablePath, processStat, statusText] = await Promise.all([
			readFile('/proc/' + String(processId) + '/cmdline', 'utf8'),
			readlink('/proc/' + String(processId) + '/exe'),
			readFile('/proc/' + String(processId) + '/stat', 'utf8'),
			readFile('/proc/' + String(processId) + '/status', 'utf8'),
		]);
		const status = parseStatus(statusText);
		const argv = commandLine.split('\0').filter((argument) => argument.length > 0);
		processes.push({
			argv,
			command: argv.join(' '),
			executablePath,
			groupId: status.groupId,
			name: status.name,
			parentProcessId: status.parentProcessId,
			processId,
			startIdentity: parseStartIdentity(processStat),
			userId: status.userId,
		});
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
		throw error;
	}
}

const readinessText = await readTextIfPresent(${JSON.stringify(toolPortalReadinessPath)});
const fatalText = await readTextIfPresent('/run/agent-vm/gateway-runtime/tool-portal.fatal.json');
process.stdout.write(JSON.stringify({
	fatalEvidence: fatalText === null ? null : JSON.parse(fatalText),
	observerStartIdentity,
	processes,
	readinessEvidence: readinessText === null ? null : JSON.parse(readinessText),
}));
`;
}

async function observeManagedGatewayBoot(vm: ManagedVm): Promise<ManagedGatewayBootObservation> {
	const observation = await vm.exec(
		['/bin/sh', '-c', 'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module'],
		{ stdin: renderGuestProcessObservationScript() },
	);
	if (!observation.ok) {
		throw new Error(
			`Managed Gateway process observation failed: exit=${String(observation.exitCode)} stderr=${observation.stderr}`,
		);
	}
	return parseManagedGatewayBootObservation(observation.stdout);
}

function matchingRoleProcesses(
	observation: ManagedGatewayBootObservation,
	role: ManagedGatewaySiblingRole,
): readonly GuestProcessObservation[] {
	return observation.processes.filter((process) => {
		if (role === 'tool-portal') {
			return (
				process.command.includes('agent-vm-gateway-runtime') &&
				process.command.includes(`${managedGatewayBootInputGuestRoot}/tool-portal-service.json`)
			);
		}
		return (
			process.name === 'openclaw' &&
			process.executablePath.endsWith('/node') &&
			process.argv.length === 1 &&
			process.argv[0] === 'openclaw'
		);
	});
}

function requireSingleRoleProcess(
	observation: ManagedGatewayBootObservation,
	role: ManagedGatewaySiblingRole,
): GuestProcessObservation {
	const roleProcesses = matchingRoleProcesses(observation, role);
	if (roleProcesses.length !== 1 || roleProcesses[0] === undefined) {
		throw new Error(
			`Expected exactly one '${role}' process, observed ${JSON.stringify(roleProcesses)}.`,
		);
	}
	return roleProcesses[0];
}

function otherManagedGatewaySiblingRole(
	role: ManagedGatewaySiblingRole,
): ManagedGatewaySiblingRole {
	return role === 'tool-portal' ? 'openclaw' : 'tool-portal';
}

function requirePositiveHostProcessId(vm: ManagedVm): number {
	const hostProcessId = vm.getHostProcessId();
	if (hostProcessId === null || !Number.isSafeInteger(hostProcessId) || hostProcessId <= 0) {
		throw new Error(`Managed Gateway VM '${vm.id}' did not expose a live host process ID.`);
	}
	return hostProcessId;
}

interface GuestProcessIdentityObservation {
	readonly processState: string;
	readonly startIdentity: string;
}

function parseGuestProcessIdentityResult(stdout: string): GuestProcessIdentityObservation | null {
	const parsed: unknown = JSON.parse(stdout);
	if (!isObjectRecord(parsed) || (parsed.kind !== 'absent' && parsed.kind !== 'present')) {
		throw new Error(`Managed Gateway returned malformed process identity evidence: ${stdout}`);
	}
	if (parsed.kind === 'absent') return null;
	if (
		typeof parsed.processState !== 'string' ||
		parsed.processState.length !== 1 ||
		typeof parsed.startIdentity !== 'string' ||
		!/^\d+$/u.test(parsed.startIdentity)
	) {
		throw new Error(`Managed Gateway returned malformed process start identity: ${stdout}`);
	}
	return {
		processState: parsed.processState,
		startIdentity: parsed.startIdentity,
	};
}

function renderGuestProcessStartIdentityScript(processId: number): string {
	return String.raw`
import { readFile } from 'node:fs/promises';

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

function parseProcessState(statText) {
	const commandEnd = statText.lastIndexOf(')');
	if (commandEnd < 0) throw new Error('Malformed /proc stat process identity.');
	const processState = statText.slice(commandEnd + 1).trim().split(/\s+/u)[0];
	if (typeof processState !== 'string' || processState.length !== 1) {
		throw new Error('Missing /proc process state.');
	}
	return processState;
}

try {
	const processStat = await readFile('/proc/' + ${JSON.stringify(processId)} + '/stat', 'utf8');
	process.stdout.write(JSON.stringify({
		kind: 'present',
		processState: parseProcessState(processStat),
		startIdentity: parseStartIdentity(processStat),
	}));
} catch (error) {
	if (error && typeof error === 'object' && error.code === 'ENOENT') {
		process.stdout.write(JSON.stringify({ kind: 'absent' }));
	} else {
		throw error;
	}
}
`;
}

async function readGuestProcessIdentity(
	vm: ManagedVm,
	processId: number,
): Promise<GuestProcessIdentityObservation | null> {
	const observation = await vm.exec(
		['/bin/sh', '-c', 'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module'],
		{ stdin: renderGuestProcessStartIdentityScript(processId) },
	);
	if (!observation.ok) {
		throw new Error(
			`Managed Gateway process identity observation failed: exit=${String(observation.exitCode)} stderr=${observation.stderr}`,
		);
	}
	return parseGuestProcessIdentityResult(observation.stdout);
}

function renderExactSiblingTerminationScript(process: GuestProcessObservation): string {
	return String.raw`
import { readFile } from 'node:fs/promises';

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

const processId = ${JSON.stringify(process.processId)};
const expectedStartIdentity = ${JSON.stringify(process.startIdentity)};
const processStat = await readFile('/proc/' + String(processId) + '/stat', 'utf8');
const observedStartIdentity = parseStartIdentity(processStat);
if (observedStartIdentity !== expectedStartIdentity) {
	throw new Error('Refusing to signal a process whose start identity changed.');
}
process.kill(processId, 'SIGKILL');
process.stdout.write(JSON.stringify({ processId, startIdentity: observedStartIdentity }));
`;
}

async function terminateExactManagedGatewaySibling(
	vm: ManagedVm,
	process: GuestProcessObservation,
): Promise<void> {
	const termination = await vm.exec(
		['/bin/sh', '-c', 'exec env PATH=/pnpm:/usr/local/bin:/usr/bin:/bin node --input-type=module'],
		{ stdin: renderExactSiblingTerminationScript(process) },
	);
	if (!termination.ok) {
		throw new Error(
			`Managed Gateway exact sibling termination failed: exit=${String(termination.exitCode)} stderr=${termination.stderr}`,
		);
	}
	const receipt: unknown = JSON.parse(termination.stdout);
	if (
		!isObjectRecord(receipt) ||
		receipt.processId !== process.processId ||
		receipt.startIdentity !== process.startIdentity
	) {
		throw new Error(
			`Managed Gateway returned malformed termination evidence: ${termination.stdout}`,
		);
	}
}

async function waitForTerminatedManagedGatewaySibling(props: {
	readonly terminatedProcess: GuestProcessObservation;
	readonly terminatedRole: ManagedGatewaySiblingRole;
	readonly vm: ManagedVm;
	readonly survivorProcess: GuestProcessObservation;
	readonly survivorRole: ManagedGatewaySiblingRole;
}): Promise<ManagedGatewayBootObservation> {
	const startedAtMs = performance.now();
	let stableObservationCount = 0;
	let lastObservation: ManagedGatewayBootObservation | undefined;
	while (performance.now() - startedAtMs <= processObservationTimeoutMs) {
		// oxlint-disable-next-line no-await-in-loop -- the observer must sample sequential guest /proc state.
		lastObservation = await observeManagedGatewayBoot(props.vm);
		const survivorProcesses = matchingRoleProcesses(lastObservation, props.survivorRole);
		if (
			survivorProcesses.length !== 1 ||
			survivorProcesses[0]?.processId !== props.survivorProcess.processId ||
			survivorProcesses[0]?.startIdentity !== props.survivorProcess.startIdentity
		) {
			throw new Error(
				`Managed Gateway survivor '${props.survivorRole}' changed after sibling termination: ${JSON.stringify(survivorProcesses)}.`,
			);
		}
		if (residentBootLaunchers(lastObservation).length !== 0) {
			throw new Error('Managed Gateway created a resident launcher after sibling termination.');
		}
		const terminatedRoleProcesses = matchingRoleProcesses(lastObservation, props.terminatedRole);
		if (
			terminatedRoleProcesses.some(
				(process) =>
					process.processId !== props.terminatedProcess.processId ||
					process.startIdentity !== props.terminatedProcess.startIdentity,
			)
		) {
			throw new Error(
				`Managed Gateway restarted '${props.terminatedRole}' inside the same VM: ${JSON.stringify(terminatedRoleProcesses)}.`,
			);
		}
		// oxlint-disable-next-line no-await-in-loop -- exact /proc identity distinguishes exit from a transient role matcher miss.
		const observedTerminatedIdentity = await readGuestProcessIdentity(
			props.vm,
			props.terminatedProcess.processId,
		);
		if (
			observedTerminatedIdentity !== null &&
			observedTerminatedIdentity.startIdentity !== props.terminatedProcess.startIdentity
		) {
			throw new Error(
				`Managed Gateway victim PID '${String(props.terminatedProcess.processId)}' was reused during termination proof.`,
			);
		}
		const terminatedIdentityIsAbsentOrTerminal =
			observedTerminatedIdentity === null ||
			observedTerminatedIdentity.processState === 'X' ||
			observedTerminatedIdentity.processState === 'Z';
		if (terminatedIdentityIsAbsentOrTerminal && terminatedRoleProcesses.length === 0) {
			stableObservationCount += 1;
			if (stableObservationCount >= stableSiblingTerminationObservationCount) {
				return lastObservation;
			}
		} else {
			stableObservationCount = 0;
		}
		// oxlint-disable-next-line no-await-in-loop -- /proc exposes no process-exit event through ManagedVm.
		await waitForProtocolRetryInterval(processObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway sibling termination did not stabilize: ${JSON.stringify(lastObservation)}.`,
	);
}

async function waitForHostProcessAbsence(hostProcessId: number): Promise<void> {
	const startedAtMs = performance.now();
	while (performance.now() - startedAtMs <= processObservationTimeoutMs) {
		if (!isProcessAlive(hostProcessId)) return;
		// oxlint-disable-next-line no-await-in-loop -- the host exposes no portable QEMU process-exit event.
		await waitForProtocolRetryInterval(processObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway host process '${String(hostProcessId)}' remained live after close.`,
	);
}

async function waitForStableManagedGatewayPartialStart(
	vm: ManagedVm,
	readyRole: ManagedGatewaySiblingRole,
): Promise<ManagedGatewayBootObservation> {
	const missingRole: ManagedGatewaySiblingRole =
		readyRole === 'openclaw' ? 'tool-portal' : 'openclaw';
	const startedAtMs = performance.now();
	let stableStartIdentity: string | undefined;
	let stableObservationCount = 0;
	let lastObservation: ManagedGatewayBootObservation | undefined;
	while (performance.now() - startedAtMs <= processObservationTimeoutMs) {
		// oxlint-disable-next-line no-await-in-loop -- the observer must sample sequential guest /proc state.
		lastObservation = await observeManagedGatewayBoot(vm);
		const readyRoleProcesses = matchingRoleProcesses(lastObservation, readyRole);
		const missingRoleProcesses = matchingRoleProcesses(lastObservation, missingRole);
		const readinessMatchesRole =
			readyRole === 'openclaw' ? true : hasToolPortalReadiness(lastObservation);
		if (
			readyRoleProcesses.length === 1 &&
			missingRoleProcesses.length === 0 &&
			readinessMatchesRole &&
			residentBootLaunchers(lastObservation).length === 0
		) {
			const currentStartIdentity = readyRoleProcesses[0]?.startIdentity;
			if (currentStartIdentity === stableStartIdentity) {
				stableObservationCount += 1;
			} else {
				stableStartIdentity = currentStartIdentity;
				stableObservationCount = 1;
			}
			if (stableObservationCount >= 10) return lastObservation;
		} else {
			stableStartIdentity = undefined;
			stableObservationCount = 0;
		}
		if (lastObservation.fatalEvidence !== null) {
			throw new Error(
				`Tool Portal published fatal partial-start evidence: ${JSON.stringify(lastObservation.fatalEvidence)}`,
			);
		}
		// oxlint-disable-next-line no-await-in-loop -- /proc exposes no process-start event through ManagedVm.
		await waitForProtocolRetryInterval(processObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway partial start did not stabilize: ${JSON.stringify(lastObservation)}`,
	);
}

async function waitForStableManagedGatewayNoSiblingStart(
	vm: ManagedVm,
): Promise<ManagedGatewayBootObservation> {
	const startedAtMs = performance.now();
	let stableObservationCount = 0;
	let lastObservation: ManagedGatewayBootObservation | undefined;
	while (performance.now() - startedAtMs <= processObservationTimeoutMs) {
		// oxlint-disable-next-line no-await-in-loop -- the observer must sample sequential guest /proc state.
		lastObservation = await observeManagedGatewayBoot(vm);
		// oxlint-disable-next-line no-await-in-loop -- non-empty service logs are the bounded unlink-failure event.
		const unlinkFailureEvidence = await vm.exec([
			'/bin/sh',
			'-c',
			'test -s /var/log/agent-vm/tool-portal-service.log && test -s /var/log/agent-vm/openclaw-service.log',
		]);
		if (
			unlinkFailureEvidence.ok &&
			matchingRoleProcesses(lastObservation, 'tool-portal').length === 0 &&
			matchingRoleProcesses(lastObservation, 'openclaw').length === 0 &&
			residentBootLaunchers(lastObservation).length === 0
		) {
			stableObservationCount += 1;
			if (stableObservationCount >= stableSiblingTerminationObservationCount) {
				return lastObservation;
			}
		} else {
			stableObservationCount = 0;
		}
		// oxlint-disable-next-line no-await-in-loop -- /proc exposes no managed sibling-start completion event.
		await waitForProtocolRetryInterval(processObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway siblings did not remain absent after failed boot: ${JSON.stringify(lastObservation)}.`,
	);
}

function residentBootLaunchers(
	observation: ManagedGatewayBootObservation,
): readonly GuestProcessObservation[] {
	return observation.processes.filter(
		(process) =>
			process.command.includes('tool-portal.environment.sh') ||
			process.command.includes('framework.environment.sh') ||
			process.command.includes('agent-vm-rootfs-init-extra.sh'),
	);
}

function hasToolPortalReadiness(observation: ManagedGatewayBootObservation): boolean {
	if (!isObjectRecord(observation.readinessEvidence)) return false;
	const serviceIdentity = observation.readinessEvidence.serviceIdentity;
	return (
		isObjectRecord(serviceIdentity) &&
		serviceIdentity.role === 'tool-portal' &&
		matchingRoleProcesses(observation, 'tool-portal').length === 1
	);
}

async function waitForManagedGatewaySiblingProcesses(
	vm: ManagedVm,
): Promise<ManagedGatewayBootObservation> {
	const startedAtMs = performance.now();
	let lastObservation: ManagedGatewayBootObservation | undefined;
	while (performance.now() - startedAtMs <= processObservationTimeoutMs) {
		// oxlint-disable-next-line no-await-in-loop -- the observer must sample sequential guest /proc state.
		lastObservation = await observeManagedGatewayBoot(vm);
		if (
			hasToolPortalReadiness(lastObservation) &&
			matchingRoleProcesses(lastObservation, 'openclaw').length === 1
		) {
			return lastObservation;
		}
		if (lastObservation.fatalEvidence !== null) {
			throw new Error(
				`Tool Portal published fatal boot evidence: ${JSON.stringify(lastObservation.fatalEvidence)}`,
			);
		}
		// oxlint-disable-next-line no-await-in-loop -- /proc exposes no process-start event through ManagedVm.
		await waitForProtocolRetryInterval(processObservationRetryIntervalMs);
	}
	throw new Error(
		`Managed Gateway sibling processes did not become observable: ${JSON.stringify(lastObservation)}`,
	);
}

describeLiveVmIntegration('Managed Gateway image-owned sibling boot', () => {
	it('boots one Tool Portal root and one real OpenClaw root without controller launch authority', async () => {
		const fixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'managed-gateway-image-owned-sibling-boot',
		});

		try {
			const preparedImage = fixture.preparedImage;
			expect(preparedImage.fingerprint).toMatch(/^[a-f0-9]{16}$/u);
			expect(preparedImage.managedGatewayBoot).toEqual({
				frameworkBootEntry: 'openclaw-framework-service',
				kind: 'managed-gateway-exact-two-role',
			});
			const initScript = await readFile(
				path.join(preparedImage.imagePath, 'agent-vm-rootfs-init-extra.sh'),
				'utf8',
			);
			const initScriptSha256 = createHash('sha256').update(initScript).digest('hex');
			expect({ fingerprint: preparedImage.fingerprint, initScriptSha256 }).toMatchObject({
				fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/u),
				initScriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
			});
			expect(initScript).toContain('/usr/local/bin/agent-vm-gateway-runtime');
			expect(initScript).toContain('/usr/local/bin/openclaw gateway --port 18789');
			expect(initScript).toContain(
				'managed_gateway_environment_input_root=/run/agent-vm/managed-gateway-environment',
			);
			expect(initScript).toContain(
				'managed_gateway_structured_input_root=/run/agent-vm/managed-gateway',
			);
			expect(initScript).not.toContain('managed-gateway-inputs');
			expect(initScript).toContain('tool-portal.environment.sh');
			expect(initScript).toContain('framework.environment.sh');
			expect(initScript.includes(managedGatewayBootSecretCanary)).toBe(false);

			const observation = await waitForManagedGatewaySiblingProcesses(fixture.vm);
			const toolPortalProcesses = matchingRoleProcesses(observation, 'tool-portal');
			const openClawProcesses = matchingRoleProcesses(observation, 'openclaw');

			expect(toolPortalProcesses).toHaveLength(1);
			expect(openClawProcesses).toHaveLength(1);
			expect(toolPortalProcesses[0]?.parentProcessId).toBe(1);
			expect(openClawProcesses[0]?.parentProcessId).toBe(1);
			expect(toolPortalProcesses[0]?.processId).not.toBe(openClawProcesses[0]?.processId);
			expect(toolPortalProcesses[0]).toMatchObject({ groupId: 0, userId: 0 });
			expect(openClawProcesses[0]).toMatchObject({ groupId: 0, userId: 0 });
			expect(toolPortalProcesses[0]?.executablePath).toMatch(/\/node$/u);
			expect(openClawProcesses[0]?.executablePath).toMatch(/\/node$/u);
			expect(toolPortalProcesses[0]?.startIdentity).toMatch(/^\d+$/u);
			expect(openClawProcesses[0]?.startIdentity).toMatch(/^\d+$/u);
			expect(BigInt(toolPortalProcesses[0]?.startIdentity ?? '0')).toBeLessThan(
				BigInt(observation.observerStartIdentity),
			);
			expect(BigInt(openClawProcesses[0]?.startIdentity ?? '0')).toBeLessThan(
				BigInt(observation.observerStartIdentity),
			);
			expect(
				[...toolPortalProcesses, ...openClawProcesses].some((process) =>
					process.argv.some(
						(argument) =>
							argument.includes('\0') || argument.includes(managedGatewayBootSecretCanary),
					),
				),
			).toBe(false);
			expect(residentBootLaunchers(observation)).toEqual([]);
			expect(observation.fatalEvidence).toBeNull();
			expect(observation.readinessEvidence).toMatchObject({
				kind: 'tool-portal-role-readiness',
				serviceIdentity: {
					processEpoch: 'process-epoch-image-owned',
					role: 'tool-portal',
					serviceId: 'tool-portal-image-owned',
				},
				uds: {
					attachment: { status: 'awaiting-attachment' },
					publication: { status: 'published' },
				},
			});
			const bootInputMountObservation = await fixture.vm.exec([
				'/bin/sh',
				'-c',
				[
					`test ! -e ${managedGatewayBootEnvironmentGuestRoot}/tool-portal.environment.sh`,
					`test ! -e ${managedGatewayBootEnvironmentGuestRoot}/framework.environment.sh`,
					`test -f ${managedGatewayBootEnvironmentGuestRoot}/openclaw-gateway-token.environment.sh`,
					`test -f ${managedGatewayBootEnvironmentGuestRoot}/openclaw-all-secrets.environment.sh`,
					`test -f ${managedGatewayBootInputGuestRoot}/tool-portal-service.json`,
					`test -f ${managedGatewayBootInputGuestRoot}/framework-service.json`,
					`test ! -e /run/agent-vm/gateway-runtime/tool-portal-service.json`,
					`test ! -e /run/agent-vm/gateway-runtime/framework-service.json`,
				].join(' && '),
			]);
			expect(bootInputMountObservation).toMatchObject({
				exitCode: 0,
				ok: true,
			});

			const authShellResult = await fixture.vm.exec([
				'/bin/sh',
				'-c',
				wrapWithOpenClawShellEnvironment(
					'test "$OPENCLAW_CONFIG_PATH" = "/home/openclaw/.openclaw/state/effective-openclaw.json" && command -v openclaw >/dev/null',
				),
			]);
			expect(authShellResult).toMatchObject({
				exitCode: 0,
				ok: true,
			});

			const tokenAuthShellResult = await fixture.vm.exec([
				'/bin/sh',
				'-c',
				wrapWithOpenClawGatewayTokenShellEnvironment(
					`test "$OPENCLAW_GATEWAY_TOKEN" = "${managedGatewayBootSecretCanary}" && test "$OPENCLAW_CONFIG_PATH" = "/home/openclaw/.openclaw/state/effective-openclaw.json"`,
				),
			]);
			expect(tokenAuthShellResult).toMatchObject({
				exitCode: 0,
				ok: true,
			});
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it('keeps OpenClaw running when the Tool Portal boot input is missing', async () => {
		const fixture = await startManagedGatewayImageBootFixture({
			omittedInputFileName: 'tool-portal-service.json',
			sessionLabel: 'managed-gateway-image-owned-missing-tool-portal-input',
		});
		try {
			const observation = await waitForStableManagedGatewayPartialStart(fixture.vm, 'openclaw');
			const openClawProcesses = matchingRoleProcesses(observation, 'openclaw');
			expect(openClawProcesses).toHaveLength(1);
			expect(openClawProcesses[0]).toMatchObject({
				argv: ['openclaw'],
				groupId: 0,
				parentProcessId: 1,
				userId: 0,
			});
			expect(matchingRoleProcesses(observation, 'tool-portal')).toEqual([]);
			expect(residentBootLaunchers(observation)).toEqual([]);
			expect(observation.readinessEvidence).toBeNull();
			expect(observation.fatalEvidence).toBeNull();
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it('keeps Tool Portal ready when the OpenClaw boot input is missing', async () => {
		const fixture = await startManagedGatewayImageBootFixture({
			omittedInputFileName: 'framework-service.json',
			sessionLabel: 'managed-gateway-image-owned-missing-framework-input',
		});
		try {
			const observation = await waitForStableManagedGatewayPartialStart(fixture.vm, 'tool-portal');
			const toolPortalProcesses = matchingRoleProcesses(observation, 'tool-portal');
			expect(toolPortalProcesses).toHaveLength(1);
			expect(toolPortalProcesses[0]).toMatchObject({
				groupId: 0,
				parentProcessId: 1,
				userId: 0,
			});
			expect(matchingRoleProcesses(observation, 'openclaw')).toEqual([]);
			expect(residentBootLaunchers(observation)).toEqual([]);
			expect(observation.readinessEvidence).toMatchObject({
				serviceIdentity: {
					role: 'tool-portal',
					serviceId: 'tool-portal-image-owned',
				},
			});
			expect(observation.fatalEvidence).toBeNull();
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it('starts neither sibling when environment-script unlink is denied', async () => {
		const fixture = await startManagedGatewayImageBootFixture({
			environmentMountAccess: 'read-only',
			sessionLabel: 'managed-gateway-image-owned-environment-unlink-denied',
		});
		try {
			const observation = await waitForStableManagedGatewayNoSiblingStart(fixture.vm);
			expect(matchingRoleProcesses(observation, 'tool-portal')).toEqual([]);
			expect(matchingRoleProcesses(observation, 'openclaw')).toEqual([]);
			expect(residentBootLaunchers(observation)).toEqual([]);
			expect(observation.readinessEvidence).toBeNull();
			expect(observation.fatalEvidence).toBeNull();
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it.each(['tool-portal', 'openclaw'] as const)(
		'terminates the exact %s sibling without restarting it or disturbing its peer',
		async (terminatedRole) => {
			const fixture = await startManagedGatewayImageBootFixture({
				sessionLabel: `managed-gateway-image-owned-${terminatedRole}-termination`,
			});
			let fixtureClosed = false;

			try {
				const hostProcessId = requirePositiveHostProcessId(fixture.vm);
				const initialObservation = await waitForManagedGatewaySiblingProcesses(fixture.vm);
				const terminatedProcess = requireSingleRoleProcess(initialObservation, terminatedRole);
				const survivorRole = otherManagedGatewaySiblingRole(terminatedRole);
				const survivorProcess = requireSingleRoleProcess(initialObservation, survivorRole);

				await terminateExactManagedGatewaySibling(fixture.vm, terminatedProcess);
				const terminalObservation = await waitForTerminatedManagedGatewaySibling({
					terminatedProcess,
					terminatedRole,
					vm: fixture.vm,
					survivorProcess,
					survivorRole,
				});

				expect(matchingRoleProcesses(terminalObservation, terminatedRole)).toEqual([]);
				expect(requireSingleRoleProcess(terminalObservation, survivorRole)).toMatchObject({
					processId: survivorProcess.processId,
					startIdentity: survivorProcess.startIdentity,
				});
				expect(residentBootLaunchers(terminalObservation)).toEqual([]);

				await fixture.close();
				fixtureClosed = true;
				await waitForHostProcessAbsence(hostProcessId);
			} finally {
				if (!fixtureClosed) await fixture.close();
			}
		},
		900_000,
	);

	it('keeps a stock Worker image free of managed Gateway sibling roles', async () => {
		const project = await scaffoldWorkerE2eProject({
			architecture: process.arch === 'arm64' ? 'aarch64' : 'x86_64',
			prefix: 'agent-vm-e2e-harness-worker-without-managed-gateway-boot-',
			zoneId: 'worker-without-managed-gateway-boot',
		});
		const profileName = project.zone.gateway.imageProfile;
		const workerProfile = project.systemConfig.imageProfiles.gateways[profileName];
		if (workerProfile === undefined) {
			throw new Error(`Worker image profile '${profileName}' is missing.`);
		}
		let vm: ManagedVm | undefined;

		try {
			await prepareGatewayE2eProjectImages({ project });
			const preparedImage = await readPreparedManagedVmImage({
				buildConfigPath: workerProfile.buildConfig,
				cacheDir: path.join(project.systemConfig.cacheDir, 'gateway-images', profileName),
			});
			if (preparedImage === undefined) {
				throw new Error(
					'Worker managed image preparation did not publish a prepared-image receipt.',
				);
			}
			expect(preparedImage.managedGatewayBoot).toBeUndefined();
			const initScript = await readFile(
				path.join(preparedImage.imagePath, 'agent-vm-rootfs-init-extra.sh'),
				'utf8',
			);
			expect(initScript).not.toContain('agent-vm-gateway-runtime');
			expect(initScript).not.toContain('openclaw gateway');
			expect(initScript).not.toContain('agent-vm-hermes-gateway');

			vm = await createManagedVmRuntimeComposition().managedVmFactory.createManagedVm({
				allowedHosts: [],
				environment: {},
				imageReference: preparedImage.imagePath,
				mediatedSecrets: [],
				mounts: {},
				resources: {
					cpuCount: project.zone.gateway.cpus,
					memory: project.zone.gateway.memory,
				},
				rootfsMode: 'cow',
				...(project.zone.gateway.runtimeRootfsSize === undefined
					? {}
					: { runtimeRootfsSize: project.zone.gateway.runtimeRootfsSize }),
				sessionLabel: 'worker-without-managed-gateway-boot',
				tcpHosts: [],
			});
			await vm.start();
			const observation = await observeManagedGatewayBoot(vm);
			expect(matchingRoleProcesses(observation, 'tool-portal')).toEqual([]);
			expect(matchingRoleProcesses(observation, 'openclaw')).toEqual([]);
			expect(residentBootLaunchers(observation)).toEqual([]);
			expect(observation.readinessEvidence).toBeNull();
			expect(observation.fatalEvidence).toBeNull();
		} finally {
			await vm?.close();
			await removeE2eTempRoot(project.tempRoot);
		}
	}, 900_000);
});
