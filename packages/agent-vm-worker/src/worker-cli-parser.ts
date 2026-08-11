import {
	command,
	constant,
	type InferValue,
	message,
	type Message,
	type Mode,
	object,
	option,
	optional,
	or,
	type Parser,
	withDefault,
} from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

export function projectZodScalarPresence<
	TSchema extends z.ZodType,
	TMode extends Mode,
	TParserState,
>(
	schema: TSchema,
	parser: Parser<TMode, z.infer<TSchema>, TParserState>,
): Parser<TMode, z.infer<TSchema>>;
export function projectZodScalarPresence(schema: z.ZodType, parser: Parser<Mode>): Parser<Mode> {
	if (schema instanceof z.ZodOptional) {
		if (schema.unwrap() instanceof z.ZodDefault) {
			throw new TypeError('CLI value schemas cannot mix optional and default wrappers.');
		}
		return optional(parser);
	}
	if (schema instanceof z.ZodDefault) {
		if (schema.unwrap() instanceof z.ZodOptional) {
			throw new TypeError('CLI value schemas cannot mix optional and default wrappers.');
		}
		return withDefault(parser, schema.parse(undefined));
	}
	return parser;
}

const workerPortSchema = z.coerce.number().int().min(0).max(65_535).default(18_789);
const workerConfigPathSchema = z.string().optional();
const workerStateDirectorySchema = z.string().optional();

function createWorkerPortParser(
	description: Message,
): Parser<'sync', z.infer<typeof workerPortSchema>> {
	return projectZodScalarPresence(
		workerPortSchema,
		option(
			'-p',
			'--port',
			zod(workerPortSchema, { metavar: 'PORT', placeholder: workerPortSchema.parse(undefined) }),
			{
				description,
			},
		),
	);
}

const workerServeCommandParser = command(
	'serve',
	object({
		command: constant('serve'),
		config: projectZodScalarPresence(
			workerConfigPathSchema,
			option('-c', '--config', zod(workerConfigPathSchema, { metavar: 'PATH', placeholder: '' }), {
				description: message`Path to worker config JSON`,
			}),
		),
		port: createWorkerPortParser(message`Port to listen on`),
		stateDir: projectZodScalarPresence(
			workerStateDirectorySchema,
			option('--state-dir', zod(workerStateDirectorySchema, { metavar: 'PATH', placeholder: '' }), {
				description: message`State directory path`,
			}),
		),
	}),
	{ description: message`Start the agent-vm-worker HTTP server` },
);

const workerHealthCommandParser = command(
	'health',
	object({
		command: constant('health'),
		port: createWorkerPortParser(message`Port to check`),
	}),
	{ description: message`Check worker health` },
);

export const workerCommandParser = or(workerServeCommandParser, workerHealthCommandParser);

export type WorkerCommand = InferValue<typeof workerCommandParser>;
