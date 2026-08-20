import type {
	CliAllowedCommand,
	CliAllowance,
	CliAllowanceInput,
	CliFlagRule,
	CliPatternRule,
} from './models/cli-allowance-schema.js';

export type CliAllowanceValidationResult =
	| {
			readonly argv: readonly string[];
			readonly ok: true;
	  }
	| {
			readonly error: {
				readonly code: string;
				readonly message: string;
			};
			readonly ok: false;
	  };

export interface ValidateCliAllowanceInvocationProps {
	readonly allowance: CliAllowance;
	readonly input: CliAllowanceInput;
}

export function validateCliAllowanceInvocation(
	props: ValidateCliAllowanceInvocationProps,
): CliAllowanceValidationResult {
	const command = findMatchingCommand(props.allowance.commands, props.input.argv);
	if (command === undefined) {
		return invalidCliAllowance('CLI argv does not match an allowed command path.');
	}

	const deniedArgumentPattern = firstMatchingPattern(
		props.allowance.deniedPatterns,
		props.input.argv,
	);
	if (deniedArgumentPattern !== undefined) {
		return invalidCliAllowance(
			`CLI argv matched denied ${deniedArgumentPattern.kind} pattern "${deniedArgumentPattern.value}".`,
		);
	}

	const flagValidation = validateFlagRules({
		argvTail: props.input.argv.slice(command.path.length),
		flagRules: command.flagRules,
	});
	if (!flagValidation.ok) return flagValidation;

	const stdinValidation = validateStdin(props.allowance, props.input.stdin);
	if (!stdinValidation.ok) return stdinValidation;

	return { argv: props.input.argv, ok: true };
}

function invalidCliAllowance(message: string): CliAllowanceValidationResult {
	return {
		error: { code: 'cli_allowance_denied', message },
		ok: false,
	};
}

function findMatchingCommand(
	commands: readonly CliAllowedCommand[],
	argv: readonly string[],
): CliAllowedCommand | undefined {
	return commands.find((command) =>
		command.path.every((token, tokenIndex) => argv[tokenIndex] === token),
	);
}

function firstMatchingPattern(
	patterns: readonly CliPatternRule[],
	values: readonly string[],
): CliPatternRule | undefined {
	return patterns.find((pattern) =>
		values.some((value) =>
			pattern.kind === 'literal'
				? value.includes(pattern.value)
				: new RegExp(pattern.value, 'u').test(value),
		),
	);
}

function validateFlagRules(props: {
	readonly argvTail: readonly string[];
	readonly flagRules: readonly CliFlagRule[];
}): CliAllowanceValidationResult {
	let tokenIndex = 0;
	while (tokenIndex < props.argvTail.length) {
		const token = props.argvTail[tokenIndex];
		if (token === undefined) {
			return invalidCliAllowance('CLI argv contained an empty slot.');
		}
		if (token === '--' || !token.startsWith('-')) {
			tokenIndex += 1;
			continue;
		}

		const parsedFlag = parseFlagToken(token);
		const matchingRule = props.flagRules.find((rule) => rule.names.includes(parsedFlag.name));
		if (matchingRule === undefined) {
			tokenIndex += 1;
			continue;
		}
		if (matchingRule.kind === 'deny') {
			return invalidCliAllowance(`CLI argv flag "${parsedFlag.name}" is denied by policy.`);
		}

		const separatedValue = props.argvTail[tokenIndex + 1];
		const value = parsedFlag.inlineValue ?? separatedValue;
		if (value === undefined || !matchingRule.values.includes(value)) {
			return invalidCliAllowance(
				`CLI argv flag "${parsedFlag.name}" requires one configured allowed value.`,
			);
		}
		tokenIndex += parsedFlag.inlineValue === undefined ? 2 : 1;
	}
	return { argv: props.argvTail, ok: true };
}

function parseFlagToken(token: string): {
	readonly inlineValue?: string;
	readonly name: string;
} {
	const separatorIndex = token.indexOf('=');
	if (separatorIndex === -1) return { name: token };
	return {
		inlineValue: token.slice(separatorIndex + 1),
		name: token.slice(0, separatorIndex),
	};
}

function validateStdin(
	allowance: CliAllowance,
	stdin: string | undefined,
): CliAllowanceValidationResult {
	if (allowance.stdin.kind === 'none') {
		return stdin === undefined
			? { argv: [], ok: true }
			: invalidCliAllowance('CLI stdin is not enabled for this operation.');
	}
	if (stdin === undefined) return { argv: [], ok: true };
	if (new TextEncoder().encode(stdin).byteLength > allowance.stdin.maxBytes) {
		return invalidCliAllowance('CLI stdin exceeds the configured byte limit.');
	}
	if (allowance.stdin.kind === 'bounded_text') {
		const deniedStdinPattern = firstMatchingPattern(allowance.stdin.deniedPatterns, [stdin]);
		return deniedStdinPattern === undefined
			? { argv: [], ok: true }
			: invalidCliAllowance(
					`CLI stdin matched denied ${deniedStdinPattern.kind} pattern "${deniedStdinPattern.value}".`,
				);
	}
	try {
		JSON.parse(stdin);
		return { argv: [], ok: true };
	} catch {
		return invalidCliAllowance('CLI stdin must contain valid JSON.');
	}
}
