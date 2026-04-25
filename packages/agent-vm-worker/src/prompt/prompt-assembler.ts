import { readFile } from 'node:fs/promises';

import type { SkillReference } from '../shared/skill-types.js';
import { writeStderr } from '../shared/stderr.js';
import {
	DEFAULT_BASE_INSTRUCTIONS,
	resolveRoleInstructions,
	type Role,
} from './prompt-defaults.js';

export interface BuildRoleSystemPromptProps {
	readonly role: Role;
	readonly baseInstructionsOverride: string | null;
	readonly roleInstructionsOverride: string | null;
	readonly branchPrefix: string;
	readonly skills: readonly SkillReference[];
}

async function resolveSkillContent(skills: readonly SkillReference[]): Promise<string> {
	const bodies = await Promise.all(
		skills.map(async (skill): Promise<string | null> => {
			try {
				const content = await readFile(skill.path, 'utf-8');
				return `## Skill: ${skill.name}\n${content}`;
			} catch (error) {
				const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
				if (code === 'ENOENT') {
					writeStderr(
						`[prompt-assembler] Skill not found, skipping: ${skill.name} at ${skill.path}`,
					);
					return null;
				}
				const message = error instanceof Error ? error.message : String(error);
				writeStderr(`[prompt-assembler] Skill load failed (${skill.name}): ${message}`);
				throw new Error(`Skill load failed for "${skill.name}" at "${skill.path}": ${message}`, {
					cause: error,
				});
			}
		}),
	);
	return bodies.filter((body): body is string => body !== null).join('\n\n');
}

export async function buildRoleSystemPrompt(props: BuildRoleSystemPromptProps): Promise<string> {
	const baseTemplate = props.baseInstructionsOverride ?? DEFAULT_BASE_INSTRUCTIONS;
	const baseInstructions = baseTemplate.replaceAll('{branchPrefix}', props.branchPrefix);
	const roleInstructions = resolveRoleInstructions(props.role, props.roleInstructionsOverride);
	const skillContent = await resolveSkillContent(props.skills);

	return [baseInstructions, roleInstructions, skillContent]
		.filter((section) => section.length > 0)
		.join('\n\n---\n\n');
}
