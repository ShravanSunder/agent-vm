export function buildShellScriptWithArgs(
	script: string,
	args?: readonly string[],
): string {
	if (!args || args.length === 0) {
		return script;
	}

	const escapedArgs = args
		.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
		.join(' ');
	return `set -- ${escapedArgs}; ${script}`;
}
