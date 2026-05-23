export function isAbsolutePosixPath(value: string): boolean {
	return value.startsWith('/');
}

export function isRootPosixPath(value: string): boolean {
	return /^\/+$/u.test(value);
}

export function pathContainsParentTraversal(inputPath: string): boolean {
	return inputPath.split(/[\\/]+/u).includes('..');
}
