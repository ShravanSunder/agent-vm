import type { SystemConfig } from './system-config.js';

export interface DoctorCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly value?: number;
}

export interface RunControllerDoctorOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly nodeVersion: string;
	readonly systemConfig: SystemConfig;
}

export interface ControllerDoctorResult {
	readonly ok: boolean;
	readonly checks: DoctorCheck[];
}

export function runControllerDoctor(options: RunControllerDoctorOptions): ControllerDoctorResult {
	const nodeMajorVersion = Number.parseInt(
		options.nodeVersion.replace(/^v/u, '').split('.')[0] ?? '0',
		10,
	);
	const checks: DoctorCheck[] = [
		{
			name: 'node-version',
			ok: nodeMajorVersion >= 24,
		},
		{
			name: '1password-token',
			ok:
				typeof options.env[options.systemConfig.host.secretsProvider.serviceAccountTokenEnv] ===
				'string',
		},
		{
			name: 'controller-port',
			ok: options.systemConfig.host.controllerPort > 0,
			value: options.systemConfig.host.controllerPort,
		},
	];

	return {
		ok: checks.every((check) => check.ok),
		checks,
	};
}
