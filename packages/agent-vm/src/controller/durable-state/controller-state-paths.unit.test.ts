import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from './controller-state-paths.js';

describe('controller state paths', () => {
	it('preserves an absolute canonical controller state root', () => {
		// Arrange
		const controllerStateDirectoryPath = path.join(path.sep, 'srv', 'agent-vm', 'controller-state');

		// Act
		const controllerStateRoot = createControllerStateRoot({ controllerStateDirectoryPath });

		// Assert
		expect(controllerStateRoot).toEqual({ directoryPath: controllerStateDirectoryPath });
	});

	it('resolves exactly one per-zone gateway child beneath the controller state root', () => {
		// Arrange
		const controllerStateRoot = createControllerStateRoot({
			controllerStateDirectoryPath: path.join(path.sep, 'srv', 'agent-vm', 'controller-state'),
		});

		// Act
		const gatewayStateRoot = resolveControllerGatewayStateRoot({
			controllerStateRoot,
			zoneId: 'zone-a',
		});

		// Assert
		expect(gatewayStateRoot).toEqual({
			directoryPath: path.join(controllerStateRoot.directoryPath, 'zones', 'zone-a'),
			zoneId: 'zone-a',
		});
	});

	it('rejects relative controller state roots', () => {
		// Arrange / Act / Assert
		expect(() =>
			createControllerStateRoot({ controllerStateDirectoryPath: './controller-state' }),
		).toThrow(/absolute/u);
	});

	it('rejects lexically non-canonical absolute controller state roots', () => {
		// Arrange
		const canonicalPrefix = path.join(path.sep, 'srv', 'agent-vm');
		const nonCanonicalControllerStateDirectoryPath = `${canonicalPrefix}${path.sep}..${path.sep}controller-state`;

		// Act / Assert
		expect(() =>
			createControllerStateRoot({
				controllerStateDirectoryPath: nonCanonicalControllerStateDirectoryPath,
			}),
		).toThrow(/canonical/u);
	});

	it('rejects unsafe zone ids before deriving a child path', () => {
		// Arrange
		const controllerStateRoot = createControllerStateRoot({
			controllerStateDirectoryPath: path.join(path.sep, 'srv', 'agent-vm', 'controller-state'),
		});

		// Act / Assert
		expect(() =>
			resolveControllerGatewayStateRoot({ controllerStateRoot, zoneId: '../escape' }),
		).toThrow(/zone id/u);
	});
});
