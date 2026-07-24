import { GatewayRuntimeToolPortalProductionControlEndpointSchema } from '@agent-vm/gateway-control-contracts';
import type { ManagedVmFinalizableMemoryFile } from '@agent-vm/managed-vm';

import type { GatewayExpectedAdmissionCohort } from './gateway-aggregate-admission-state.js';

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
	readonly frameworkConfig: unknown;
	readonly frameworkEnvironment: Readonly<Record<string, string>>;
	readonly mcpConfig: unknown;
	readonly toolPortalEnvironment: Readonly<Record<string, string>>;
	readonly toolPortalServiceConfig: unknown;
}

type ManagedGatewayFrameworkBootInputProps =
	| {
			readonly frameworkInputKind: 'configuration-only';
			readonly openClawControlAuthSecretName: string;
	  }
	| {
			readonly frameworkInputKind: 'hermes-managed-scope';
			readonly frameworkManagedConfigurationSource: string;
	  };

export type SerializeManagedGatewayBootInputsProps = ManagedGatewayBootInputCommonProps &
	ManagedGatewayFrameworkBootInputProps;

export interface ManagedGatewayBootInputInventories {
	readonly environmentFiles: readonly ManagedVmFinalizableMemoryFile[];
	readonly structuredInputFiles: readonly ManagedVmFinalizableMemoryFile[];
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

function requireEnvironmentValue(
	environment: Readonly<Record<string, string>>,
	environmentVariableName: string,
): string {
	const environmentVariableValue = environment[environmentVariableName];
	if (environmentVariableValue === undefined) {
		throw new Error(
			`Managed Gateway OpenClaw control auth secret '${environmentVariableName}' is absent from the protected framework environment.`,
		);
	}
	return environmentVariableValue;
}

function createMemoryFile(relativePath: string, contents: string): ManagedVmFinalizableMemoryFile {
	return {
		contents: new TextEncoder().encode(contents),
		mode: 0o600,
		relativePath,
	};
}

export function serializeManagedGatewayBootInputs(
	props: SerializeManagedGatewayBootInputsProps,
): ManagedGatewayBootInputInventories {
	validateToolPortalControlEndpoint({
		cohort: props.cohort,
		toolPortalServiceConfig: props.toolPortalServiceConfig,
	});
	const environmentFiles = [
		createMemoryFile(
			'framework.environment.sh',
			serializeEnvironment(props.frameworkEnvironment, 'framework'),
		),
		...(props.frameworkInputKind === 'configuration-only'
			? [
					createMemoryFile(
						'openclaw-all-secrets.environment.sh',
						serializeEnvironment(props.frameworkEnvironment, 'OpenClaw all-secrets'),
					),
					createMemoryFile(
						'openclaw-gateway-token.environment.sh',
						serializeEnvironment(
							{
								[props.openClawControlAuthSecretName]: requireEnvironmentValue(
									props.frameworkEnvironment,
									props.openClawControlAuthSecretName,
								),
							},
							'OpenClaw gateway token',
						),
					),
				]
			: []),
		createMemoryFile(
			'tool-portal.environment.sh',
			serializeEnvironment(props.toolPortalEnvironment, 'Tool Portal'),
		),
	];
	const structuredInputFiles = [
		createMemoryFile(
			'framework-service.json',
			serializeCanonicalJson(props.frameworkConfig, 'frameworkConfig'),
		),
		createMemoryFile('mcp.config.json', serializeCanonicalJson(props.mcpConfig, 'mcpConfig')),
		createMemoryFile(
			'tool-portal-service.json',
			serializeCanonicalJson(props.toolPortalServiceConfig, 'toolPortalServiceConfig'),
		),
		...(props.frameworkInputKind === 'hermes-managed-scope'
			? [createMemoryFile('config.yaml', props.frameworkManagedConfigurationSource)]
			: []),
	];
	return { environmentFiles, structuredInputFiles };
}
