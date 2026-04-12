import * as fs from "node:fs";
import { join, relative } from "node:path";

export interface RepoContext {
  readonly fileCount: number;
  readonly summary: string;
  readonly claudeMd: string | null;
  readonly packageJson: string | null;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
]);

function collectFiles(
  dir: string,
  baseDir: string,
  depth: number,
  maxDepth: number,
): string[] {
  if (depth > maxDepth) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir, depth + 1, maxDepth));
    } else {
      files.push(relative(baseDir, fullPath));
    }
  }

  return files;
}

export function readOptionalFile(
  filePath: string,
  readFile: (path: string, encoding: BufferEncoding) => string = fs.readFileSync,
): string | null {
  try {
    return readFile(filePath, "utf-8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export function gatherContext(workspaceDir: string): RepoContext {
  const files = collectFiles(workspaceDir, workspaceDir, 0, 3);

  const claudeMd = readOptionalFile(join(workspaceDir, "CLAUDE.md"));
  const packageJson = readOptionalFile(join(workspaceDir, "package.json"));

  const summary = `Repository structure (${files.length} files):\n${files.join("\n")}`;

  return {
    fileCount: files.length,
    summary,
    claudeMd,
    packageJson,
  };
}
