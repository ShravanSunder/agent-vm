import path from 'node:path';

import { loadJsonConfigFile } from '#node-host/host-configuration/json-config-file';
import {
	nodeHostConfigSchema,
	type NodeHostConfig,
} from '#node-host/host-configuration/models/node-host-config';
import { compileNodeHostCredentialSet } from '#node-host/mcp-proxy-server/bearer-credentials';
import { type NodeHostBearerCredentialSet } from '#node-host/mcp-proxy-server/models/bearer-credentials';

export async function loadNodeHostConfig(configPath: string): Promise<NodeHostConfig> {
	const config = nodeHostConfigSchema.parse(await loadJsonConfigFile(configPath));
	compileNodeHostCredentialSet(config.auth satisfies NodeHostBearerCredentialSet);
	return {
		...config,
		storeDirectory: path.resolve(path.dirname(configPath), config.storeDirectory),
	};
}
