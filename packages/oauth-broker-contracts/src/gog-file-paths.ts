/** Resolve CLI-relative file names without rewriting the executable argv. */
export function normalizeGogFileArgument(
	value: string,
	kind: 'file' | 'directory',
): string | undefined {
	if (
		value.length === 0 ||
		value !== value.trim() ||
		value === '-' ||
		value.startsWith('/') ||
		value.startsWith('~') ||
		value.includes('$') ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === '\\',
		)
	)
		return undefined;
	if (kind === 'directory' && (value === '.' || value === './')) return '';
	let relativePath = value.startsWith('./') ? value.slice(2) : value;
	if (kind === 'directory' && relativePath.endsWith('/')) relativePath = relativePath.slice(0, -1);
	const parts = relativePath.split('/');
	const encoder = new TextEncoder();
	if (
		parts.length > 32 ||
		parts.some(
			(part) =>
				part === '' || part === '.' || part === '..' || encoder.encode(part).byteLength > 255,
		)
	)
		return undefined;
	return relativePath;
}
