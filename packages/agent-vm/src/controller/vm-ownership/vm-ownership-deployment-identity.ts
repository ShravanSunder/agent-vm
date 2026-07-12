import path from 'node:path';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import {
	vmOwnershipDeploymentIdentitySchema,
	type VmOwnershipDeploymentIdentity,
} from './vm-ownership-contracts.js';

export function vmOwnershipDeploymentIdentityForSystemConfig(
	systemConfig: LoadedSystemConfig,
): VmOwnershipDeploymentIdentity {
	return vmOwnershipDeploymentIdentitySchema.parse({
		configPath: path.resolve(systemConfig.systemConfigPath),
		controllerPort: systemConfig.host.controllerPort,
		projectNamespace: systemConfig.host.projectNamespace,
	});
}
