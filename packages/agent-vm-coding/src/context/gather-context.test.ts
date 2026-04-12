import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherContext, readOptionalFile } from "./gather-context.js";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = fs;

describe("gatherContext", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "gather-context-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads repo structure and relevant files from temp directory", () => {
    writeFileSync(join(tempDir, "CLAUDE.md"), "# Test Repo");
    writeFileSync(join(tempDir, "package.json"), '{"name":"test"}');
    writeFileSync(join(tempDir, "index.ts"), "export const x = 1;");

    const result = gatherContext(tempDir);

    expect(result.fileCount).toBe(3);
    expect(result.claudeMd).toBe("# Test Repo");
    expect(result.packageJson).toBe('{"name":"test"}');
    expect(result.summary).toContain("Repository structure (3 files):");
    expect(result.summary).toContain("CLAUDE.md");
    expect(result.summary).toContain("package.json");
    expect(result.summary).toContain("index.ts");
  });

  it("handles missing CLAUDE.md gracefully", () => {
    writeFileSync(join(tempDir, "package.json"), '{"name":"test"}');

    const result = gatherContext(tempDir);

    expect(result.claudeMd).toBeNull();
    expect(result.packageJson).toBe('{"name":"test"}');
  });

  it("skips node_modules and .git", () => {
    writeFileSync(join(tempDir, "index.ts"), "export const x = 1;");

    const nodeModulesDir = join(tempDir, "node_modules");
    mkdirSync(nodeModulesDir);
    writeFileSync(join(nodeModulesDir, "lib.js"), "module.exports = {};");

    const gitDir = join(tempDir, ".git");
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, "config"), "[core]");

    const result = gatherContext(tempDir);

    expect(result.fileCount).toBe(1);
    expect(result.summary).toContain("index.ts");
    expect(result.summary).not.toContain("node_modules");
    expect(result.summary).not.toContain(".git");
  });

  it("respects max depth", () => {
    writeFileSync(join(tempDir, "root.ts"), "root");

    const level1 = join(tempDir, "level1");
    mkdirSync(level1);
    writeFileSync(join(level1, "file1.ts"), "level1");

    const level2 = join(level1, "level2");
    mkdirSync(level2);
    writeFileSync(join(level2, "file2.ts"), "level2");

    const level3 = join(level2, "level3");
    mkdirSync(level3);
    writeFileSync(join(level3, "file3.ts"), "level3");

    const level4 = join(level3, "level4");
    mkdirSync(level4);
    writeFileSync(join(level4, "file4.ts"), "level4 - should not appear");

    const result = gatherContext(tempDir);

    expect(result.summary).toContain("root.ts");
    expect(result.summary).toContain("level1/file1.ts");
    expect(result.summary).toContain("level1/level2/file2.ts");
    expect(result.summary).toContain("level1/level2/level3/file3.ts");
    expect(result.summary).not.toContain("file4.ts");
  });

  it("returns correct fileCount", () => {
    writeFileSync(join(tempDir, "a.ts"), "a");
    writeFileSync(join(tempDir, "b.ts"), "b");
    writeFileSync(join(tempDir, "c.ts"), "c");

    const result = gatherContext(tempDir);

    expect(result.fileCount).toBe(3);
  });

  it("rethrows non-ENOENT read errors", () => {
    expect(() =>
      readOptionalFile("/tmp/example", () => {
        const error = new Error("permission denied") as Error & {
          code: string;
        };
        error.code = "EACCES";
        throw error;
      }),
    ).toThrow("permission denied");
  });
});
