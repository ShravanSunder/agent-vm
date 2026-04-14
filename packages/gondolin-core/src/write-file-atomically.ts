import fs from 'node:fs/promises';

export async function writeFileAtomically(
	filePath: string,
	content: string,
	options: {
		readonly mode?: number;
	} = {},
): Promise<void> {
	const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryFilePath, content, {
		encoding: 'utf8',
		...(options.mode ? { mode: options.mode } : {}),
	});
	try {
		await fs.rename(temporaryFilePath, filePath);
	} catch (renameError) {
		try {
			await fs.rm(temporaryFilePath, { force: true });
		} catch (cleanupError) {
			throw new Error(
				`Failed to replace '${filePath}' (${renameError instanceof Error ? renameError.message : JSON.stringify(renameError)}) and failed to remove temporary file '${temporaryFilePath}': ${cleanupError instanceof Error ? cleanupError.message : JSON.stringify(cleanupError)}`,
				{ cause: cleanupError },
			);
		}
		throw renameError;
	}
}
