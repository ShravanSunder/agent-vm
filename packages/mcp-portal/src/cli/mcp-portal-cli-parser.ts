import {
	argument,
	command,
	constant,
	map,
	multiple,
	object,
	option,
	optional,
	or,
	withDefault,
	type InferValue,
	type Parser,
} from '@optique/core';
import { zod } from '@optique/zod';
import { z, ZodDefault, ZodOptional } from 'zod';

const catalogPathSchema = z.string().min(1);
const configDirectorySchema = z.string().min(1);
const inputPathSchema = z.string().min(1);
const outputDirectorySchema = z.string().min(1);
const agentIdSchema = z.string().min(1);
const fingerprintSchema = z.string().min(1);
const proxyUrlSchema = z.string().transform((value, context) => {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			context.addIssue({
				code: 'custom',
				message: `Invalid proxy URL protocol "${url.protocol}". Expected http or https.`,
			});
			return z.NEVER;
		}
		return url.toString();
	} catch {
		context.addIssue({ code: 'custom', message: 'Invalid proxy URL.' });
		return z.NEVER;
	}
});
const optionalProxyUrlSchema = proxyUrlSchema.optional();
const portalToolSchema = z
	.enum(['mcp_portal_list', 'mcp_portal_search', 'mcp_portal_describe', 'mcp_portal_call'])
	.default('mcp_portal_call');
const portSchema = z.coerce.number().int().min(0).max(65_535).optional();
const agentOverrideSchema = z.string().regex(/^[^=]+=[^=]+$/u, {
	message: 'Expected <agentId>=<profile>.',
});
const agentOverridesSchema = z.array(agentOverrideSchema).default([]);

export function projectZodScalarPresence<TSchema extends ZodOptional<z.ZodType>, TState>(
	schema: TSchema,
	parser: Parser<'sync', z.infer<TSchema>, TState>,
): Parser<'sync', z.infer<TSchema>>;
export function projectZodScalarPresence<TSchema extends ZodDefault<z.ZodType>, TState>(
	schema: TSchema,
	parser: Parser<'sync', z.infer<TSchema>, TState>,
): Parser<'sync', z.infer<TSchema>>;
export function projectZodScalarPresence<TSchema extends z.ZodType, TState>(
	schema: TSchema,
	parser: Parser<'sync', z.infer<TSchema>, TState>,
): Parser<'sync', z.infer<TSchema>>;
export function projectZodScalarPresence(schema: z.ZodType, parser: Parser): Parser {
	if (schema instanceof ZodOptional) {
		if (schema.unwrap() instanceof ZodDefault) {
			throw new Error('CLI schema mixes ZodOptional and ZodDefault wrappers.');
		}
		return optional(parser);
	}
	if (schema instanceof ZodDefault) {
		if (schema.unwrap() instanceof ZodOptional) {
			throw new Error('CLI schema mixes ZodOptional and ZodDefault wrappers.');
		}
		return withDefault(parser, schema.parse(undefined));
	}
	return parser;
}

export function projectZodRepeatedOption<
	TElementSchema extends z.ZodType,
	TState,
	TSchema extends ZodDefault<z.ZodArray<TElementSchema>>,
>(
	schema: TSchema,
	elementParser: Parser<'sync', z.infer<TElementSchema>, TState>,
): Parser<'sync', z.infer<TSchema>> {
	return map(optional(multiple(elementParser, { min: 1 })), (values) => schema.parse(values));
}

const validateCommandParser = command(
	'validate',
	object({
		catalogPath: argument(
			zod(catalogPathSchema, { metavar: 'CATALOG', placeholder: 'catalog.json' }),
		),
		command: constant('validate'),
	}),
);

const generateHelperCommandParser = command(
	'generate-helper',
	object({
		catalogPath: argument(
			zod(catalogPathSchema, { metavar: 'CATALOG', placeholder: 'catalog.json' }),
		),
		command: constant('generate-helper'),
		outputDirectory: projectZodScalarPresence(
			outputDirectorySchema,
			option('--out', zod(outputDirectorySchema, { placeholder: 'generated' })),
		),
	}),
);

const callCommandParser = command(
	'call',
	object({
		agentId: projectZodScalarPresence(
			agentIdSchema,
			option('--agent', zod(agentIdSchema, { placeholder: 'agent' })),
		),
		command: constant('call'),
		configDir: projectZodScalarPresence(
			configDirectorySchema,
			option('--config-dir', zod(configDirectorySchema, { placeholder: 'config' })),
		),
		inputPath: projectZodScalarPresence(
			inputPathSchema,
			option('--input', zod(inputPathSchema, { placeholder: 'request.json' })),
		),
		toolName: projectZodScalarPresence(
			portalToolSchema,
			option(
				'--tool',
				zod(portalToolSchema, {
					metavar: 'PORTAL_TOOL',
					placeholder: portalToolSchema.parse(undefined),
				}),
			),
		),
	}),
);

const serveCommandParser = command(
	'serve',
	object({
		agentOverrides: projectZodRepeatedOption(
			agentOverridesSchema,
			option(
				'--agent',
				zod(agentOverridesSchema.unwrap().element, {
					metavar: 'AGENT=PROFILE',
					placeholder: 'agent=profile',
				}),
			),
		),
		command: constant('mcp-proxy.serve'),
		configDir: projectZodScalarPresence(
			configDirectorySchema,
			option('--config-dir', zod(configDirectorySchema, { placeholder: 'config' })),
		),
		port: projectZodScalarPresence(
			portSchema,
			option('-p', '--port', zod(portSchema, { metavar: 'PORT', placeholder: 18_791 })),
		),
	}),
);

const printClientConfigCommandParser = command(
	'print-client-config',
	object({
		agentId: projectZodScalarPresence(
			agentIdSchema,
			option('--agent', zod(agentIdSchema, { placeholder: 'agent' })),
		),
		command: constant('mcp-proxy.print-client-config'),
		configDir: projectZodScalarPresence(
			configDirectorySchema,
			option('--config-dir', zod(configDirectorySchema, { placeholder: 'config' })),
		),
		expectedFingerprint: projectZodScalarPresence(
			fingerprintSchema,
			option('--master-key-fingerprint', zod(fingerprintSchema, { placeholder: 'fingerprint' })),
		),
		proxyUrl: projectZodScalarPresence(
			optionalProxyUrlSchema,
			option(
				'--proxy-url',
				zod(optionalProxyUrlSchema, {
					metavar: 'URL',
					placeholder: 'http://127.0.0.1:18791',
				}),
			),
		),
	}),
);

const writeCredentialCommandParser = command(
	'write-credential',
	object({ command: constant('mcp-proxy.write-credential') }),
);

const mcpProxyCommandParser = command(
	'mcp-proxy',
	or(serveCommandParser, printClientConfigCommandParser, writeCredentialCommandParser),
);

export const mcpPortalRootParser = or(
	validateCommandParser,
	generateHelperCommandParser,
	callCommandParser,
	mcpProxyCommandParser,
);

export type McpPortalCommand = InferValue<typeof mcpPortalRootParser>;
