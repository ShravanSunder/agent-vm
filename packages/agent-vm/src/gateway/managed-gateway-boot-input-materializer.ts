import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rmdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { GatewayRuntimeToolPortalProductionControlEndpointSchema } from '@agent-vm/gateway-control-contracts';

import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';

const managedGatewayBaseBootInputFileNames = [
	'framework-service.json',
	'framework.environment.sh',
	'mcp.config.json',
	'tool-portal-service.json',
	'tool-portal.environment.sh',
] as const;

const managedGatewayHermesBootInputFileNames = [
	...managedGatewayBaseBootInputFileNames,
	'config.yaml',
] as const;

export type ManagedGatewayBootInputFileName =
	(typeof managedGatewayHermesBootInputFileNames)[number];

interface CanonicalJsonObject {
	readonly [propertyName: string]: CanonicalJsonValue;
}

type CanonicalJsonValue =
	| boolean
	| null
	| number
	| string
	| readonly CanonicalJsonValue[]
	| CanonicalJsonObject;

interface ManagedGatewayBootInputCommonProps {
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly createdAt?: Date;
	readonly frameworkConfig: unknown;
	readonly frameworkEnvironment: Readonly<Record<string, string>>;
	readonly mcpConfig: unknown;
	readonly toolPortalEnvironment: Readonly<Record<string, string>>;
	readonly toolPortalServiceConfig: unknown;
}

type ManagedGatewayFrameworkBootInputProps =
	| {
			readonly frameworkInputKind: 'configuration-only';
	  }
	| {
			readonly frameworkInputKind: 'hermes-managed-scope';
			readonly frameworkManagedConfigurationSource: string;
	  };

export type MaterializeManagedGatewayBootInputsProps = ManagedGatewayBootInputCommonProps &
	ManagedGatewayFrameworkBootInputProps & {
		readonly parentDirectory: string;
	};

export interface ReserveManagedGatewayBootInputDirectoryProps {
	readonly parentDirectory: string;
}

export interface ManagedGatewayBootInputDirectoryIdentity {
	readonly deviceId: number;
	readonly inode: number;
	readonly ownerGid: number;
	readonly ownerUid: number;
}

export interface ManagedGatewayBootInputDirectoryReservation {
	readonly directoryMode: '0700';
	readonly directoryPath: string;
	readonly identity: ManagedGatewayBootInputDirectoryIdentity;
}

export type FinalizeManagedGatewayBootInputsProps = ManagedGatewayBootInputCommonProps &
	ManagedGatewayFrameworkBootInputProps & {
		readonly reservation: ManagedGatewayBootInputDirectoryReservation;
	};

export interface ManagedGatewayBootInputFileReceipt {
	readonly byteLength: number;
	readonly fileName: ManagedGatewayBootInputFileName;
	readonly mode: '0600';
	readonly ownerGid: number;
	readonly ownerUid: number;
	readonly sha256: string;
}

export interface ManagedGatewayBootInputReceipt {
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly createdAt: string;
	readonly directoryMode: '0700';
	readonly directoryPath: string;
	readonly files: readonly ManagedGatewayBootInputFileReceipt[];
	readonly receiptId: string;
	readonly schemaVersion: 1;
}

function canonicalJsonValue(value: unknown, fieldPath: string): CanonicalJsonValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`Managed Gateway boot input '${fieldPath}' must be a finite JSON number.`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return Object.freeze(
			value.map((entry, index) => canonicalJsonValue(entry, `${fieldPath}[${String(index)}]`)),
		);
	}
	if (typeof value !== 'object' || value === null) {
		throw new Error(`Managed Gateway boot input '${fieldPath}' must contain only JSON values.`);
	}
	const prototype = Reflect.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`Managed Gateway boot input '${fieldPath}' must be a plain JSON object.`);
	}
	const canonicalEntries: [string, CanonicalJsonValue][] = [];
	for (const propertyName of Object.keys(value).toSorted()) {
		const propertyDescriptor = Reflect.getOwnPropertyDescriptor(value, propertyName);
		if (propertyDescriptor === undefined || !Object.hasOwn(propertyDescriptor, 'value')) {
			throw new Error(
				`Managed Gateway boot input '${fieldPath}.${propertyName}' must be a data field.`,
			);
		}
		canonicalEntries.push([
			propertyName,
			canonicalJsonValue(propertyDescriptor.value, `${fieldPath}.${propertyName}`),
		]);
	}
	return Object.freeze(Object.fromEntries(canonicalEntries));
}

function serializeCanonicalJson(value: unknown, inputName: string): string {
	return `${JSON.stringify(canonicalJsonValue(value, inputName), null, '\t')}\n`;
}

function readOwnJsonDataProperty(value: unknown, fieldPath: string, propertyName: string): unknown {
	if (value === null || Array.isArray(value) || typeof value !== 'object') {
		throw new Error(`Managed Gateway boot input '${fieldPath}' must be a JSON object.`);
	}
	const prototype = Reflect.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`Managed Gateway boot input '${fieldPath}' must be a plain JSON object.`);
	}
	const propertyDescriptor = Reflect.getOwnPropertyDescriptor(value, propertyName);
	if (propertyDescriptor === undefined || !Object.hasOwn(propertyDescriptor, 'value')) {
		throw new Error(
			`Managed Gateway boot input '${fieldPath}.${propertyName}' must be a data field.`,
		);
	}
	return propertyDescriptor.value;
}

function validateToolPortalControlEndpoint(props: {
	readonly cohort: GatewayExpectedAdmissionCohort;
	readonly toolPortalServiceConfig: unknown;
}): void {
	const controlEndpoint = readOwnJsonDataProperty(
		props.toolPortalServiceConfig,
		'toolPortalServiceConfig',
		'controlEndpoint',
	);
	const listen = readOwnJsonDataProperty(
		controlEndpoint,
		'toolPortalServiceConfig.controlEndpoint',
		'listen',
	);
	const productionEndpoint =
		GatewayRuntimeToolPortalProductionControlEndpointSchema.safeParse(listen);
	const configuredPort = readOwnJsonDataProperty(
		listen,
		'toolPortalServiceConfig.controlEndpoint.listen',
		'port',
	);
	if (
		typeof configuredPort === 'number' &&
		configuredPort !== props.cohort.ingressIntent.controlRoute.guestPort
	) {
		throw new Error('Tool Portal control listener must match protected ingress intent.');
	}
	if (!productionEndpoint.success) {
		throw new Error('Tool Portal control listener must use the fixed production endpoint.');
	}
	if (productionEndpoint.data.port !== props.cohort.ingressIntent.controlRoute.guestPort) {
		throw new Error('Tool Portal control listener must match protected ingress intent.');
	}
}

const environmentVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function serializeEnvironment(
	environment: Readonly<Record<string, string>>,
	inputName: string,
): string {
	const lines = Object.entries(environment)
		.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName))
		.map(([environmentVariableName, environmentVariableValue]) => {
			if (!environmentVariableNamePattern.test(environmentVariableName)) {
				throw new Error(
					`Managed Gateway ${inputName} environment variable name '${environmentVariableName}' is invalid.`,
				);
			}
			if (environmentVariableValue.includes('\0')) {
				throw new Error(
					`Managed Gateway ${inputName} environment variable '${environmentVariableName}' contains a NUL byte.`,
				);
			}
			return `export ${environmentVariableName}=${shellSingleQuote(environmentVariableValue)}`;
		});
	return `${lines.join('\n')}\n`;
}

function cloneFrozenAdmissionCohort(
	cohort: GatewayExpectedAdmissionCohort,
): GatewayExpectedAdmissionCohort {
	return Object.freeze({
		controlIdentity: Object.freeze({ ...cohort.controlIdentity }),
		fence: Object.freeze({ ...cohort.fence }),
		frameworkIdentity: Object.freeze({
			...cohort.frameworkIdentity,
			configuredAgentIds: Object.freeze(
				[...cohort.frameworkIdentity.configuredAgentIds].toSorted(),
			),
		}),
		ingressIntent: Object.freeze({
			controlRoute: Object.freeze({ ...cohort.ingressIntent.controlRoute }),
			frameworkRootRoute: Object.freeze({ ...cohort.ingressIntent.frameworkRootRoute }),
		}),
		providerRevision: cohort.providerRevision,
		requiredBackendRevision: cohort.requiredBackendRevision,
		semanticRevision: cohort.semanticRevision,
		toolPortalIdentity: Object.freeze({ ...cohort.toolPortalIdentity }),
		udsIdentity: Object.freeze({ ...cohort.udsIdentity }),
	});
}

type ManagedGatewayBootInputReservationLifecycle =
	| 'failed'
	| 'finalized'
	| 'finalizing'
	| 'released'
	| 'reserved';

interface ManagedGatewayBootInputFileIdentity extends ManagedGatewayBootInputDirectoryIdentity {
	readonly linkCount: number;
}

interface ManagedGatewayBootInputReservationState {
	readonly createdFiles: Map<ManagedGatewayBootInputFileName, ManagedGatewayBootInputFileIdentity>;
	readonly directoryHandle: FileHandle;
	readonly directoryPath: string;
	readonly identity: ManagedGatewayBootInputDirectoryIdentity;
	directoryHandleClosed: boolean;
	lifecycle: ManagedGatewayBootInputReservationLifecycle;
}

const managedGatewayBootInputReservationStates = new WeakMap<
	ManagedGatewayBootInputDirectoryReservation,
	ManagedGatewayBootInputReservationState
>();

function filesystemIdentity(status: Stats): ManagedGatewayBootInputDirectoryIdentity {
	return Object.freeze({
		deviceId: status.dev,
		inode: status.ino,
		ownerGid: status.gid,
		ownerUid: status.uid,
	});
}

function hasFilesystemIdentity(
	status: Stats,
	identity: ManagedGatewayBootInputDirectoryIdentity,
): boolean {
	return (
		status.dev === identity.deviceId &&
		status.ino === identity.inode &&
		status.gid === identity.ownerGid &&
		status.uid === identity.ownerUid
	);
}

function equalFileNameInventory(
	actualFileNames: readonly string[],
	expectedFileNames: readonly string[],
): boolean {
	return (
		actualFileNames.length === expectedFileNames.length &&
		actualFileNames.every((fileName, index) => fileName === expectedFileNames[index])
	);
}

async function assertReservedDirectoryIdentityAndInventory(props: {
	readonly expectedFileNames: readonly ManagedGatewayBootInputFileName[];
	readonly state: ManagedGatewayBootInputReservationState;
}): Promise<void> {
	let pathStatus: Stats;
	try {
		pathStatus = await lstat(props.state.directoryPath);
	} catch {
		throw new Error('Managed Gateway boot input directory changed after reservation.');
	}
	const handleStatus = await props.state.directoryHandle.stat();
	if (
		pathStatus.isSymbolicLink() ||
		!pathStatus.isDirectory() ||
		!handleStatus.isDirectory() ||
		!hasFilesystemIdentity(pathStatus, props.state.identity) ||
		!hasFilesystemIdentity(handleStatus, props.state.identity) ||
		(pathStatus.mode & 0o777) !== 0o700 ||
		(handleStatus.mode & 0o777) !== 0o700
	) {
		throw new Error('Managed Gateway boot input directory changed after reservation.');
	}
	const actualFileNames = (await readdir(props.state.directoryPath)).toSorted();
	const expectedFileNames = [...props.expectedFileNames].toSorted();
	if (!equalFileNameInventory(actualFileNames, expectedFileNames)) {
		throw new Error('Managed Gateway boot input directory has unexpected inventory.');
	}
}

function assertProtectedInputFileStatus(props: {
	readonly directoryIdentity: ManagedGatewayBootInputDirectoryIdentity;
	readonly fileName: ManagedGatewayBootInputFileName;
	readonly fileStatus: Stats;
}): void {
	if (
		!props.fileStatus.isFile() ||
		props.fileStatus.isSymbolicLink() ||
		props.fileStatus.nlink !== 1 ||
		props.fileStatus.uid !== props.directoryIdentity.ownerUid ||
		props.fileStatus.gid !== props.directoryIdentity.ownerGid ||
		(props.fileStatus.mode & 0o777) !== 0o600
	) {
		throw new Error(
			`Managed Gateway boot input '${props.fileName}' is not an owned mode-0600 regular file.`,
		);
	}
}

async function writeProtectedInputFile(props: {
	readonly contents: string;
	readonly fileName: ManagedGatewayBootInputFileName;
	readonly state: ManagedGatewayBootInputReservationState;
}): Promise<ManagedGatewayBootInputFileReceipt> {
	const filePath = path.join(props.state.directoryPath, props.fileName);
	const fileContents = Buffer.from(props.contents, 'utf8');
	const fileHandle = await open(
		filePath,
		constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
		0o600,
	);
	try {
		const createdStatus = await fileHandle.stat();
		const createdIdentity = Object.freeze({
			...filesystemIdentity(createdStatus),
			linkCount: createdStatus.nlink,
		});
		props.state.createdFiles.set(props.fileName, createdIdentity);
		await fileHandle.chmod(0o600);
		const protectedStatus = await fileHandle.stat();
		assertProtectedInputFileStatus({
			directoryIdentity: props.state.identity,
			fileName: props.fileName,
			fileStatus: protectedStatus,
		});
		if (!hasFilesystemIdentity(protectedStatus, createdIdentity)) {
			throw new Error(`Managed Gateway boot input '${props.fileName}' changed during creation.`);
		}
		await fileHandle.writeFile(fileContents);
		await fileHandle.sync();
		const synchronizedStatus = await fileHandle.stat();
		assertProtectedInputFileStatus({
			directoryIdentity: props.state.identity,
			fileName: props.fileName,
			fileStatus: synchronizedStatus,
		});
		if (!hasFilesystemIdentity(synchronizedStatus, createdIdentity)) {
			throw new Error(`Managed Gateway boot input '${props.fileName}' changed while writing.`);
		}
		return Object.freeze({
			byteLength: fileContents.byteLength,
			fileName: props.fileName,
			mode: '0600',
			ownerGid: synchronizedStatus.gid,
			ownerUid: synchronizedStatus.uid,
			sha256: createHash('sha256').update(fileContents).digest('hex'),
		});
	} finally {
		await fileHandle.close();
	}
}

function nodeErrorCode(error: unknown): string | undefined {
	return typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		typeof error.code === 'string'
		? error.code
		: undefined;
}

async function prepareProtectedParentDirectory(parentDirectory: string): Promise<void> {
	try {
		await mkdir(parentDirectory, { mode: 0o700, recursive: true });
	} catch (error: unknown) {
		if (nodeErrorCode(error) !== 'EEXIST') throw error;
	}
	const initialStatus = await lstat(parentDirectory);
	if (initialStatus.isSymbolicLink() || !initialStatus.isDirectory()) {
		throw new Error('Managed Gateway boot input parent must be a non-symlink directory.');
	}
	await chmod(parentDirectory, 0o700);
	const protectedStatus = await lstat(parentDirectory);
	if (
		protectedStatus.isSymbolicLink() ||
		!protectedStatus.isDirectory() ||
		protectedStatus.dev !== initialStatus.dev ||
		protectedStatus.ino !== initialStatus.ino ||
		(protectedStatus.mode & 0o777) !== 0o700
	) {
		throw new Error('Managed Gateway boot input parent changed while being protected.');
	}
}

async function closeReservationDirectoryHandle(
	state: ManagedGatewayBootInputReservationState,
): Promise<void> {
	if (state.directoryHandleClosed) return;
	state.directoryHandleClosed = true;
	await state.directoryHandle.close();
}

async function readPathStatus(pathname: string): Promise<Stats | undefined> {
	try {
		return await lstat(pathname);
	} catch {
		return undefined;
	}
}

async function removeOwnedReservationDirectory(
	state: ManagedGatewayBootInputReservationState,
): Promise<void> {
	const initialDirectoryStatus = await readPathStatus(state.directoryPath);
	if (
		initialDirectoryStatus === undefined ||
		initialDirectoryStatus.isSymbolicLink() ||
		!initialDirectoryStatus.isDirectory() ||
		!hasFilesystemIdentity(initialDirectoryStatus, state.identity)
	) {
		return;
	}
	for (const [fileName, fileIdentity] of state.createdFiles) {
		// oxlint-disable-next-line no-await-in-loop -- cleanup must reverify the reserved root immediately before each owned-file decision.
		const currentDirectoryStatus = await readPathStatus(state.directoryPath);
		if (
			currentDirectoryStatus === undefined ||
			currentDirectoryStatus.isSymbolicLink() ||
			!currentDirectoryStatus.isDirectory() ||
			!hasFilesystemIdentity(currentDirectoryStatus, state.identity)
		) {
			return;
		}
		const filePath = path.join(state.directoryPath, fileName);
		// oxlint-disable-next-line no-await-in-loop -- cleanup decisions are sequential so each unlink follows a fresh root check.
		const fileStatus = await readPathStatus(filePath);
		if (
			fileStatus !== undefined &&
			fileStatus.isFile() &&
			!fileStatus.isSymbolicLink() &&
			fileStatus.nlink === fileIdentity.linkCount &&
			hasFilesystemIdentity(fileStatus, fileIdentity)
		) {
			// oxlint-disable-next-line no-await-in-loop -- owned files are removed only after their sequential identity check.
			await unlink(filePath);
		}
	}
	const finalDirectoryStatus = await readPathStatus(state.directoryPath);
	if (
		finalDirectoryStatus !== undefined &&
		!finalDirectoryStatus.isSymbolicLink() &&
		finalDirectoryStatus.isDirectory() &&
		hasFilesystemIdentity(finalDirectoryStatus, state.identity) &&
		(await readdir(state.directoryPath)).length === 0
	) {
		await rmdir(state.directoryPath);
	}
}

function serializeManagedGatewayBootInput(
	fileName: ManagedGatewayBootInputFileName,
	props: FinalizeManagedGatewayBootInputsProps,
): string {
	switch (fileName) {
		case 'config.yaml':
			if (props.frameworkInputKind !== 'hermes-managed-scope') {
				throw new Error('Hermes managed config cannot be written for configuration-only input.');
			}
			return props.frameworkManagedConfigurationSource;
		case 'framework-service.json':
			return serializeCanonicalJson(props.frameworkConfig, 'frameworkConfig');
		case 'framework.environment.sh':
			return serializeEnvironment(props.frameworkEnvironment, 'framework');
		case 'mcp.config.json':
			return serializeCanonicalJson(props.mcpConfig, 'mcpConfig');
		case 'tool-portal-service.json':
			return serializeCanonicalJson(props.toolPortalServiceConfig, 'toolPortalServiceConfig');
		case 'tool-portal.environment.sh':
			return serializeEnvironment(props.toolPortalEnvironment, 'Tool Portal');
	}
}

function managedGatewayBootInputFileNames(
	props: FinalizeManagedGatewayBootInputsProps,
): readonly ManagedGatewayBootInputFileName[] {
	return props.frameworkInputKind === 'hermes-managed-scope'
		? managedGatewayHermesBootInputFileNames
		: managedGatewayBaseBootInputFileNames;
}

export async function reserveManagedGatewayBootInputDirectory(
	props: ReserveManagedGatewayBootInputDirectoryProps,
): Promise<ManagedGatewayBootInputDirectoryReservation> {
	const parentDirectory = path.resolve(props.parentDirectory);
	await prepareProtectedParentDirectory(parentDirectory);
	const directoryPath = await mkdtemp(path.join(parentDirectory, 'managed-gateway-inputs-'));
	let directoryHandle: FileHandle | undefined;
	let reservedIdentity: ManagedGatewayBootInputDirectoryIdentity | undefined;
	try {
		const initialStatus = await lstat(directoryPath);
		if (initialStatus.isSymbolicLink() || !initialStatus.isDirectory()) {
			throw new Error('Managed Gateway boot input reservation must be a directory inode.');
		}
		reservedIdentity = filesystemIdentity(initialStatus);
		await chmod(directoryPath, 0o700);
		directoryHandle = await open(
			directoryPath,
			constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
		);
		const [pathStatus, handleStatus, initialFileNames] = await Promise.all([
			lstat(directoryPath),
			directoryHandle.stat(),
			readdir(directoryPath),
		]);
		const identity = reservedIdentity;
		if (
			pathStatus.isSymbolicLink() ||
			!pathStatus.isDirectory() ||
			!handleStatus.isDirectory() ||
			!hasFilesystemIdentity(pathStatus, identity) ||
			(pathStatus.mode & 0o777) !== 0o700 ||
			(handleStatus.mode & 0o777) !== 0o700 ||
			initialFileNames.length !== 0
		) {
			throw new Error('Managed Gateway boot input reservation must be one empty mode-0700 inode.');
		}
		const reservation = Object.freeze({
			directoryMode: '0700' as const,
			directoryPath,
			identity,
		});
		managedGatewayBootInputReservationStates.set(reservation, {
			createdFiles: new Map(),
			directoryHandle,
			directoryHandleClosed: false,
			directoryPath,
			identity,
			lifecycle: 'reserved',
		});
		return reservation;
	} catch (error: unknown) {
		await directoryHandle?.close().catch(() => undefined);
		const directoryStatus = await readPathStatus(directoryPath);
		if (
			reservedIdentity !== undefined &&
			directoryStatus !== undefined &&
			!directoryStatus.isSymbolicLink() &&
			directoryStatus.isDirectory() &&
			hasFilesystemIdentity(directoryStatus, reservedIdentity) &&
			(await readdir(directoryPath).catch(() => ['unknown'])).length === 0
		) {
			await rmdir(directoryPath).catch(() => undefined);
		}
		throw error;
	}
}

function requireReservationState(
	reservation: ManagedGatewayBootInputDirectoryReservation,
): ManagedGatewayBootInputReservationState {
	const state = managedGatewayBootInputReservationStates.get(reservation);
	if (state === undefined) {
		throw new Error('Managed Gateway boot input reservation is unknown.');
	}
	return state;
}

export async function finalizeManagedGatewayBootInputs(
	props: FinalizeManagedGatewayBootInputsProps,
): Promise<ManagedGatewayBootInputReceipt> {
	const state = requireReservationState(props.reservation);
	if (state.lifecycle !== 'reserved') {
		throw new Error(
			`Managed Gateway boot input reservation cannot be finalized from '${state.lifecycle}'.`,
		);
	}
	state.lifecycle = 'finalizing';
	try {
		const createdAt = props.createdAt ?? new Date();
		if (!Number.isFinite(createdAt.getTime())) {
			throw new Error('Managed Gateway boot input receipt time must be valid.');
		}
		validateToolPortalControlEndpoint({
			cohort: props.cohort,
			toolPortalServiceConfig: props.toolPortalServiceConfig,
		});
		const inputFileNames = managedGatewayBootInputFileNames(props);
		const fileReceipts: ManagedGatewayBootInputFileReceipt[] = [];
		for (const fileName of inputFileNames) {
			// oxlint-disable-next-line no-await-in-loop -- every exclusive create requires a fresh exact-inventory check.
			await assertReservedDirectoryIdentityAndInventory({
				expectedFileNames: [...state.createdFiles.keys()],
				state,
			});
			fileReceipts.push(
				// oxlint-disable-next-line no-await-in-loop -- immutable inputs publish in a fixed sequence with per-file durability.
				await writeProtectedInputFile({
					contents: serializeManagedGatewayBootInput(fileName, props),
					fileName,
					state,
				}),
			);
		}
		await assertReservedDirectoryIdentityAndInventory({
			expectedFileNames: inputFileNames,
			state,
		});
		await state.directoryHandle.sync();
		await assertReservedDirectoryIdentityAndInventory({
			expectedFileNames: inputFileNames,
			state,
		});
		state.lifecycle = 'finalized';
		await closeReservationDirectoryHandle(state);
		return Object.freeze({
			cohort: cloneFrozenAdmissionCohort(props.cohort),
			createdAt: createdAt.toISOString(),
			directoryMode: '0700',
			directoryPath: state.directoryPath,
			files: Object.freeze(fileReceipts),
			receiptId: randomUUID(),
			schemaVersion: 1,
		});
	} catch (error: unknown) {
		state.lifecycle = 'failed';
		await removeOwnedReservationDirectory(state).catch(() => undefined);
		await closeReservationDirectoryHandle(state).catch(() => undefined);
		throw error;
	}
}

export async function releaseManagedGatewayBootInputDirectory(
	reservation: ManagedGatewayBootInputDirectoryReservation,
): Promise<void> {
	const state = requireReservationState(reservation);
	if (state.lifecycle === 'finalizing') {
		throw new Error('Managed Gateway boot input reservation cannot be released while finalizing.');
	}
	if (state.lifecycle === 'released') return;
	await removeOwnedReservationDirectory(state);
	await closeReservationDirectoryHandle(state).catch(() => undefined);
	state.lifecycle = 'released';
}

export async function materializeManagedGatewayBootInputs(
	props: MaterializeManagedGatewayBootInputsProps,
): Promise<ManagedGatewayBootInputReceipt> {
	const { parentDirectory, ...finalizationProps } = props;
	const reservation = await reserveManagedGatewayBootInputDirectory({ parentDirectory });
	return finalizeManagedGatewayBootInputs({ ...finalizationProps, reservation });
}
