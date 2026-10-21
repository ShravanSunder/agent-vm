import type { PortalToolRecord } from '#mcp-gateway/agent-catalog-views/models/catalog-types';
import type { ToolIdentity } from '#mcp-gateway/agent-catalog-views/models/tool-identity';

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

export interface GraphTool {
	readonly entityNames: readonly string[];
	readonly inputFields: readonly string[];
	readonly outputFields: readonly string[];
	readonly record: PortalToolRecord;
	readonly ref: ToolRelationshipEndpoint;
}
