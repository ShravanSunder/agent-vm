import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const publicationScript = `
import ctypes
import errno
import os
import sys

library = ctypes.CDLL(None, use_errno=True)
if len(sys.argv) == 1:
    getattr(library, "renamex_np" if sys.platform == "darwin" else "renameat2")
    sys.exit(0)
source = os.fsencode(sys.argv[1])
destination = os.fsencode(sys.argv[2])
if sys.platform == "darwin":
    rename_exclusive = library.renamex_np
    rename_exclusive.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename_exclusive.restype = ctypes.c_int
    result = rename_exclusive(source, destination, 4)
elif sys.platform == "linux":
    rename_exclusive = library.renameat2
    rename_exclusive.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename_exclusive.restype = ctypes.c_int
    result = rename_exclusive(-100, source, -100, destination, 1)
else:
    raise RuntimeError("Image publication requires macOS or Linux")
if result != 0:
    error_number = ctypes.get_errno()
    print(errno.errorcode.get(error_number, "EIO"))
    sys.exit(1)
`;

export async function assertImagePublicationSupport(): Promise<void> {
	try {
		await execFileAsync('python3', ['-I', '-c', publicationScript], {
			timeout: 30_000,
			maxBuffer: 16_384,
		});
	} catch (error) {
		throw new Error(
			'Image builds require Python 3 and native no-replace rename support on macOS or Linux.',
			{ cause: error },
		);
	}
}

export async function publishImageDirectory(stagingPath: string, finalPath: string): Promise<void> {
	try {
		await execFileAsync('python3', ['-I', '-c', publicationScript, stagingPath, finalPath], {
			timeout: 30_000,
			maxBuffer: 16_384,
		});
	} catch (error) {
		const errorCode =
			typeof error === 'object' &&
			error !== null &&
			'stdout' in error &&
			typeof error.stdout === 'string'
				? error.stdout.trim()
				: undefined;
		if (errorCode !== undefined && /^E[A-Z0-9]+$/u.test(errorCode)) {
			throw Object.assign(
				new Error(`Atomic image publication failed (${errorCode}) at '${finalPath}'.`, {
					cause: error,
				}),
				{ code: errorCode },
			);
		}
		throw new Error(
			'Atomic image publication requires Python 3 and native no-replace rename support on macOS or Linux.',
			{ cause: error },
		);
	}
}
