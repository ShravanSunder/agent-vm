export const phaseNameByConfigKey = {
	plan: 'plan',
	planReview: 'plan-review',
	work: 'work',
	verification: 'verification',
	workReview: 'work-review',
	wrapup: 'wrapup',
} as const;

export const phaseNames = [
	phaseNameByConfigKey.plan,
	phaseNameByConfigKey.planReview,
	phaseNameByConfigKey.work,
	phaseNameByConfigKey.verification,
	phaseNameByConfigKey.workReview,
	phaseNameByConfigKey.wrapup,
] as const;

export const reviewPhaseNames = [
	phaseNameByConfigKey.planReview,
	phaseNameByConfigKey.workReview,
] as const;

export type ConfigPhaseKey = keyof typeof phaseNameByConfigKey;
