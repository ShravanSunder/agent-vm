import type { ControllerExecutionOperation } from '@agent-vm/config-contracts';

import { ConfiguredControllerExecutionError } from './configured-controller-execution-error.js';

type ConfiguredCliEnvironmentPolicy = Extract<
	ControllerExecutionOperation,
	{ readonly kind: 'configured_cli' }
>['executionTarget']['environment'];

export function resolveConfiguredCliEnvironment(
	policy: ConfiguredCliEnvironmentPolicy,
): Readonly<Record<string, string>> {
	if (policy.kind === 'empty') return {};
	const environmentEntries = policy.names.map((name): readonly [string, string] => {
		const value = process.env[name];
		if (value === undefined) {
			throw new ConfiguredControllerExecutionError(
				'validation_failed',
				`Configured CLI inherited environment value '${name}' is unavailable.`,
			);
		}
		return [name, value];
	});
	return Object.fromEntries(environmentEntries);
}
