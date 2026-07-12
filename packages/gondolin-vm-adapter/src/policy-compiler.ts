export interface PolicySources {
	readonly base: readonly string[];
	readonly profile: readonly string[];
	readonly extra: readonly string[];
}

export function normalizeHostname(rawHostname: string): string {
	return rawHostname.trim().toLowerCase().replace(/\.+$/u, '');
}

export function dedupeStable(values: readonly string[]): string[] {
	const seenHostnames = new Set<string>();
	const normalizedValues: string[] = [];

	for (const value of values) {
		const normalizedValue = normalizeHostname(value);
		if (normalizedValue.length === 0 || normalizedValue.startsWith('#')) {
			continue;
		}

		if (!seenHostnames.has(normalizedValue)) {
			seenHostnames.add(normalizedValue);
			normalizedValues.push(normalizedValue);
		}
	}

	return normalizedValues;
}

export function compilePolicy(sources: PolicySources): string[] {
	return dedupeStable([...sources.base, ...sources.profile, ...sources.extra]);
}
