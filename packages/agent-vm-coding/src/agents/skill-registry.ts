export interface SkillDefinition {
	readonly path: string;
	readonly source: 'superpowers' | 'relay-ai' | 'builtin';
}

export const SKILL_NAMES = [
	'writing-plans',
	'brainstorming',
	'test-driven-development',
	'systematic-debugging',
	'verification-before-completion',
	'code-reviewer',
	'silent-failure-hunter',
	'pr-test-analyzer',
	'generic-plan-review',
	'generic-code-review',
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

export const AVAILABLE_SKILLS = {
	'writing-plans': {
		path: '~/.agents/skills/writing-plans/SKILL.md',
		source: 'superpowers',
	},
	brainstorming: {
		path: '~/.agents/skills/brainstorming/SKILL.md',
		source: 'superpowers',
	},
	'test-driven-development': {
		path: '~/.agents/skills/test-driven-development/SKILL.md',
		source: 'superpowers',
	},
	'systematic-debugging': {
		path: '~/.agents/skills/systematic-debugging/SKILL.md',
		source: 'superpowers',
	},
	'verification-before-completion': {
		path: '~/.agents/skills/verification-before-completion/SKILL.md',
		source: 'superpowers',
	},
	'code-reviewer': {
		path: '~/.agents/skills/code-reviewer/SKILL.md',
		source: 'relay-ai',
	},
	'silent-failure-hunter': {
		path: '~/.agents/skills/silent-failure-hunter/SKILL.md',
		source: 'relay-ai',
	},
	'pr-test-analyzer': {
		path: '~/.agents/skills/pr-test-analyzer/SKILL.md',
		source: 'relay-ai',
	},
	'generic-plan-review': {
		path: '~/.agents/skills/generic-plan-review/SKILL.md',
		source: 'builtin',
	},
	'generic-code-review': {
		path: '~/.agents/skills/generic-code-review/SKILL.md',
		source: 'builtin',
	},
} as const satisfies Record<SkillName, SkillDefinition>;

export interface StructuredSkillInput {
	readonly type: 'skill';
	readonly name: SkillName;
	readonly path: string;
}

export function resolveSkillInputs(
	skillNames: readonly SkillName[],
): readonly StructuredSkillInput[] {
	return skillNames.map((name) => ({
		type: 'skill',
		name,
		path: AVAILABLE_SKILLS[name].path,
	}));
}
