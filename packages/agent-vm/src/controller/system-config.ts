import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

const secretReferenceSchema = z.object({
	source: z.literal('1password'),
	ref: z.string().min(1),
	injection: z.enum(['env', 'http-mediation']).default('env'),
	hosts: z.array(z.string().min(1)).optional(),
});

const tokenSourceSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('op-cli'),
		ref: z.string().min(1),
	}),
	z.object({
		type: z.literal('env'),
		envVar: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal('keychain'),
		service: z.string().min(1),
		account: z.string().min(1),
	}),
]);

const zoneGatewaySchema = z.object({
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	openclawConfig: z.string().min(1),
	stateDir: z.string().min(1),
	workspaceDir: z.string().min(1),
	authProfilesRef: z.string().min(1).optional(),
});

const toolProfileSchema = z.object({
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	workspaceRoot: z.string().min(1),
});

const systemConfigSchema = z.object({
	host: z.object({
		controllerPort: z.number().int().positive(),
		secretsProvider: z.object({
			type: z.literal('1password'),
			tokenSource: tokenSourceSchema,
		}),
	}),
	images: z.object({
		gateway: z.object({
			buildConfig: z.string().min(1),
			postBuild: z.array(z.string()),
		}),
		tool: z.object({
			buildConfig: z.string().min(1),
			postBuild: z.array(z.string()),
		}),
	}),
	zones: z
		.array(
			z.object({
				id: z.string().min(1),
				gateway: zoneGatewaySchema,
				secrets: z.record(z.string(), secretReferenceSchema),
				allowedHosts: z.array(z.string().min(1)).min(1),
				websocketBypass: z.array(z.string().min(1)).default([]),
				toolProfile: z.string().min(1),
			}),
		)
		.min(1, 'system config must define at least one zone'),
	toolProfiles: z.record(z.string(), toolProfileSchema),
	tcpPool: z.object({
		basePort: z.number().int().positive(),
		size: z.number().int().positive(),
	}),
});

export type SystemConfig = z.infer<typeof systemConfigSchema>;

/**
 * Resolve all relative paths in a system config relative to the config file's directory.
 * This ensures paths like "./state/shravan" work regardless of the process CWD.
 */
function resolveRelativePaths(config: SystemConfig, configDir: string): SystemConfig {
	const resolvePath = (relativePath: string): string =>
		path.isAbsolute(relativePath) ? relativePath : path.resolve(configDir, relativePath);

	return {
		...config,
		images: {
			gateway: {
				...config.images.gateway,
				buildConfig: resolvePath(config.images.gateway.buildConfig),
			},
			tool: {
				...config.images.tool,
				buildConfig: resolvePath(config.images.tool.buildConfig),
			},
		},
		zones: config.zones.map((zone) => ({
			...zone,
			gateway: {
				...zone.gateway,
				openclawConfig: resolvePath(zone.gateway.openclawConfig),
				stateDir: resolvePath(zone.gateway.stateDir),
				workspaceDir: resolvePath(zone.gateway.workspaceDir),
			},
		})),
		toolProfiles: Object.fromEntries(
			Object.entries(config.toolProfiles).map(([profileId, profile]) => [
				profileId,
				{ ...profile, workspaceRoot: resolvePath(profile.workspaceRoot) },
			]),
		),
	};
}

export function loadSystemConfig(configPath: string): SystemConfig {
	const absoluteConfigPath = path.resolve(configPath);
	const configDir = path.dirname(absoluteConfigPath);
	const rawConfig = fs.readFileSync(absoluteConfigPath, 'utf8');
	const parsedConfig = JSON.parse(rawConfig) as unknown;
	const config = systemConfigSchema.parse(parsedConfig);
	return resolveRelativePaths(config, configDir);
}
