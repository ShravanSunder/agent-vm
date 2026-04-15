export function writeStderr(message: string): void {
	process.stderr.write(`${message}\n`);
}
