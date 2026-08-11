import path from 'node:path';

import { zoneIdSchema } from '../../config/system-config-identifier-schemas.js';

export interface ControllerStateRoot {
	readonly directoryPath: string;
}

export interface ControllerGatewayStateRoot {
	readonly directoryPath: string;
	readonly zoneId: string;
}

export function createControllerStateRoot(options: {
	readonly controllerStateDirectoryPath: string;
}): ControllerStateRoot {
	if (!path.isAbsolute(options.controllerStateDirectoryPath)) {
		throw new Error('Controller state root must be an absolute canonical path.');
	}
	if (
		path.normalize(options.controllerStateDirectoryPath) !== options.controllerStateDirectoryPath
	) {
		throw new Error('Controller state root must be a lexically canonical path.');
	}
	return Object.freeze({ directoryPath: options.controllerStateDirectoryPath });
}

export function resolveControllerGatewayStateRoot(options: {
	readonly controllerStateRoot: ControllerStateRoot;
	readonly zoneId: string;
}): ControllerGatewayStateRoot {
	const zoneId = zoneIdSchema.parse(options.zoneId);
	return Object.freeze({
		directoryPath: path.join(options.controllerStateRoot.directoryPath, 'zones', zoneId),
		zoneId,
	});
}
