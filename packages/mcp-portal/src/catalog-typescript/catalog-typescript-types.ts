import type {
	GeneratedToolRuntimeDiagnostic,
	GeneratedToolRuntimeValidation,
	GeneratedToolTyping,
} from '@agent-vm/agent-portal-sdk/generated-tools';

import type { JsonObject } from '../json-schema.js';

export interface NormalizedCatalogToolDefinition {
	readonly inputSchema: JsonObject;
	readonly name: string;
	readonly namespace: string;
}

export interface CompileCatalogTypescriptModulesInput {
	readonly tools: readonly NormalizedCatalogToolDefinition[];
}

export interface CompiledCatalogTypescriptTool {
	readonly diagnostics: readonly GeneratedToolRuntimeDiagnostic[];
	readonly exportedFunctionName: string;
	readonly exportedInputTypeName: string;
	readonly modulePath: string;
	readonly name: string;
	readonly namespace: string;
	readonly runtimeValidation: GeneratedToolRuntimeValidation;
	readonly typing: GeneratedToolTyping;
}

export interface CompiledCatalogTypescriptNamespace {
	readonly exportedFactoryName: string;
	readonly modulePath: string;
	readonly namespace: string;
	readonly tools: readonly CompiledCatalogTypescriptTool[];
}

export interface CompiledCatalogTypescriptManifest {
	readonly definitionFingerprint: string;
	readonly generatorVersion: string;
	readonly namespaces: readonly CompiledCatalogTypescriptNamespace[];
	readonly sdkContractVersion: string;
	readonly tools: readonly CompiledCatalogTypescriptTool[];
}

export interface CompiledCatalogTypescriptFile {
	readonly byteLength: number;
	readonly namespace: string;
	readonly path: string;
	readonly sha256: string;
	readonly source: string;
}

export interface CompiledCatalogTypescriptBundle {
	readonly definitionFingerprint: string;
	readonly files: readonly CompiledCatalogTypescriptFile[];
	readonly manifest: CompiledCatalogTypescriptManifest;
}
