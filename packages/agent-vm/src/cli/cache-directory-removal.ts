import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const cacheDirectoryRemovalScript = `
import os
import shutil
import sys

if not shutil.rmtree.avoids_symlink_attacks:
    raise RuntimeError("Cache cleanup requires symlink-resistant directory operations")

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directory_parts = sys.argv[1].split("/")
if directory_parts[0] != "" or any(part in ("", ".", "..") for part in directory_parts[1:]):
    raise ValueError("Cache cleanup requires an absolute normalized target")

parent_descriptor = os.open("/", directory_flags)
target_descriptor = None
try:
    try:
        for directory_part in directory_parts[1:-1]:
            next_descriptor = os.open(directory_part, directory_flags, dir_fd=parent_descriptor)
            os.close(parent_descriptor)
            parent_descriptor = next_descriptor
        target_name = directory_parts[-1]
        target_descriptor = os.open(target_name, directory_flags, dir_fd=parent_descriptor)
    except FileNotFoundError:
        sys.exit(0)
    target_identity = os.fstat(target_descriptor)
    os.fchdir(target_descriptor)
    with os.scandir(".") as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                shutil.rmtree(entry.name)
            else:
                os.unlink(entry.name)
    current_identity = os.stat(target_name, dir_fd=parent_descriptor, follow_symlinks=False)
    if not os.path.samestat(target_identity, current_identity):
        raise RuntimeError("Cache cleanup target changed during deletion")
    os.rmdir(target_name, dir_fd=parent_descriptor)
finally:
    if target_descriptor is not None:
        os.close(target_descriptor)
    os.close(parent_descriptor)
`;

export async function removeDeploymentCacheDirectory(
	cacheDir: string,
	directoryPath: string,
): Promise<void> {
	const relativeTarget = path.relative(cacheDir, directoryPath);
	if (
		!relativeTarget ||
		relativeTarget === '..' ||
		relativeTarget.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeTarget)
	) {
		throw new Error('Unsafe cache cleanup target outside the shared cache.');
	}
	try {
		await execFileAsync(
			'python3',
			['-I', '-c', cacheDirectoryRemovalScript, path.resolve(cacheDir, relativeTarget)],
			{
				maxBuffer: 16_384,
			},
		);
	} catch (error) {
		throw new Error(
			`Safe cache cleanup failed at '${directoryPath}'; Python 3 with symlink-resistant directory operations is required.`,
			{ cause: error },
		);
	}
}
