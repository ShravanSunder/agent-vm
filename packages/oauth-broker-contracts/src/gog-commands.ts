import { z } from 'zod';

import { normalizeGogFileArgument } from './gog-file-paths.js';
import { googleOperationRequirementsSchema } from './google-account-policy-contracts.js';

export const googleCatalogFamilyIdSchema = z.enum(['communications', 'documents', 'youtube']);
export type GoogleCatalogFamilyId = z.infer<typeof googleCatalogFamilyIdSchema>;

const flagBaseSchema = z.object({
	name: z.string().regex(/^--[a-z][a-z0-9-]*$/u),
	aliases: z.array(z.string().regex(/^--?[a-z][a-z0-9-]*$/u)).readonly(),
	required: z.boolean(),
});
export const gogCommandFlagSchema = z.discriminatedUnion('kind', [
	flagBaseSchema.extend({ kind: z.literal('switch') }).strict(),
	flagBaseSchema.extend({ kind: z.literal('text') }).strict(),
	flagBaseSchema
		.extend({
			kind: z.literal('file-path'),
			direction: z.enum(['input', 'output']),
			pathKind: z.enum(['file', 'directory']),
		})
		.strict(),
	flagBaseSchema
		.extend({ kind: z.literal('integer'), minimum: z.number().int(), maximum: z.number().int() })
		.strict(),
	flagBaseSchema
		.extend({ kind: z.literal('choice'), choices: z.array(z.string()).min(1).readonly() })
		.strict(),
]);

export const gogCommandDescriptorSchema = z
	.object({
		operationId: z.string().min(1).max(128),
		familyId: googleCatalogFamilyIdSchema,
		paths: z
			.array(
				z
					.array(z.string().regex(/^[a-z][a-z0-9-]*$/u))
					.min(2)
					.max(5)
					.readonly(),
			)
			.min(1)
			.readonly(),
		requirements: googleOperationRequirementsSchema,
		sendsMail: z.boolean(),
		positionals: z
			.object({
				minimum: z.number().int().nonnegative(),
				maximum: z.number().int().nonnegative().max(128),
				fileInputs: z.array(z.number().int().nonnegative().max(127)).max(128).readonly().optional(),
			})
			.strict(),
		flags: z.array(gogCommandFlagSchema).readonly(),
	})
	.strict();
export type GogCommandDescriptorInput = z.input<typeof gogCommandDescriptorSchema>;
export type GogCommandDescriptor = z.infer<typeof gogCommandDescriptorSchema>;
export interface GogFileArguments {
	readonly inputs: readonly string[];
	readonly outputs: readonly {
		readonly relativePath: string;
		readonly kind: 'file' | 'directory';
	}[];
}
export type GogOperationResolution =
	| { readonly kind: 'no-oauth' }
	| { readonly kind: 'denied' }
	| {
			readonly kind: 'oauth';
			readonly operationId: string;
			readonly familyId: GoogleCatalogFamilyId;
			readonly requirements: GogCommandDescriptor['requirements'];
			readonly sendsMail: boolean;
			readonly files?: GogFileArguments;
	  };

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
	return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function flagsForDescriptor(
	descriptor: GogCommandDescriptor,
): ReadonlyMap<string, z.infer<typeof gogCommandFlagSchema>> {
	const flags = new Map<string, z.infer<typeof gogCommandFlagSchema>>();
	for (const flag of descriptor.flags) {
		if (flag.kind === 'file-path' && flag.direction === 'output' && !flag.required)
			throw new Error('Gog file outputs require an explicit destination.');
		if (flag.kind === 'file-path' && flag.direction === 'input' && flag.pathKind !== 'file')
			throw new Error('Gog input directories are not admitted.');
		if (flag.kind === 'integer' && flag.minimum > flag.maximum)
			throw new Error('Gog integer flag bounds are invalid.');
		for (const spelling of [flag.name, ...flag.aliases]) {
			if (flags.has(spelling)) throw new Error('Gog flag spellings must be unique.');
			flags.set(spelling, flag);
		}
	}
	return flags;
}

function flagValueIsValid(
	flag: z.infer<typeof gogCommandFlagSchema>,
	value: string | undefined,
): boolean {
	if (flag.kind === 'switch') return value === undefined || value === 'true';
	if (value === undefined || value.startsWith('-') || (flag.required && value.trim().length === 0))
		return false;
	if (flag.kind === 'text') return true;
	if (flag.kind === 'file-path')
		return normalizeGogFileArgument(value, flag.pathKind) !== undefined;
	if (flag.kind === 'choice') return flag.choices.includes(value);
	return (
		/^(0|[1-9][0-9]*)$/u.test(value) &&
		Number.isSafeInteger(Number(value)) &&
		Number(value) >= flag.minimum &&
		Number(value) <= flag.maximum
	);
}

function resolveFileArguments(props: {
	readonly argv: readonly string[];
	readonly descriptor: GogCommandDescriptor;
	readonly flags: ReadonlyMap<string, z.infer<typeof gogCommandFlagSchema>>;
}): GogFileArguments | undefined {
	const seenFlags = new Set<string>();
	const inputs = new Set<string>();
	const outputs: { relativePath: string; kind: 'file' | 'directory' }[] = [];
	let positionalCount = 0;
	let literalsOnly = false;
	for (let index = 0; index < props.argv.length; index++) {
		const token = props.argv[index];
		if (token === undefined) return undefined;
		if (!literalsOnly && token === '--') {
			literalsOnly = true;
			continue;
		}
		if (literalsOnly || !token.startsWith('-')) {
			if (token.trim().length === 0) return undefined;
			if (props.descriptor.positionals.fileInputs?.includes(positionalCount)) {
				const relativePath = normalizeGogFileArgument(token, 'file');
				if (relativePath === undefined) return undefined;
				inputs.add(relativePath);
			}
			positionalCount++;
			continue;
		}
		const separatorIndex = token.indexOf('=');
		const flagName = separatorIndex === -1 ? token : token.slice(0, separatorIndex);
		const flag = props.flags.get(flagName);
		if (flag === undefined || seenFlags.has(flag.name)) return undefined;
		seenFlags.add(flag.name);
		let value = separatorIndex === -1 ? undefined : token.slice(separatorIndex + 1);
		if (flag.kind !== 'switch' && separatorIndex === -1) value = props.argv[++index];
		if (!flagValueIsValid(flag, value)) return undefined;
		if (flag.kind === 'file-path') {
			const relativePath = normalizeGogFileArgument(value ?? '', flag.pathKind);
			if (relativePath === undefined) return undefined;
			if (flag.direction === 'input') inputs.add(relativePath);
			else outputs.push({ relativePath, kind: flag.pathKind });
		}
	}
	const valid =
		positionalCount >= props.descriptor.positionals.minimum &&
		positionalCount <= props.descriptor.positionals.maximum &&
		props.descriptor.flags.every((flag) => !flag.required || seenFlags.has(flag.name));
	return valid ? { inputs: [...inputs], outputs } : undefined;
}

export function createGogOperationResolver(
	descriptors: readonly GogCommandDescriptorInput[],
): (argv: readonly string[]) => GogOperationResolution {
	const parsed = z.array(gogCommandDescriptorSchema).max(512).parse(descriptors);
	const entries: {
		path: readonly string[];
		descriptor: GogCommandDescriptor;
		flags: ReturnType<typeof flagsForDescriptor>;
	}[] = [];
	const operationIds = new Set<string>();
	for (const descriptor of parsed) {
		if (
			operationIds.has(descriptor.operationId) ||
			descriptor.positionals.minimum > descriptor.positionals.maximum
		) {
			throw new Error('Gog operation identity or positional bounds are invalid.');
		}
		operationIds.add(descriptor.operationId);
		const fileInputs = descriptor.positionals.fileInputs ?? [];
		if (
			new Set(fileInputs).size !== fileInputs.length ||
			fileInputs.some((index) => index >= descriptor.positionals.minimum)
		)
			throw new Error('Gog input positions must be unique required positionals.');
		const flags = flagsForDescriptor(descriptor);
		for (const path of descriptor.paths) {
			if (
				entries.some(
					(entry) => pathStartsWith(path, entry.path) || pathStartsWith(entry.path, path),
				)
			) {
				throw new Error('Gog command paths must be unique, non-overlapping leaves.');
			}
			entries.push({ path, descriptor, flags });
		}
	}
	return (argv) => {
		if (
			!Array.isArray(argv) ||
			argv.length === 0 ||
			argv.length > 256 ||
			argv.some(
				(value) => typeof value !== 'string' || value.length > 16_384 || value.includes('\0'),
			)
		)
			return { kind: 'denied' };
		if (argv.length === 1 && ['--help', '--version', 'version'].includes(argv[0] ?? ''))
			return { kind: 'no-oauth' };
		const entry = entries.find(({ path }) => pathStartsWith(argv, path));
		if (entry === undefined) return { kind: 'denied' };
		const files = resolveFileArguments({
			argv: argv.slice(entry.path.length),
			descriptor: entry.descriptor,
			flags: entry.flags,
		});
		if (files === undefined) return { kind: 'denied' };
		return {
			kind: 'oauth',
			operationId: entry.descriptor.operationId,
			familyId: entry.descriptor.familyId,
			requirements: structuredClone(entry.descriptor.requirements),
			sendsMail: entry.descriptor.sendsMail,
			...(files.inputs.length === 0 && files.outputs.length === 0 ? {} : { files }),
		};
	};
}
