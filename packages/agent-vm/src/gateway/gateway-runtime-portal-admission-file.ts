import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
	GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME,
	GatewayRuntimePortalAdmissionMaterialSchema,
	type GatewayRuntimePortalAdmissionMaterial,
} from '@agent-vm/gateway-control-contracts';

export interface WriteGatewayRuntimePortalAdmissionFileProps {
	readonly directoryPath: string;
	readonly material: GatewayRuntimePortalAdmissionMaterial;
}

export async function loadGatewayRuntimePortalAdmissionFile(
	directoryPath: string,
): Promise<GatewayRuntimePortalAdmissionMaterial> {
	const materialPath = path.join(directoryPath, GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME);
	return GatewayRuntimePortalAdmissionMaterialSchema.parse(
		JSON.parse(await readFile(materialPath, 'utf8')),
	);
}

export async function writeGatewayRuntimePortalAdmissionFile(
	props: WriteGatewayRuntimePortalAdmissionFileProps,
): Promise<void> {
	const material = GatewayRuntimePortalAdmissionMaterialSchema.parse(props.material);
	const destinationPath = path.join(
		props.directoryPath,
		GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME,
	);
	const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
	const temporaryFile = await open(temporaryPath, 'wx', 0o600);
	try {
		await temporaryFile.writeFile(`${JSON.stringify(material, null, '\t')}\n`, 'utf8');
		await temporaryFile.sync();
	} finally {
		await temporaryFile.close();
	}
	try {
		await rename(temporaryPath, destinationPath);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
