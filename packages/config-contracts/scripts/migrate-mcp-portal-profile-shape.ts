#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function namespacePolicy(
	namespaces: Record<string, unknown>,
	namespace: string,
): Record<string, unknown> {
	const existing = recordValue(namespaces[namespace]);
	namespaces[namespace] = existing;
	return existing;
}

function policySection(
	policy: Record<string, unknown>,
	sectionName: 'approval' | 'tools',
): Record<string, unknown> {
	const existing = recordValue(policy[sectionName]);
	policy[sectionName] = existing;
	return existing;
}

function appendUniqueString(
	record: Record<string, unknown>,
	fieldName: string,
	values: readonly string[],
): void {
	const existing = stringArray(record[fieldName]);
	record[fieldName] = Array.from(new Set([...existing, ...values]));
}

function namespaceToolMap(value: unknown): Readonly<Record<string, readonly string[]>> {
	return Object.fromEntries(
		Object.entries(recordValue(value)).map(([namespace, tools]) => [namespace, stringArray(tools)]),
	);
}

function toolRefsByNamespace(value: unknown): Readonly<Record<string, readonly string[]>> {
	const groupedTools: Record<string, string[]> = {};
	for (const entry of Array.isArray(value) ? value : []) {
		if (!isRecord(entry)) {
			continue;
		}
		const namespace = entry.namespace;
		const toolName = entry.toolName;
		if (typeof namespace !== 'string' || typeof toolName !== 'string') {
			continue;
		}
		groupedTools[namespace] = [...(groupedTools[namespace] ?? []), toolName];
	}
	return groupedTools;
}

function migrateProfile(profile: unknown): Record<string, unknown> {
	const profileRecord = recordValue(profile);
	const namespaces = { ...recordValue(profileRecord.namespaces) };
	for (const namespace of stringArray(profileRecord.enabledNamespaces)) {
		namespacePolicy(namespaces, namespace);
	}
	for (const [namespace, toolNames] of Object.entries(
		namespaceToolMap(profileRecord.enabledToolsByNamespace),
	)) {
		const tools = policySection(namespacePolicy(namespaces, namespace), 'tools');
		appendUniqueString(tools, 'enabled', toolNames);
	}
	for (const [namespace, toolNames] of Object.entries(
		namespaceToolMap(profileRecord.hiddenToolsByNamespace),
	)) {
		const tools = policySection(namespacePolicy(namespaces, namespace), 'tools');
		appendUniqueString(tools, 'hidden', toolNames);
	}

	const approval = recordValue(profileRecord.approval);
	for (const [fieldName, legacyFieldName] of [
		['allowWithoutApproval', 'allowWithoutApprovalTools'],
		['alwaysAsk', 'alwaysAskTools'],
		['write', 'writeTools'],
	] as const) {
		for (const [namespace, toolNames] of Object.entries(
			toolRefsByNamespace(approval[legacyFieldName]),
		)) {
			const approvalSection = policySection(namespacePolicy(namespaces, namespace), 'approval');
			appendUniqueString(approvalSection, fieldName, toolNames);
		}
	}
	for (const namespace of stringArray(approval.trustedAnnotationNamespaces)) {
		const approvalSection = policySection(namespacePolicy(namespaces, namespace), 'approval');
		approvalSection.trustedAnnotations = true;
	}

	const migratedProfile: Record<string, unknown> = {};
	if (approval.annotationPolicy !== undefined) {
		migratedProfile.approval = { annotationPolicy: approval.annotationPolicy };
	}
	for (const key of ['promptContext', 'cache', 'logging'] as const) {
		if (profileRecord[key] !== undefined) {
			migratedProfile[key] = profileRecord[key];
		}
	}
	migratedProfile.namespaces = namespaces;
	return migratedProfile;
}

export function migrateMcpPortalProfileShape(config: unknown): Record<string, unknown> {
	const configRecord = recordValue(config);
	const profiles = recordValue(configRecord.profiles);
	return {
		...configRecord,
		profiles: Object.fromEntries(
			Object.entries(profiles).map(([profileName, profile]) => [
				profileName,
				migrateProfile(profile),
			]),
		),
	};
}

async function main(): Promise<void> {
	const configPath = process.argv[2];
	if (configPath === undefined) {
		throw new Error('Usage: migrate-mcp-portal-profile-shape <mcp-portal.config.jsonc>');
	}
	const errors: ParseError[] = [];
	const parsedConfig: unknown = parse(await readFile(configPath, 'utf8'), errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		throw new Error(
			`Could not parse ${configPath}: ${errors.map((error) => printParseErrorCode(error.error)).join(', ')}`,
		);
	}
	await writeFile(
		configPath,
		`${JSON.stringify(migrateMcpPortalProfileShape(parsedConfig), null, '\t')}\n`,
		'utf8',
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
