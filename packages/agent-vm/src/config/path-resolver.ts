import os from 'node:os';
import path from 'node:path';

/**
 * Resolve a config-style path string to an absolute filesystem path.
 *
 * Three forms:
 *   1. `~` or `~/...` — expanded against `homeDir`
 *   2. absolute (`/...`) — returned unchanged
 *   3. anything else — resolved relative to `configDir`
 *
 * Shared between scaffold-time mkdir (init-command.ts) and runtime
 * config load (system-config.ts) so the two cannot silently drift.
 * Drift produced PR #14: the scaffolder created repo-local dirs while
 * runtime read user-home paths, leaving advertised dirs missing on
 * first boot.
 */
export function resolveConfigPath(
	rawPath: string,
	configDir: string,
	homeDir: string = os.homedir(),
): string {
	if (rawPath === '~') {
		return homeDir;
	}
	if (rawPath.startsWith('~/')) {
		return path.join(homeDir, rawPath.slice(2));
	}
	if (path.isAbsolute(rawPath)) {
		return rawPath;
	}
	return path.resolve(configDir, rawPath);
}
