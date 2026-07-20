import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createGondolinManagedVmProvider } = vi.hoisted(() => ({
	createGondolinManagedVmProvider: vi.fn(),
}));
const { configureHostNetworkDefaults } = vi.hoisted(() => ({
	configureHostNetworkDefaults: vi.fn(() => ({
		autoSelectFamily: false as const,
		dnsResultOrder: 'ipv4first' as const,
	})),
}));

vi.mock('@agent-vm/gondolin-vm-adapter', () => ({
	buildImageAssetFileNames: ['disk.raw'],
	configureHostNetworkDefaults,
	createGondolinManagedVmProvider,
	hasBuiltImageAssets: vi.fn(async () => false),
}));

import { createManagedVmRuntimeComposition } from './gondolin-managed-vm-provider.js';

describe('createManagedVmRuntimeComposition', () => {
	beforeEach(() => {
		createGondolinManagedVmProvider.mockReset();
	});

	it('constructs one provider and exposes only its neutral runtime projections', async () => {
		// Arrange
		const factory = { createManagedVm: vi.fn() } satisfies ManagedVmFactory;
		const exactProcessTermination = {
			terminateRecordedHostProcess: vi.fn(),
		} satisfies ManagedVmExactProcessTerminationCapability;
		const images = { prepareImage: vi.fn() } satisfies ManagedVmImageCapability;
		const ownedDirectories = {
			openHostDirectory: vi.fn(),
		} satisfies ManagedVmOwnedDirectoryCapability;
		createGondolinManagedVmProvider.mockReturnValue({
			diagnostics: { checkCompatibility: vi.fn() },
			exactProcessTermination,
			factory,
			images,
			ownedDirectories,
		});

		// Act
		const composition = createManagedVmRuntimeComposition();

		// Assert
		expect(createGondolinManagedVmProvider).toHaveBeenCalledOnce();
		expect(composition).toEqual({
			configureManagedVmHostNetworkDefaults: configureHostNetworkDefaults,
			managedVmExactProcessTermination: exactProcessTermination,
			managedVmFactory: factory,
			managedVmImages: expect.objectContaining({ prepareImage: expect.any(Function) }),
			managedVmOwnedDirectories: ownedDirectories,
		});
		expect(composition.managedVmImages).not.toBe(images);
		await composition.managedVmImages.prepareImage({
			cacheDirectory: '/tmp/missing-managed-vm-image-cache',
			recipePath: '/tmp/gateway-build-config.json',
		});
		expect(images.prepareImage).toHaveBeenCalledOnce();
		expect(Object.keys(composition)).toEqual([
			'configureManagedVmHostNetworkDefaults',
			'managedVmExactProcessTermination',
			'managedVmFactory',
			'managedVmImages',
			'managedVmOwnedDirectories',
		]);
		expect(composition.configureManagedVmHostNetworkDefaults()).toEqual({
			autoSelectFamily: false,
			dnsResultOrder: 'ipv4first',
		});
	});

	it('does not expose the aggregate provider to domain callers', () => {
		// Arrange
		createGondolinManagedVmProvider.mockReturnValue({
			diagnostics: { checkCompatibility: vi.fn() },
			exactProcessTermination: { terminateRecordedHostProcess: vi.fn() },
			factory: { createManagedVm: vi.fn() },
			images: { prepareImage: vi.fn() },
			ownedDirectories: { openHostDirectory: vi.fn() },
		});

		// Act
		const composition = createManagedVmRuntimeComposition();

		// Assert
		// @ts-expect-error The aggregate provider is composition-private.
		void composition.managedVmProvider;
		// @ts-expect-error Diagnostics are projected only by the build boundary.
		void composition.managedVmDiagnostics;
		expect(composition).not.toHaveProperty('managedVmProvider');
	});
});
