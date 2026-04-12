import { execa } from "execa";

export type CommandStatus = "passed" | "failed" | "timeout";

export interface VerificationResult {
  readonly testStatus: CommandStatus;
  readonly testOutput: string;
  readonly testExitCode: number;
  readonly lintStatus: CommandStatus;
  readonly lintOutput: string;
  readonly lintExitCode: number;
}

export interface VerifyOptions {
  readonly testCommand: string;
  readonly lintCommand: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

interface CommandResult {
  readonly status: CommandStatus;
  readonly output: string;
  readonly exitCode: number;
}

function parseCommand(command: string): readonly [string, ...string[]] {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Unsafe command: command must not be empty");
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    const next = trimmed[index + 1] ?? "";

    if (quote === null) {
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = "";
        }
        continue;
      }

      if (
        char === "|" ||
        char === "&" ||
        char === ";" ||
        char === ">" ||
        char === "<" ||
        char === "`" ||
        (char === "$" && next === "(")
      ) {
        throw new Error(`Unsafe command: shell operator '${char}' is not allowed`);
      }

      if (char === "\\") {
        current += next;
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (char === "\\") {
      current += next;
      index += 1;
      continue;
    }

    current += char;
  }

  if (quote !== null) {
    throw new Error("Unsafe command: unmatched quote");
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  const [bin, ...args] = tokens;
  if (!bin) {
    throw new Error("Unsafe command: command must not be empty");
  }

  return [bin, ...args];
}

export async function verify(
  options: VerifyOptions,
): Promise<VerificationResult> {
  const testResult = await runCommandWithTimeout(
    options.testCommand,
    options.cwd,
    options.timeoutMs,
  );

  const lintResult = await runCommandWithTimeout(
    options.lintCommand,
    options.cwd,
    options.timeoutMs,
  );

  return {
    testStatus: testResult.status,
    testOutput: testResult.output,
    testExitCode: testResult.exitCode,
    lintStatus: lintResult.status,
    lintOutput: lintResult.output,
    lintExitCode: lintResult.exitCode,
  };
}

export async function runCommandWithTimeout(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [bin, ...args] = parseCommand(command);
    const result = await execa(bin, args, {
      cwd,
      cancelSignal: controller.signal,
      reject: false,
    });

    clearTimeout(timeout);

    if (result.isCanceled || result.isTerminated) {
      return {
        status: "timeout",
        output: "",
        exitCode: -1,
      };
    }

    if ("code" in result && result.code === "ENOENT") {
      const output =
        ("shortMessage" in result && typeof result.shortMessage === "string"
          ? result.shortMessage
          : "Command not found");
      return {
        status: "failed",
        output,
        exitCode: 127,
      };
    }

    if (result.exitCode === 0) {
      return {
        status: "passed",
        output: "",
        exitCode: 0,
      };
    }

    const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
    const truncatedOutput =
      combinedOutput.length > 4096
        ? combinedOutput.slice(-4096)
        : combinedOutput;

    return {
      status: "failed",
      output: truncatedOutput,
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    clearTimeout(timeout);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        status: "failed",
        output: error instanceof Error ? error.message : String(error),
        exitCode: 127,
      };
    }
    return {
      status: "failed",
      output: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}
