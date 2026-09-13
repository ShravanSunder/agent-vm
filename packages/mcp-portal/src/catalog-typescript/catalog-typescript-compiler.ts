import { createHash } from 'node:crypto';

import type {
	GeneratedToolRuntimeDiagnostic,
	GeneratedToolRuntimeValidation,
	GeneratedToolTyping,
} from '@agent-vm/agent-portal-sdk/generated-tools';
import { compile, type JSONSchema } from 'json-schema-to-typescript';

import type { JsonObject, JsonValue } from '../json-schema.js';
import { buildZodValidatorFromJsonSchema } from '../zod-schema-loader.js';
import { createCatalogToolPresentationName } from './catalog-tool-presentation-name.js';
import type {
	CompileCatalogTypescriptModulesInput,
	CompiledCatalogTypescriptBundle,
	CompiledCatalogTypescriptFile,
	CompiledCatalogTypescriptNamespace,
	CompiledCatalogTypescriptTool,
	NormalizedCatalogToolDefinition,
} from './catalog-typescript-types.js';
import { validateDeclarationOnlyTypeFragment } from './declaration-fragment-validation.js';
import { createSafeSchemaProjection } from './safe-schema-projection.js';

export const CatalogTypescriptGeneratorVersion = '2';
export const GeneratedToolsSdkContractVersion = '1';

interface PreparedToolName {
	readonly exportedFunctionName: string;
	readonly exportedInputTypeName: string;
	readonly tool: CanonicalCatalogToolDefinition;
}

interface CanonicalCatalogToolDefinition extends NormalizedCatalogToolDefinition {
	readonly description: string;
}

interface CompiledToolSource extends CompiledCatalogTypescriptTool {
	readonly declarationSource: string;
	readonly definitionConstantName: string;
	readonly inputSchema: JsonObject;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function compareCanonicalText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map(canonicalizeJsonValue);
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}
	return canonicalizeJsonObject(value);
}

function canonicalizeJsonObject(value: JsonObject): JsonObject {
	const canonical: JsonObject = {};
	for (const [key, childValue] of Object.entries(value).toSorted(([leftKey], [rightKey]) =>
		compareCanonicalText(leftKey, rightKey),
	)) {
		Object.defineProperty(canonical, key, {
			configurable: true,
			enumerable: true,
			value: canonicalizeJsonValue(childValue),
			writable: true,
		});
	}
	return canonical;
}

function shortDigest(value: string): string {
	return sha256(value).slice(0, 8);
}

function identifierWords(value: string): readonly string[] {
	return value.match(/[A-Za-z0-9]+/gu)?.map((word) => word.toLowerCase()) ?? [];
}

function pascalIdentifier(value: string, fallback: string): string {
	const words = identifierWords(value);
	const identifier =
		words.length === 0
			? fallback
			: words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join('');
	return /^[A-Za-z_$]/u.test(identifier) ? identifier : `Tool${identifier}`;
}

function camelIdentifier(value: string, fallback: string): string {
	const pascal = pascalIdentifier(value, fallback);
	return `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}`;
}

function capitalizeIdentifier(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function namespaceModulePath(namespace: string): string {
	const readable = identifierWords(namespace).join('-').slice(0, 48) || 'namespace';
	return `${readable}-${shortDigest(namespace)}.ts`;
}

function toolIdentity(tool: NormalizedCatalogToolDefinition): string {
	return JSON.stringify([tool.namespace, tool.name]);
}

function normalizeTools(
	tools: readonly NormalizedCatalogToolDefinition[],
): readonly CanonicalCatalogToolDefinition[] {
	const seenIdentities = new Set<string>();
	return tools
		.map((tool) => ({
			description: tool.description ?? '',
			inputSchema: canonicalizeJsonObject(tool.inputSchema),
			name: tool.name,
			namespace: tool.namespace,
		}))
		.map((tool) => {
			if (tool.namespace.length === 0 || tool.name.length === 0) {
				throw new TypeError('Catalog namespace and tool name must be non-empty.');
			}
			const identity = toolIdentity(tool);
			if (seenIdentities.has(identity)) {
				throw new TypeError(
					`Catalog contains duplicate tool ${JSON.stringify(`${tool.namespace}/${tool.name}`)}.`,
				);
			}
			seenIdentities.add(identity);
			return tool;
		})
		.toSorted((left, right) => compareCanonicalText(toolIdentity(left), toolIdentity(right)));
}

function prepareToolNames(
	tools: readonly CanonicalCatalogToolDefinition[],
): readonly PreparedToolName[] {
	const functionBases = tools.map((tool) => camelIdentifier(tool.name, 'tool'));
	const baseCounts = new Map<string, number>();
	for (const base of functionBases) {
		baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
	}
	return tools.map((tool, index) => {
		const functionBase = functionBases[index] ?? 'tool';
		const hasCollision = (baseCounts.get(functionBase) ?? 0) > 1;
		const exportedFunctionName = hasCollision
			? `${functionBase}${shortDigest(toolIdentity(tool))}`
			: functionBase;
		return {
			exportedFunctionName,
			exportedInputTypeName: `${capitalizeIdentifier(exportedFunctionName)}Input`,
			tool,
		};
	});
}

function createFingerprintInput(
	normalizedTools: readonly CanonicalCatalogToolDefinition[],
): string {
	const toolsByNamespace = Map.groupBy(normalizedTools, (tool) => tool.namespace);
	const mappedTools = [...toolsByNamespace]
		.toSorted(([left], [right]) => compareCanonicalText(left, right))
		.flatMap(([namespace, namespaceTools]) => {
			const modulePath = namespaceModulePath(namespace);
			return prepareToolNames(namespaceTools).map((preparedTool) => ({
				description: preparedTool.tool.description,
				exportedFunctionName: preparedTool.exportedFunctionName,
				exportedInputTypeName: preparedTool.exportedInputTypeName,
				inputSchema: preparedTool.tool.inputSchema,
				modulePath,
				name: preparedTool.tool.name,
				namespace,
				registeredName: createCatalogToolPresentationName(
					preparedTool.tool.namespace,
					preparedTool.tool.name,
				),
			}));
		});
	return JSON.stringify({
		generatorVersion: CatalogTypescriptGeneratorVersion,
		sdkContractVersion: GeneratedToolsSdkContractVersion,
		tools: mappedTools,
	});
}

/** Computes the definition identity without running schema compilation. */
export function fingerprintCatalogTypescriptInput(
	input: CompileCatalogTypescriptModulesInput,
): string {
	return sha256(createFingerprintInput(normalizeTools(input.tools)));
}

function classifyRuntimeValidation(inputSchema: JsonObject): {
	readonly diagnostics: readonly GeneratedToolRuntimeDiagnostic[];
	readonly runtimeValidation: GeneratedToolRuntimeValidation;
} {
	const result = buildZodValidatorFromJsonSchema(inputSchema);
	if (result.ok || result.error.feature === 'conversion_failed') {
		return { diagnostics: [], runtimeValidation: 'local-zod' };
	}
	return {
		diagnostics: [
			{
				feature: result.error.feature,
				kind: 'runtime-validation-unsupported',
				path: result.error.path,
			},
		],
		runtimeValidation: 'portal-only',
	};
}

async function compileToolSource(
	preparedTool: PreparedToolName,
	modulePath: string,
): Promise<CompiledToolSource> {
	const projection = createSafeSchemaProjection(preparedTool.tool.inputSchema);
	const runtime = classifyRuntimeValidation(preparedTool.tool.inputSchema);
	const diagnostics: GeneratedToolRuntimeDiagnostic[] = [
		...projection.diagnostics,
		...runtime.diagnostics,
	];
	let typing: GeneratedToolTyping = 'structurally-derived';
	let declarationSource: string;
	if (projection.diagnostics.length > 0) {
		typing = 'widened';
		declarationSource = `export type ${preparedTool.exportedInputTypeName} = JsonObject;`;
	} else {
		try {
			let generatedTypeNameSequence = 0;
			const candidate = await compile(
				projection.projectedSchema as JSONSchema,
				preparedTool.exportedInputTypeName,
				{
					$refOptions: { resolve: { file: false, http: false } },
					bannerComment: '',
					customName: (schema, keyNameFromDefinition) => {
						const schemaTitle = typeof schema.title === 'string' ? schema.title : undefined;
						const schemaIdentifier = typeof schema.$id === 'string' ? schema.$id : undefined;
						const schemaName = keyNameFromDefinition ?? schemaTitle ?? schemaIdentifier;
						if (schemaName === undefined || schemaName === preparedTool.exportedInputTypeName) {
							return undefined;
						}
						generatedTypeNameSequence += 1;
						return `${preparedTool.exportedInputTypeName}${pascalIdentifier(
							schemaName,
							'Definition',
						)}${shortDigest(String(generatedTypeNameSequence))}`;
					},
					enableConstEnums: false,
					format: false,
					inferStringEnumKeysFromValues: false,
					unknownAny: true,
				},
			);
			const declarationValidation = validateDeclarationOnlyTypeFragment(candidate);
			if (!declarationValidation.ok) {
				typing = 'widened';
				diagnostics.push({
					kind: 'declaration-safety-failed',
					message: declarationValidation.message,
					path: [],
				});
				declarationSource = `export type ${preparedTool.exportedInputTypeName} = JsonObject;`;
			} else {
				declarationSource = candidate.trim();
			}
		} catch (error) {
			typing = 'widened';
			diagnostics.push({
				kind: 'static-conversion-failed',
				message: error instanceof Error ? error.message : String(error),
				path: [],
			});
			declarationSource = `export type ${preparedTool.exportedInputTypeName} = JsonObject;`;
		}
	}

	return {
		declarationSource,
		definitionConstantName: `${preparedTool.exportedFunctionName}Definition`,
		diagnostics,
		exportedFunctionName: preparedTool.exportedFunctionName,
		exportedInputTypeName: preparedTool.exportedInputTypeName,
		inputSchema: preparedTool.tool.inputSchema,
		modulePath,
		name: preparedTool.tool.name,
		namespace: preparedTool.tool.namespace,
		runtimeValidation: runtime.runtimeValidation,
		typing,
	};
}

function renderNamespaceSource(props: {
	readonly exportedFactoryName: string;
	readonly exportedToolsTypeName: string;
	readonly tools: readonly CompiledToolSource[];
}): string {
	const declarations = props.tools.map((tool) => tool.declarationSource).join('\n\n');
	const definitions = props.tools
		.map(
			(tool) =>
				`const ${tool.definitionConstantName} = ${JSON.stringify(
					{
						diagnostics: tool.diagnostics,
						inputSchema: tool.inputSchema,
						name: tool.name,
						namespace: tool.namespace,
						runtimeValidation: tool.runtimeValidation,
						typing: tool.typing,
					},
					null,
					'\t',
				)} as const satisfies GeneratedToolDefinition;`,
		)
		.join('\n\n');
	const functionMembers = props.tools
		.map(
			(tool) =>
				`\treadonly ${tool.exportedFunctionName}: GeneratedToolFunction<${tool.exportedInputTypeName}>;`,
		)
		.join('\n');
	const bindings = props.tools
		.map(
			(tool) =>
				`\t\t${tool.exportedFunctionName}: createGeneratedToolFunction<${tool.exportedInputTypeName}>(client, ${tool.definitionConstantName}),`,
		)
		.join('\n');

	return `${[
		'// Generated by @agent-vm/mcp-portal catalog-typescript. Do not edit.',
		"import { createGeneratedToolFunction, type GeneratedToolDefinition, type GeneratedToolFunction, type JsonObject, type ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/generated-tools';",
		'',
		declarations,
		'',
		definitions,
		'',
		`export interface ${props.exportedToolsTypeName} {`,
		functionMembers,
		'}',
		'',
		`export function ${props.exportedFactoryName}(client: ToolPortalMcpClient): ${props.exportedToolsTypeName} {`,
		'\treturn {',
		bindings,
		'\t};',
		'}',
		'',
	].join('\n')}\n`;
}

async function compileNamespaceEntry(
	entry: readonly [string, CanonicalCatalogToolDefinition[]],
): Promise<{
	readonly file: CompiledCatalogTypescriptFile;
	readonly namespace: CompiledCatalogTypescriptNamespace;
}> {
	const [namespace, namespaceTools] = entry;
	const modulePath = namespaceModulePath(namespace);
	const preparedTools = prepareToolNames(namespaceTools);
	const toolSources = await Promise.all(
		preparedTools.map((preparedTool) => compileToolSource(preparedTool, modulePath)),
	);
	const namespaceIdentifier = pascalIdentifier(namespace, 'Namespace');
	const exportedFactoryName = `bind${namespaceIdentifier}Tools`;
	const exportedToolsTypeName = `${namespaceIdentifier}Tools`;
	const source = renderNamespaceSource({
		exportedFactoryName,
		exportedToolsTypeName,
		tools: toolSources,
	});
	const publicTools = toolSources.map(
		({
			declarationSource: _declarationSource,
			definitionConstantName: _constant,
			inputSchema: _schema,
			...tool
		}) => tool,
	);
	return {
		file: {
			byteLength: Buffer.byteLength(source),
			namespace,
			path: modulePath,
			sha256: sha256(source),
			source,
		},
		namespace: {
			exportedFactoryName,
			modulePath,
			namespace,
			tools: publicTools,
		},
	};
}

export async function compileCatalogTypescriptModules(
	input: CompileCatalogTypescriptModulesInput,
): Promise<CompiledCatalogTypescriptBundle> {
	const normalizedTools = normalizeTools(input.tools);
	const toolsByNamespace = Map.groupBy(normalizedTools, (tool) => tool.namespace);
	const compiledNamespaces = await Promise.all(
		[...toolsByNamespace]
			.toSorted(([left], [right]) => compareCanonicalText(left, right))
			.map(compileNamespaceEntry),
	);
	const files = compiledNamespaces.map((entry) => entry.file);
	const namespaces = compiledNamespaces.map((entry) => entry.namespace);
	const compiledTools = namespaces.flatMap((namespace) => namespace.tools);

	const definitionFingerprint = sha256(createFingerprintInput(normalizedTools));
	return {
		definitionFingerprint,
		files,
		manifest: {
			definitionFingerprint,
			generatorVersion: CatalogTypescriptGeneratorVersion,
			namespaces,
			sdkContractVersion: GeneratedToolsSdkContractVersion,
			tools: compiledTools,
		},
		nativeTools: normalizedTools
			.map((tool) => ({
				description: tool.description,
				inputSchema: tool.inputSchema,
				namespace: tool.namespace,
				registeredName: createCatalogToolPresentationName(tool.namespace, tool.name),
				toolName: tool.name,
			}))
			.toSorted((left, right) => compareCanonicalText(left.registeredName, right.registeredName)),
	};
}
