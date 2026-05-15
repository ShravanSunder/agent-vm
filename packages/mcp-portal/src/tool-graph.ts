import { portalToolRecordSchema, type PortalToolRecord } from './catalog-types.js';
import type { JsonObject } from './json-schema.js';
import { encodeToolRef, type ToolIdentity } from './tool-ref.js';

export type ToolRelationshipType = 'entity' | 'schema-field' | 'skill';

export interface ToolRelationshipEndpoint extends ToolIdentity {
	readonly toolRef: string;
}

export interface ToolRelationship {
	readonly field?: string;
	readonly from: ToolRelationshipEndpoint;
	readonly reason: string;
	readonly to: ToolRelationshipEndpoint;
	readonly type: ToolRelationshipType;
}

export interface SkillGraphInput {
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly title: string;
	readonly toolRefs: readonly string[];
}

export interface ScopedSkillGraphEntry {
	readonly description?: string;
	readonly tags: readonly string[];
	readonly title: string;
	readonly toolRefs: readonly string[];
}

export interface ToolGraphInput {
	readonly skills?: readonly SkillGraphInput[];
	readonly tools: readonly PortalToolRecord[];
}

export interface ToolGraph {
	readonly relationships: readonly ToolRelationship[];
	readonly skills: readonly ScopedSkillGraphEntry[];
}

interface GraphTool {
	readonly entityNames: readonly string[];
	readonly inputFields: readonly string[];
	readonly outputFields: readonly string[];
	readonly record: PortalToolRecord;
	readonly ref: ToolRelationshipEndpoint;
}

const genericLinkFields = new Set(['id', 'name', 'title', 'url', 'uri']);

function compareCodePoint(left: string, right: string): number {
	if (left < right) {
		return -1;
	}
	if (left > right) {
		return 1;
	}
	return 0;
}

function objectPropertiesFromSchema(schema: JsonObject | undefined): readonly string[] {
	if (!schema) {
		return [];
	}

	const properties = schema.properties;
	if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
		return [];
	}

	return Object.keys(properties).toSorted();
}

function collectEntityNames(schema: JsonObject | undefined): readonly string[] {
	if (!schema) {
		return [];
	}

	const names: string[] = [];
	const schemaId = schema.$id;
	const title = schema.title;
	const entityName = schema.entityName;
	if (typeof schemaId === 'string' && schemaId.length > 0) {
		names.push(schemaId);
	}
	if (typeof title === 'string' && title.length > 0) {
		names.push(title);
	}
	if (typeof entityName === 'string' && entityName.length > 0) {
		names.push(entityName);
	}

	return names.map((name) => name.toLowerCase()).toSorted();
}

function createGraphTool(tool: PortalToolRecord): GraphTool {
	const record = portalToolRecordSchema.parse(tool);
	const toolRef = encodeToolRef({ namespace: record.namespace, toolName: record.toolName });

	return {
		entityNames: [
			...collectEntityNames(record.inputSchema),
			...collectEntityNames(record.outputSchema),
		].toSorted(),
		inputFields: objectPropertiesFromSchema(record.inputSchema),
		outputFields: objectPropertiesFromSchema(record.outputSchema),
		record,
		ref: {
			namespace: record.namespace,
			toolName: record.toolName,
			toolRef,
		},
	};
}

function sharesEntity(left: GraphTool, right: GraphTool): boolean {
	const rightEntities = new Set(right.entityNames);
	return left.entityNames.some((entityName) => rightEntities.has(entityName));
}

function shouldLinkField(field: string, fromTool: GraphTool, toTool: GraphTool): boolean {
	if (!genericLinkFields.has(field.toLowerCase())) {
		return true;
	}

	return fromTool.record.namespace === toTool.record.namespace && sharesEntity(fromTool, toTool);
}

function createSchemaRelationships(tools: readonly GraphTool[]): readonly ToolRelationship[] {
	const relationships: ToolRelationship[] = [];

	for (const fromTool of tools) {
		for (const toTool of tools) {
			if (fromTool.ref.toolRef === toTool.ref.toolRef) {
				continue;
			}

			const inputFields = new Set(toTool.inputFields);
			for (const field of fromTool.outputFields) {
				if (!inputFields.has(field) || !shouldLinkField(field, fromTool, toTool)) {
					continue;
				}

				relationships.push({
					field,
					from: fromTool.ref,
					reason: `Output field "${field}" matches input field "${field}".`,
					to: toTool.ref,
					type: 'schema-field',
				});
			}
		}
	}

	return relationships;
}

function createEntityRelationships(tools: readonly GraphTool[]): readonly ToolRelationship[] {
	const relationships: ToolRelationship[] = [];
	for (const fromTool of tools) {
		for (const toTool of tools) {
			if (fromTool.ref.toolRef === toTool.ref.toolRef || !sharesEntity(fromTool, toTool)) {
				continue;
			}

			relationships.push({
				from: fromTool.ref,
				reason: 'Tools declare a shared schema entity through title, $id, or entityName.',
				to: toTool.ref,
				type: 'entity',
			});
		}
	}
	return relationships;
}

function createSkillEntries(
	skills: readonly SkillGraphInput[],
	allowedToolRefs: ReadonlySet<string>,
): readonly ScopedSkillGraphEntry[] {
	const entries: ScopedSkillGraphEntry[] = [];
	for (const skill of skills) {
		const scopedToolRefs = skill.toolRefs
			.filter((toolRef) => allowedToolRefs.has(toolRef))
			.toSorted();
		if (scopedToolRefs.length === 0) {
			continue;
		}

		entries.push({
			...(skill.description !== undefined ? { description: skill.description } : {}),
			tags: [...(skill.tags ?? [])].toSorted(),
			title: skill.title,
			toolRefs: scopedToolRefs,
		});
	}

	return entries.toSorted((left, right) => left.title.localeCompare(right.title));
}

function createSkillRelationships(
	skills: readonly ScopedSkillGraphEntry[],
	toolsByRef: ReadonlyMap<string, GraphTool>,
): readonly ToolRelationship[] {
	const relationships: ToolRelationship[] = [];
	for (const skill of skills) {
		for (const fromToolRef of skill.toolRefs) {
			for (const toToolRef of skill.toolRefs) {
				if (fromToolRef === toToolRef) {
					continue;
				}
				const fromTool = toolsByRef.get(fromToolRef);
				const toTool = toolsByRef.get(toToolRef);
				if (!fromTool || !toTool) {
					continue;
				}

				relationships.push({
					from: fromTool.ref,
					reason: `Both tools are referenced by skill "${skill.title}".`,
					to: toTool.ref,
					type: 'skill',
				});
			}
		}
	}
	return relationships;
}

function compareRelationships(left: ToolRelationship, right: ToolRelationship): number {
	const typeOrder = compareCodePoint(left.type, right.type);
	if (typeOrder !== 0) {
		return typeOrder;
	}

	const targetOrder = compareCodePoint(left.to.toolRef, right.to.toolRef);
	if (targetOrder !== 0) {
		return targetOrder;
	}

	return compareCodePoint(left.from.toolRef, right.from.toolRef);
}

export function buildToolGraph(input: ToolGraphInput): ToolGraph {
	const tools = input.tools
		.map((tool) => createGraphTool(tool))
		.toSorted((left, right) => compareCodePoint(left.ref.toolRef, right.ref.toolRef));
	const allowedToolRefs = new Set(tools.map((tool) => tool.ref.toolRef));
	const skills = createSkillEntries(input.skills ?? [], allowedToolRefs);
	const toolsByRef = new Map(tools.map((tool) => [tool.ref.toolRef, tool]));

	return {
		relationships: [
			...createEntityRelationships(tools),
			...createSchemaRelationships(tools),
			...createSkillRelationships(skills, toolsByRef),
		].toSorted(compareRelationships),
		skills,
	};
}
