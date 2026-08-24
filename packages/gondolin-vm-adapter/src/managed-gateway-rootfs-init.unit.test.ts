import { describe, expect, it } from 'vitest';

import { computeEffectiveBuildFingerprint } from './build-pipeline.js';
import {
	renderManagedGatewayRootfsInitScript,
	resolveRootfsInitExtra,
} from './rootfs-init-extra.js';

describe('managed Gateway rootfs init projection', () => {
	it('starts the fixed Tool Portal and Hermes roles without a resident launcher', () => {
		// Arrange
		const bootProjection = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} as const;
		const expectedFrameworkCommand = '/usr/local/bin/agent-vm-hermes-gateway';

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
		expect(script).toContain('managed_gateway_structured_input_root=/run/agent-vm/managed-gateway');
		expect(script).not.toMatch(/--reuid|--regid|--init-groups/u);
		expect(script).not.toContain('exec su ');
		expect(script).not.toMatch(/entrypoint-dispatch|s6-setuidgid/u);
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
		expect(script).not.toContain('framework-service.json config.yaml');
		expect(script).toContain('install -d -m 0700 /run/agent-vm/gateway-runtime');
		expect(script).not.toMatch(/\b(cp|install)\b[^\n]*managed-gateway/gu);
		expect(script).not.toContain('managed_gateway_input_staging_root');
		expect(script.indexOf('. /run/agent-vm/managed-gateway-environment/')).toBeLessThan(
			script.indexOf('rm -- /run/agent-vm/managed-gateway-environment/'),
		);
		expect(script.indexOf('rm -- /run/agent-vm/managed-gateway-environment/')).toBeLessThan(
			script.indexOf('exec /usr/local/bin/agent-vm-gateway-runtime'),
		);
	});

	it('isolates both Hermes sibling service environments from Gateway VM bootstrap values', () => {
		// Arrange
		const bootProjection = {
			frameworkBootEntry: 'hermes-framework-service',
			kind: 'managed-gateway-exact-two-role',
		} as const;

		// Act
		const script = renderManagedGatewayRootfsInitScript(bootProjection);

		// Assert
		expect([...script.matchAll(/exec \/usr\/bin\/env -i \/bin\/sh -c 'set -a;/gu)]).toHaveLength(2);
		expect(script).not.toContain('exec /bin/sh -c');
	});

	it('fingerprints the exact managed pair and rejects deployment-authored init authority', async () => {
		// Arrange
		const buildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
		} as const;

		// Act
		const hermes = await resolveRootfsInitExtra({
			buildConfig,
			managedGatewayBoot: {
				frameworkBootEntry: 'hermes-framework-service',
				kind: 'managed-gateway-exact-two-role',
			},
		});
		const unmanaged = await resolveRootfsInitExtra({ buildConfig });

		// Assert
		expect(unmanaged.content).not.toBe(hermes.content);
		expect(unmanaged.fingerprintInput).not.toEqual(hermes.fingerprintInput);
		const [unmanagedFingerprint, hermesFingerprint] = await Promise.all([
			computeEffectiveBuildFingerprint({
				buildConfig,
				gondolinVersion: 'gondolin@managed-gateway-test',
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
		expect(unmanagedFingerprint.fingerprint).not.toBe(hermesFingerprint.fingerprint);
		await expect(
			resolveRootfsInitExtra({
				buildConfig: {
					...buildConfig,
					init: { rootfsInitExtra: '/tmp/deployment-authored.sh' },
				},
				managedGatewayBoot: {
					frameworkBootEntry: 'hermes-framework-service',
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
