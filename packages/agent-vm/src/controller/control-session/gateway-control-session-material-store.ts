import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { writeFileAtomically } from '../../shared/write-file-atomically.js';
import {
	deserializeGatewayControlSessionMaterial,
	serializeGatewayControlSessionMaterial,
	serializedGatewayControlSessionMaterialSchema,
	type GatewayControlSessionMaterial,
} from './gateway-control-session.js';

const gatewayControlSessionMaterialFileName = 'session-material.json';

const gatewayControlSessionMaterialRecordSchema = z.strictObject({
	material: serializedGatewayControlSessionMaterialSchema,
	schemaVersion: z.literal(1),
});

type GatewayControlSessionMaterialRecord = z.infer<
	typeof gatewayControlSessionMaterialRecordSchema
>;

function resolveGatewayControlSessionMaterialDirectory(zoneRuntimeDirectory: string): string {
	return path.join(zoneRuntimeDirectory, 'control-sessions', 'gateway');
}

export function resolveGatewayControlSessionMaterialPath(zoneRuntimeDirectory: string): string {
	return path.join(
		resolveGatewayControlSessionMaterialDirectory(zoneRuntimeDirectory),
		gatewayControlSessionMaterialFileName,
	);
}

export async function writeGatewayControlSessionMaterial(
	zoneRuntimeDirectory: string,
	material: GatewayControlSessionMaterial,
): Promise<void> {
	const materialDirectory = resolveGatewayControlSessionMaterialDirectory(zoneRuntimeDirectory);
	const materialPath = resolveGatewayControlSessionMaterialPath(zoneRuntimeDirectory);
	const record: GatewayControlSessionMaterialRecord =
		gatewayControlSessionMaterialRecordSchema.parse({
			material: serializeGatewayControlSessionMaterial(material),
			schemaVersion: 1,
		});

	await fs.mkdir(materialDirectory, { recursive: true });
	await writeFileAtomically(materialPath, `${JSON.stringify(record, null, 2)}\n`, {
		mode: 0o600,
	});
}

export async function loadGatewayControlSessionMaterial(
	zoneRuntimeDirectory: string,
): Promise<GatewayControlSessionMaterial | null> {
	try {
		const rawRecord = await fs.readFile(
			resolveGatewayControlSessionMaterialPath(zoneRuntimeDirectory),
			'utf8',
		);
		const parsedRecord = gatewayControlSessionMaterialRecordSchema.parse(
			JSON.parse(rawRecord) as unknown,
		);
		return deserializeGatewayControlSessionMaterial(parsedRecord.material);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export async function deleteGatewayControlSessionMaterial(
	zoneRuntimeDirectory: string,
): Promise<void> {
	await fs.rm(resolveGatewayControlSessionMaterialPath(zoneRuntimeDirectory), { force: true });
}
