import {
	getDefaultBuildConfig as getDefaultBuildConfigFromGondolin,
	validateBuildConfig as validateBuildConfigFromGondolin,
	type BuildConfig,
} from '@earendil-works/gondolin';

export * from './build-pipeline.js';
export * from './mount-policy.js';
export * from './policy-compiler.js';
export * from './secret-resolver.js';
export * from './types.js';
export * from './vm-adapter.js';
export * from './volume-manager.js';

export const getDefaultBuildConfig = getDefaultBuildConfigFromGondolin;
export const validateBuildConfig = validateBuildConfigFromGondolin;
export type { BuildConfig };

export function parseBuildConfig(json: string): BuildConfig {
	const parsedJson: unknown = JSON.parse(json);
	if (!validateBuildConfigFromGondolin(parsedJson)) {
		throw new Error('Invalid build config JSON.');
	}
	return parsedJson;
}
