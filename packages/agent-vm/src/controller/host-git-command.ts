import { dirname } from 'node:path';

import type { HostGitDir } from './active-task-registry.js';

export function buildHostGitArgs(options: {
	readonly args: readonly string[];
	readonly gitDir: HostGitDir;
}): readonly string[] {
	return [
		'-c',
		'core.hooksPath=/dev/null',
		`--git-dir=${options.gitDir}`,
		// Shared gitdirs store VM worktrees such as /work/repos/widgets.
		// Host-side controller Git needs a host-visible worktree for ref-only commands.
		`--work-tree=${dirname(options.gitDir)}`,
		...options.args,
	];
}
