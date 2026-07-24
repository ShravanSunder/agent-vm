import { describe, expect, it } from 'vitest';

import { computeEffectiveBuildFingerprint } from './build-pipeline.js';
import {
	renderManagedGatewayRootfsInitScript,
	resolveRootfsInitExtra,
} from './rootfs-init-extra.js';

describe('managed Gateway rootfs init projection', () => {
	it.each([
		['openclaw-framework-service', '/usr/local/bin/openclaw gateway --port 18789'],
		['hermes-framework-service', '/usr/local/bin/agent-vm-hermes-gateway'],
	] as const)(
		'starts the fixed Tool Portal and %s roles without a resident launcher',
		(frameworkBootEntry, expectedFrameworkCommand) => {
			// Arrange
			const bootProjection = {
				frameworkBootEntry,
				kind: 'managed-gateway-exact-two-role',
			} as const;

			// Act
			const script = renderManagedGatewayRootfsInitScript(bootProjection);

			// Assert
			expect(script.match(/agent-vm-gateway-runtime --config/gu)).toHaveLength(1);
			expect(script.match(new RegExp(expectedFrameworkCommand, 'gu'))).toHaveLength(1);
			expect(script.match(/&\n/gu)).toHaveLength(2);
			expect(script).toContain('exec /usr/local/bin/agent-vm-gateway-runtime');
			expect(script).toContain(`exec ${expectedFrameworkCommand}`);
			expect(script).not.toMatch(/\b(wait|restart|supervis|childRecipe|services\[)\b/iu);
			expect(script).not.toContain('ManagedVm.exec');
			expect(script).toContain(
				'managed_gateway_environment_input_root=/run/agent-vm/managed-gateway-environment',
			);
			expect(script).toContain(
				'managed_gateway_structured_input_root=/run/agent-vm/managed-gateway',
			);
			expect(script).not.toMatch(/--reuid|--regid|--init-groups/u);
			expect(script.match(/exec \/bin\/sh -c 'set -a;/gu)).toHaveLength(2);
			expect(script).not.toContain('exec su ');
			expect(script).toContain(
				'. /run/agent-vm/managed-gateway-environment/tool-portal.environment.sh || exit 78',
			);
			expect(script).toContain(
				'rm -- /run/agent-vm/managed-gateway-environment/tool-portal.environment.sh || exit 78',
			);
			expect(script).toContain(
				'. /run/agent-vm/managed-gateway-environment/framework.environment.sh || exit 78',
			);
			expect(script).toContain(
				'rm -- /run/agent-vm/managed-gateway-environment/framework.environment.sh || exit 78',
			);
			if (frameworkBootEntry === 'openclaw-framework-service') {
				expect(script).not.toContain('framework-service.json config.yaml');
			}
			expect(script).toContain('install -d -m 0700 /run/agent-vm/gateway-runtime');
			expect(script).not.toMatch(/\b(cp|install)\b[^\n]*managed-gateway/gu);
			expect(script).not.toContain('managed_gateway_input_staging_root');
			expect(script.indexOf('. /run/agent-vm/managed-gateway-environment/')).toBeLessThan(
				script.indexOf('rm -- /run/agent-vm/managed-gateway-environment/'),
			);
			expect(script.indexOf('rm -- /run/agent-vm/managed-gateway-environment/')).toBeLessThan(
				script.indexOf('exec /usr/local/bin/agent-vm-gateway-runtime'),
			);
		},
	);

	it('fingerprints the exact managed pair and rejects deployment-authored init authority', async () => {
		// Arrange
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		} as const;

		// Act
		const openClaw = await resolveRootfsInitExtra({
			buildConfig,
			managedGatewayBoot: {
				frameworkBootEntry: 'openclaw-framework-service',
				kind: 'managed-gateway-exact-two-role',
			},
		});
		const hermes = await resolveRootfsInitExtra({
			buildConfig,
			managedGatewayBoot: {
				frameworkBootEntry: 'hermes-framework-service',
				kind: 'managed-gateway-exact-two-role',
			},
		});

		// Assert
		expect(openClaw.content).not.toBe(hermes.content);
		expect(openClaw.fingerprintInput).not.toEqual(hermes.fingerprintInput);
		const [openClawFingerprint, hermesFingerprint] = await Promise.all([
			computeEffectiveBuildFingerprint({
				buildConfig,
				gondolinVersion: 'gondolin@managed-gateway-test',
				managedGatewayBoot: {
					frameworkBootEntry: 'openclaw-framework-service',
					kind: 'managed-gateway-exact-two-role',
				},
			}),
			computeEffectiveBuildFingerprint({
				buildConfig,
				gondolinVersion: 'gondolin@managed-gateway-test',
				managedGatewayBoot: {
					frameworkBootEntry: 'hermes-framework-service',
					kind: 'managed-gateway-exact-two-role',
				},
			}),
		]);
		expect(openClawFingerprint.fingerprint).not.toBe(hermesFingerprint.fingerprint);
		await expect(
			resolveRootfsInitExtra({
				buildConfig: {
					...buildConfig,
					init: { rootfsInitExtra: '/tmp/deployment-authored.sh' },
				},
				managedGatewayBoot: {
					frameworkBootEntry: 'openclaw-framework-service',
					kind: 'managed-gateway-exact-two-role',
				},
			}),
		).rejects.toThrow('cannot compose deployment-authored rootfs init');
	});

	it('leaves Worker and other direct VM images free of managed Gateway roles', async () => {
		// Act
		const resolved = await resolveRootfsInitExtra({
			buildConfig: { arch: 'aarch64', distro: 'alpine' },
		});

		// Assert
		expect(resolved.content).not.toContain('agent-vm-gateway-runtime');
		expect(resolved.content).not.toContain('openclaw gateway');
		expect(resolved.content).not.toContain('agent-vm-hermes-gateway');
	});
});
