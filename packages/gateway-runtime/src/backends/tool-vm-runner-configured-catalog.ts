import {
	SANDBOX_MAXIMUM_IDENTIFIER_CHARACTERS,
	type CapabilityDescriptor,
	type CapabilitySummary,
	type ToolVmCallHintsAdvisory,
	type ToolVmCliDiscoveryMetadata,
} from '@agent-vm/agent-portal-sdk';
import {
	MAXIMUM_TOOL_VM_CLI_ARGV_ITEMS,
	MAXIMUM_TOOL_VM_CLI_ARGV_TOKEN_CHARACTERS,
	MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES,
	MAXIMUM_TOOL_VM_CLI_STDIN_BYTES,
	type GatewayRuntimeManagedToolPortalConfig,
	type ToolPortalSandboxSshOperationDefinition,
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

const ConfiguredCliOutputSchema: ToolVmRunnerJsonSchema = {
	additionalProperties: false,
	properties: {
		exitCode: { type: 'integer' },
		stderrSummary: { type: 'string' },
		stderrTruncated: { type: 'boolean' },
		stdout: { maxLength: MAXIMUM_TOOL_VM_CLI_MODEL_VISIBLE_STDOUT_BYTES, type: 'string' },
		stdoutTruncated: { type: 'boolean' },
	},
	required: ['exitCode', 'stderrTruncated', 'stdout', 'stdoutTruncated'],
	type: 'object',
};

function toolVmCliInputJsonSchema(timeoutKind: 'open' | 'quick'): ToolVmRunnerJsonSchema {
	return {
		additionalProperties: false,
		properties: {
			argv: {
				items: {
					maxLength: MAXIMUM_TOOL_VM_CLI_ARGV_TOKEN_CHARACTERS,
					minLength: 1,
					pattern: '^[^\\u0000]+$',
					type: 'string',
				},
				maxItems: MAXIMUM_TOOL_VM_CLI_ARGV_ITEMS,
				type: 'array',
			},
			reason: { maxLength: 2_000, minLength: 1, type: 'string' },
			stdin: { maxLength: MAXIMUM_TOOL_VM_CLI_STDIN_BYTES, type: 'string' },
			...(timeoutKind === 'open'
				? { timeoutMs: { maximum: 28_800_000, minimum: 1, type: 'integer' } }
				: {}),
		},
		required: ['argv', 'reason'],
		type: 'object',
	};
}

function toolVmCallHintsAdvisory(
	definition: Extract<ToolPortalSandboxSshOperationDefinition, { kind: 'command.cli' }>,
): ToolVmCallHintsAdvisory | undefined {
	const hasHintDeny = (definition.advisoryHints?.hintDeny.length ?? 0) > 0;
	const hasHintRequiresApproval = (definition.advisoryHints?.hintRequiresApproval.length ?? 0) > 0;
	if (!hasHintDeny && !hasHintRequiresApproval) return undefined;
	return {
		bypassableWithinToolVm: true,
		hasHintDeny,
		hasHintRequiresApproval,
		kind: 'tool_vm_call_hints',
		scope: 'tool_portal_call_only',
	};
}

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
	readonly advisory?: ToolVmCallHintsAdvisory;
	readonly annotations?: CapabilityDescriptor['annotations'];
	readonly description?: string;
	readonly inputSchema: CapabilityDescriptor['inputSchema'];
	readonly name: string;
	readonly namespace: string;
	readonly outputSchema: CapabilityDescriptor['outputSchema'];
	readonly toolVmCliMetadata?: ToolVmCliDiscoveryMetadata;
}): CapabilityDescriptor {
	return {
		...(props.advisory === undefined ? {} : { advisory: props.advisory }),
		annotations: props.annotations ?? {},
		...(props.description === undefined ? {} : { description: props.description }),
		inputSchema: props.inputSchema,
		name: props.name,
		namespace: props.namespace,
		outputSchema: props.outputSchema,
		related: [],
		...(props.toolVmCliMetadata === undefined
			? {}
			: { toolVmCliMetadata: props.toolVmCliMetadata }),
		toolRef: `${props.namespace}.${props.name}`,
	};
}

function capabilitySummary(props: {
	readonly advisory?: ToolVmCallHintsAdvisory;
	readonly description: string;
	readonly input: CapabilitySummary['input'];
	readonly name: string;
	readonly namespace: string;
	readonly output: NonNullable<CapabilitySummary['output']>;
	readonly safety: CapabilitySummary['safety'];
	readonly title?: string;
	readonly toolVmCliMetadata?: ToolVmCliDiscoveryMetadata;
}): CapabilitySummary {
	return {
		...(props.advisory === undefined ? {} : { advisory: props.advisory }),
		description: props.description,
		input: props.input,
		name: props.name,
		namespace: props.namespace,
		output: props.output,
		safety: props.safety,
		...(props.title === undefined ? {} : { title: props.title }),
		...(props.toolVmCliMetadata === undefined
			? {}
			: { toolVmCliMetadata: props.toolVmCliMetadata }),
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
		case 'command.cli': {
			const advisory = toolVmCallHintsAdvisory(props.definition);
			return {
				descriptor: capabilityDescriptor({
					...common,
					...(advisory === undefined ? {} : { advisory }),
					annotations: {},
					description: props.definition.safeHelp,
					inputSchema: toolVmCliInputJsonSchema(props.definition.timeout.kind),
					outputSchema: ConfiguredCliOutputSchema,
					...(props.definition.metadata === undefined
						? {}
						: { toolVmCliMetadata: props.definition.metadata }),
				}),
				operation: {
					...(props.definition.advisoryHints === undefined
						? {}
						: { advisoryHints: props.definition.advisoryHints }),
					executable: props.definition.executable,
					kind: 'cli-exec',
					output: props.definition.output,
					timeout: props.definition.timeout,
					workingDirectory: props.definition.workingDirectory,
				},
				summary: capabilitySummary({
					...common,
					...(advisory === undefined ? {} : { advisory }),
					description: props.definition.safeHelp,
					input: {
						optional: ['stdin', ...(props.definition.timeout.kind === 'open' ? ['timeoutMs'] : [])],
						propertyCount: props.definition.timeout.kind === 'open' ? 4 : 3,
						required: ['argv', 'reason'],
						type: 'object',
					},
					output: {
						optional: ['stderrSummary'],
						propertyCount: 5,
						required: ['exitCode', 'stderrTruncated', 'stdout', 'stdoutTruncated'],
						type: 'object',
					},
					safety: { destructiveHint: true, readOnlyHint: false },
					...(props.definition.metadata?.displayName === undefined
						? {}
						: { title: props.definition.metadata.displayName }),
					...(props.definition.metadata === undefined
						? {}
						: { toolVmCliMetadata: props.definition.metadata }),
				}),
			};
		}
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
	config: GatewayRuntimeManagedToolPortalConfig,
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
