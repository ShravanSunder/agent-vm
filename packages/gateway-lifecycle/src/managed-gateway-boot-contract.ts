export type ManagedFrameworkKind = 'hermes';

export type ManagedFrameworkBootEntry = 'hermes-gateway';

export interface ManagedGatewayLogIdentity {
	readonly guestPath: string;
	readonly serviceName: string;
}

export interface ManagedToolPortalReadinessMetadata {
	readonly evidencePath: string;
	readonly kind: 'tool-portal-evidence';
	readonly socketPath: string;
}

export interface ManagedFrameworkReadinessMetadata {
	readonly guestPort: number;
	readonly kind: 'framework-http';
	readonly path: string;
}

export interface ManagedFrameworkIngressMetadata {
	readonly guestPort: number;
	readonly kind: 'framework-http';
}

export interface ManagedToolPortalServiceBootMetadata {
	readonly bootEntry: 'agent-vm-gateway-runtime';
	readonly configurationInputPath: string;
	readonly environmentInputPath: string;
	readonly logIdentity: ManagedGatewayLogIdentity;
	readonly readiness: ManagedToolPortalReadinessMetadata;
	readonly role: 'tool-portal-service';
}

interface ManagedFrameworkServiceBootMetadataBase {
	readonly configurationInputPath: string;
	readonly environmentInputPath: string;
	readonly ingress: ManagedFrameworkIngressMetadata;
	readonly logIdentity: ManagedGatewayLogIdentity;
	readonly readiness: ManagedFrameworkReadinessMetadata;
	readonly role: 'framework-service';
}

export interface ManagedHermesServiceBootMetadata extends ManagedFrameworkServiceBootMetadataBase {
	readonly bootEntry: 'hermes-gateway';
	readonly framework: 'hermes';
}

export type ManagedFrameworkServiceBootMetadata = ManagedHermesServiceBootMetadata;

/**
 * Exact image-owned startup contract for a managed Gateway VM.
 *
 * This contract intentionally contains no executable, argv, shell command,
 * callback, process handle, or resolved environment value. The image build
 * maps each closed `bootEntry` discriminator to code-owned process startup.
 */
export interface ManagedGatewayBootContract {
	readonly contractVersion: 1;
	readonly frameworkService: ManagedFrameworkServiceBootMetadata;
	readonly kind: 'managed-gateway-exact-two-role';
	readonly toolPortalService: ManagedToolPortalServiceBootMetadata;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function assertPlainRecord(value: unknown, label: string): asserts value is UnknownRecord {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be a plain object.`);
	}
	const prototype = Reflect.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} must be a plain object.`);
	}
}

function assertExactFields(
	record: UnknownRecord,
	label: string,
	requiredFields: readonly string[],
): void {
	const requiredFieldSet = new Set(requiredFields);
	for (const fieldKey of Reflect.ownKeys(record)) {
		if (typeof fieldKey !== 'string') {
			throw new Error(`${label} has an unknown symbol field.`);
		}
		const fieldName = fieldKey;
		if (!requiredFieldSet.has(fieldName)) {
			throw new Error(`${label} has unknown field '${fieldName}'.`);
		}
		const descriptor = Reflect.getOwnPropertyDescriptor(record, fieldName);
		if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
			throw new Error(`${label}.${fieldName} must be a data field.`);
		}
	}
	for (const fieldName of requiredFields) {
		if (!Object.hasOwn(record, fieldName)) {
			throw new Error(`${label} is missing required field '${fieldName}'.`);
		}
	}
}

function parseLiteral<TLiteral extends string | number>(
	value: unknown,
	expected: TLiteral,
	label: string,
): TLiteral {
	if (value !== expected) {
		throw new Error(`${label} must be ${JSON.stringify(expected)}.`);
	}
	return expected;
}

function parseNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	return value;
}

function parseAbsoluteGuestPath(value: unknown, label: string): string {
	const guestPath = parseNonEmptyString(value, label);
	if (
		!guestPath.startsWith('/') ||
		guestPath.includes('\0') ||
		guestPath.includes('//') ||
		(guestPath.length > 1 && guestPath.endsWith('/')) ||
		guestPath.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error(`${label} must be a normalized absolute guest path.`);
	}
	return guestPath;
}

function parseHttpPath(value: unknown, label: string): string {
	const httpPath = parseNonEmptyString(value, label);
	if (!httpPath.startsWith('/') || httpPath.includes('\0')) {
		throw new Error(`${label} must be an absolute HTTP path.`);
	}
	return httpPath;
}

function parseGuestPort(value: unknown, label: string): number {
	if (!Number.isInteger(value) || typeof value !== 'number' || value < 1 || value > 65_535) {
		throw new Error(`${label} must be an integer TCP port from 1 through 65535.`);
	}
	return value;
}

function parseLogIdentity(value: unknown, label: string): ManagedGatewayLogIdentity {
	assertPlainRecord(value, label);
	assertExactFields(value, label, ['guestPath', 'serviceName']);
	return Object.freeze({
		guestPath: parseAbsoluteGuestPath(value.guestPath, `${label}.guestPath`),
		serviceName: parseNonEmptyString(value.serviceName, `${label}.serviceName`),
	});
}

function parseToolPortalReadiness(
	value: unknown,
	label: string,
): ManagedToolPortalReadinessMetadata {
	assertPlainRecord(value, label);
	assertExactFields(value, label, ['evidencePath', 'kind', 'socketPath']);
	return Object.freeze({
		evidencePath: parseAbsoluteGuestPath(value.evidencePath, `${label}.evidencePath`),
		kind: parseLiteral(value.kind, 'tool-portal-evidence', `${label}.kind`),
		socketPath: parseAbsoluteGuestPath(value.socketPath, `${label}.socketPath`),
	});
}

function parseFrameworkReadiness(value: unknown, label: string): ManagedFrameworkReadinessMetadata {
	assertPlainRecord(value, label);
	assertExactFields(value, label, ['guestPort', 'kind', 'path']);
	return Object.freeze({
		guestPort: parseGuestPort(value.guestPort, `${label}.guestPort`),
		kind: parseLiteral(value.kind, 'framework-http', `${label}.kind`),
		path: parseHttpPath(value.path, `${label}.path`),
	});
}

function parseFrameworkIngress(value: unknown, label: string): ManagedFrameworkIngressMetadata {
	assertPlainRecord(value, label);
	assertExactFields(value, label, ['guestPort', 'kind']);
	return Object.freeze({
		guestPort: parseGuestPort(value.guestPort, `${label}.guestPort`),
		kind: parseLiteral(value.kind, 'framework-http', `${label}.kind`),
	});
}

function parseToolPortalService(value: unknown): ManagedToolPortalServiceBootMetadata {
	const label = 'Managed Gateway boot contract toolPortalService';
	assertPlainRecord(value, label);
	assertExactFields(value, label, [
		'bootEntry',
		'configurationInputPath',
		'environmentInputPath',
		'logIdentity',
		'readiness',
		'role',
	]);
	return Object.freeze({
		bootEntry: parseLiteral(value.bootEntry, 'agent-vm-gateway-runtime', `${label}.bootEntry`),
		configurationInputPath: parseAbsoluteGuestPath(
			value.configurationInputPath,
			`${label}.configurationInputPath`,
		),
		environmentInputPath: parseAbsoluteGuestPath(
			value.environmentInputPath,
			`${label}.environmentInputPath`,
		),
		logIdentity: parseLogIdentity(value.logIdentity, `${label}.logIdentity`),
		readiness: parseToolPortalReadiness(value.readiness, `${label}.readiness`),
		role: parseLiteral(value.role, 'tool-portal-service', `${label}.role`),
	});
}

function parseFrameworkService(value: unknown): ManagedFrameworkServiceBootMetadata {
	const label = 'Managed Gateway boot contract frameworkService';
	assertPlainRecord(value, label);
	assertExactFields(value, label, [
		'bootEntry',
		'configurationInputPath',
		'environmentInputPath',
		'framework',
		'ingress',
		'logIdentity',
		'readiness',
		'role',
	]);
	const framework = parseLiteral(value.framework, 'hermes', `${label}.framework`);
	const ingress = parseFrameworkIngress(value.ingress, `${label}.ingress`);
	const readiness = parseFrameworkReadiness(value.readiness, `${label}.readiness`);
	if (ingress.guestPort !== readiness.guestPort) {
		throw new Error(`${label} ingress and readiness must identify the same guest port.`);
	}
	const commonFields = {
		configurationInputPath: parseAbsoluteGuestPath(
			value.configurationInputPath,
			`${label}.configurationInputPath`,
		),
		environmentInputPath: parseAbsoluteGuestPath(
			value.environmentInputPath,
			`${label}.environmentInputPath`,
		),
		ingress,
		logIdentity: parseLogIdentity(value.logIdentity, `${label}.logIdentity`),
		readiness,
		role: parseLiteral(value.role, 'framework-service', `${label}.role`),
	};
	return Object.freeze({
		...commonFields,
		bootEntry: parseLiteral(value.bootEntry, 'hermes-gateway', `${label}.bootEntry`),
		framework,
	});
}

/**
 * Parses untrusted or serialized boot metadata into the exact V1 contract.
 * Unknown fields are rejected at every level and a fresh deeply frozen value
 * is returned so callers cannot retain mutation authority after validation.
 */
export function parseManagedGatewayBootContract(value: unknown): ManagedGatewayBootContract {
	const label = 'Managed Gateway boot contract';
	assertPlainRecord(value, label);
	assertExactFields(value, label, [
		'contractVersion',
		'frameworkService',
		'kind',
		'toolPortalService',
	]);
	return Object.freeze({
		contractVersion: parseLiteral(value.contractVersion, 1, `${label}.contractVersion`),
		frameworkService: parseFrameworkService(value.frameworkService),
		kind: parseLiteral(value.kind, 'managed-gateway-exact-two-role', `${label}.kind`),
		toolPortalService: parseToolPortalService(value.toolPortalService),
	});
}
