export const phaseNameByConfigKey = {
	plan: 'plan',
	work: 'work',
	wrapup: 'wrapup',
} as const;

export const phaseNames = [
	phaseNameByConfigKey.plan,
	phaseNameByConfigKey.work,
	phaseNameByConfigKey.wrapup,
] as const;

export type ConfigPhaseKey = keyof typeof phaseNameByConfigKey;
