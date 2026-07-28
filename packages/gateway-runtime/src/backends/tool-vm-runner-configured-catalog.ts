import {
	SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS,
	type CapabilityDescriptor,
	type CapabilitySummary,
} from '@agent-vm/agent-portal-sdk';
import type {
	ToolPortalConfig,
	ToolPortalSandboxSshOperationDefinition,
} from '@agent-vm/config-contracts';

import {
	MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES,
	MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS,
	MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES,
	type GatewayRuntimeToolVmRunnerCapabilityCatalog,
	type GatewayRuntimeToolVmRunnerCapabilityCatalogEntry,
	type GatewayRuntimeToolVmRunnerCapabilityOperation,
} from './tool-vm-runner-backend-port.js';

type ToolVmRunnerJsonSchema = NonNullable<CapabilityDescriptor['inputSchema']>;

const EmptyInputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {},
	type: 'object',
};

const PathInputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		path: {
			maxLength: MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS,
			minLength: 1,
			type: 'string',
		},
	},
	required: ['path'],
	type: 'object',
};

const WriteFileInputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		content: { maxLength: MAXIMUM_TOOL_VM_RUNNER_TEXT_WRITE_BYTES, type: 'string' },
		path: {
			maxLength: MAXIMUM_TOOL_VM_RUNNER_PUBLIC_PATH_CHARACTERS,
			minLength: 1,
			type: 'string',
		},
	},
	required: ['content', 'path'],
	type: 'object',
};

const ProcessLogsInputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		cursor: { maxLength: SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS, minLength: 1, type: 'string' },
		handleToken: {
			maxLength: SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS,
			minLength: 1,
			type: 'string',
		},
		maxBytes: {
			maximum: MAXIMUM_TOOL_VM_RUNNER_PROCESS_LOG_BYTES,
			minimum: 1,
			type: 'integer',
		},
	},
	required: ['handleToken', 'maxBytes'],
	type: 'object',
};

const ProcessHandleInputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		handleToken: {
			maxLength: SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS,
			minLength: 1,
			type: 'string',
		},
	},
	required: ['handleToken'],
	type: 'object',
};

const CommandOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: { exitCode: { type: 'integer' }, kind: { const: 'exited', type: 'string' } },
	required: ['exitCode', 'kind'],
	type: 'object',
};

const ReadFileOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		byteLength: { minimum: 0, type: 'integer' },
		kind: { const: 'file', type: 'string' },
	},
	required: ['byteLength', 'kind'],
	type: 'object',
};

const WriteFileOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		byteLength: { minimum: 0, type: 'integer' },
		kind: { const: 'written', type: 'string' },
		path: { type: 'string' },
	},
	required: ['byteLength', 'kind', 'path'],
	type: 'object',
};

const ProcessLogsOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		byteLength: { minimum: 0, type: 'integer' },
		chunkCount: { minimum: 0, type: 'integer' },
		kind: { const: 'logs', type: 'string' },
		nextCursor: { type: 'string' },
		truncated: { type: 'boolean' },
	},
	required: ['byteLength', 'chunkCount', 'kind', 'truncated'],
	type: 'object',
};

const ProcessStartedOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		handleToken: { type: 'string' },
		kind: { const: 'started', type: 'string' },
	},
	required: ['handleToken', 'kind'],
	type: 'object',
};

const ProcessStateOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: { kind: { type: 'string' }, outcome: { type: 'object' } },
	required: ['kind'],
	type: 'object',
};

function capabilityDescriptor(props: {
	readonly inputSchema: CapabilityDescriptor['inputSchema'];
	readonly name: string;
	readonly namespace: string;
	readonly outputSchema: CapabilityDescriptor['outputSchema'];
}): CapabilityDescriptor {
	return {
		annotations: {},
		inputSchema: props.inputSchema,
		name: props.name,
		namespace: props.namespace,
		outputSchema: props.outputSchema,
		related: [],
		toolRef: `${props.namespace}.${props.name}`,
	};
}

function capabilitySummary(props: {
	readonly description: string;
	readonly input: CapabilitySummary['input'];
	readonly name: string;
	readonly namespace: string;
	readonly output: NonNullable<CapabilitySummary['output']>;
	readonly safety: CapabilitySummary['safety'];
}): CapabilitySummary {
	return {
		description: props.description,
		input: props.input,
		name: props.name,
		namespace: props.namespace,
		output: props.output,
		safety: props.safety,
		toolRef: `${props.namespace}.${props.name}`,
	};
}

function compileConfiguredOperation(props: {
	readonly definition: ToolPortalSandboxSshOperationDefinition;
	readonly name: string;
	readonly namespace: string;
}): GatewayRuntimeToolVmRunnerCapabilityCatalogEntry {
	const common = {
		name: props.name,
		namespace: props.namespace,
	};
	switch (props.definition.kind) {
		case 'command.fixed':
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: EmptyInputSchema,
					outputSchema: CommandOutputSchema,
				}),
				operation: {
					argv: [props.definition.executable, ...props.definition.mandatoryArgvPrefix],
					cwd: props.definition.workingDirectory,
					kind: 'exec',
				},
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: { optional: [], propertyCount: 0, required: [], type: 'object' },
					output: {
						optional: [],
						propertyCount: 2,
						required: ['exitCode', 'kind'],
						type: 'object',
					},
					safety: { destructiveHint: true, readOnlyHint: false },
				}),
			};
		case 'filesystem.read':
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: PathInputSchema,
					outputSchema: ReadFileOutputSchema,
				}),
				operation: { kind: 'read-file' },
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: {
						optional: [],
						propertyCount: 1,
						required: ['path'],
						type: 'object',
					},
					output: {
						optional: [],
						propertyCount: 2,
						required: ['byteLength', 'kind'],
						type: 'object',
					},
					safety: { readOnlyHint: true },
				}),
			};
		case 'filesystem.write':
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: WriteFileInputSchema,
					outputSchema: WriteFileOutputSchema,
				}),
				operation: { kind: 'write-file' },
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: {
						optional: [],
						propertyCount: 2,
						required: ['content', 'path'],
						type: 'object',
					},
					output: {
						optional: [],
						propertyCount: 3,
						required: ['byteLength', 'kind', 'path'],
						type: 'object',
					},
					safety: { destructiveHint: true, readOnlyHint: false },
				}),
			};
		case 'process.logs':
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: ProcessLogsInputSchema,
					outputSchema: ProcessLogsOutputSchema,
				}),
				operation: { kind: 'process-logs' },
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: {
						optional: ['cursor'],
						propertyCount: 3,
						required: ['handleToken', 'maxBytes'],
						type: 'object',
					},
					output: {
						optional: ['nextCursor'],
						propertyCount: 5,
						required: ['byteLength', 'chunkCount', 'kind', 'truncated'],
						type: 'object',
					},
					safety: { readOnlyHint: true },
				}),
			};
		case 'process.cancel':
		case 'process.status':
		case 'process.wait': {
			const operation: GatewayRuntimeToolVmRunnerCapabilityOperation =
				props.definition.kind === 'process.cancel'
					? { kind: 'process-cancel' }
					: props.definition.kind === 'process.status'
						? { kind: 'process-status' }
						: { kind: 'process-wait', timeoutMs: props.definition.timeoutMs };
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: ProcessHandleInputSchema,
					outputSchema: ProcessStateOutputSchema,
				}),
				operation,
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: {
						optional: [],
						propertyCount: 1,
						required: ['handleToken'],
						type: 'object',
					},
					output: {
						optional: ['outcome'],
						propertyCount: 2,
						required: ['kind'],
						type: 'object',
					},
					safety: { readOnlyHint: props.definition.kind !== 'process.cancel' },
				}),
			};
		}
		case 'process.start':
			return {
				descriptor: capabilityDescriptor({
					...common,
					inputSchema: EmptyInputSchema,
					outputSchema: ProcessStartedOutputSchema,
				}),
				operation: {
					argv: [props.definition.executable, ...props.definition.mandatoryArgvPrefix],
					cwd: props.definition.workingDirectory,
					kind: 'process-start',
					maxRuntimeMs: props.definition.maxRuntimeMs,
					retainOutputBytes: props.definition.retainOutputBytes,
				},
				summary: capabilitySummary({
					...common,
					description: props.definition.description,
					input: { optional: [], propertyCount: 0, required: [], type: 'object' },
					output: {
						optional: [],
						propertyCount: 2,
						required: ['handleToken', 'kind'],
						type: 'object',
					},
					safety: { destructiveHint: true, readOnlyHint: false },
				}),
			};
	}
	const unreachableDefinition: never = props.definition;
	throw new Error(
		`Unsupported configured Tool VM runner operation: ${String(unreachableDefinition)}`,
	);
}

export function compileGatewayRuntimeToolVmRunnerConfiguredCatalog(
	config: ToolPortalConfig,
): GatewayRuntimeToolVmRunnerCapabilityCatalog {
	const profileCatalogs: [string, GatewayRuntimeToolVmRunnerCapabilityCatalogEntry[]][] = [];
	for (const [profileId, profile] of Object.entries(config.profiles)) {
		const entries: GatewayRuntimeToolVmRunnerCapabilityCatalogEntry[] = [];
		for (const [namespace, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'tool_vm_runner') continue;
			for (const [name, definition] of Object.entries(namespacePolicy.backend.operations)) {
				entries.push(compileConfiguredOperation({ definition, name, namespace }));
			}
		}
		profileCatalogs.push([profileId, entries]);
	}
	return Object.fromEntries(profileCatalogs);
}
