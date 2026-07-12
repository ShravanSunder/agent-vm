import { rename, rm, writeFile } from 'node:fs/promises';

interface AtomicFileOperations {
	readonly rename: (temporaryFilePath: string, filePath: string) => Promise<void>;
	readonly rm: (temporaryFilePath: string) => Promise<void>;
	readonly writeFile: (
		temporaryFilePath: string,
		content: string,
		options: { readonly encoding: 'utf8'; readonly mode?: number },
	) => Promise<void>;
}

interface WriteFileAtomicallyOptions {
	readonly fileOperations?: AtomicFileOperations;
	readonly mode?: number;
}

const defaultFileOperations: AtomicFileOperations = {
	rename,
	rm: async (temporaryFilePath) => rm(temporaryFilePath, { force: true }),
	writeFile,
};

export async function writeFileAtomically(
	filePath: string,
	content: string,
	options: WriteFileAtomicallyOptions = {},
): Promise<void> {
	const temporaryFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	const fileOperations = options.fileOperations ?? defaultFileOperations;
	await fileOperations.writeFile(temporaryFilePath, content, {
		encoding: 'utf8',
		...(options.mode ? { mode: options.mode } : {}),
	});
	try {
		await fileOperations.rename(temporaryFilePath, filePath);
	} catch (renameError) {
		try {
			await fileOperations.rm(temporaryFilePath);
		} catch (cleanupError) {
			throw new Error(
				`Failed to replace '${filePath}' (${renameError instanceof Error ? renameError.message : JSON.stringify(renameError)}) and failed to remove temporary file '${temporaryFilePath}': ${cleanupError instanceof Error ? cleanupError.message : JSON.stringify(cleanupError)}`,
				{ cause: cleanupError },
			);
		}
		throw renameError;
	}
}
