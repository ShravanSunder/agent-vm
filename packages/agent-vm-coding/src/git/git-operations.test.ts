import { describe, expect, it } from "vitest";
import {
  buildCommitMessage,
  buildPushUrl,
  configureGit,
  createBranch,
  getDiff,
  getDiffStat,
  parseRepoFromUrl,
  pushBranch,
  sanitizeBranchName,
  stageAndCommit,
} from "./git-operations.js";
import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("git-operations", () => {
  describe("parseRepoFromUrl", () => {
    it("extracts owner/repo from full HTTPS URL", () => {
      expect(parseRepoFromUrl("https://github.com/user/repo")).toBe("user/repo");
    });

    it("extracts owner/repo from full HTTPS URL with .git suffix", () => {
      expect(parseRepoFromUrl("https://github.com/user/repo.git")).toBe("user/repo");
    });

    it("passes through owner/repo short form unchanged", () => {
      expect(parseRepoFromUrl("user/repo")).toBe("user/repo");
    });

    it("extracts owner/repo from URL without scheme", () => {
      expect(parseRepoFromUrl("github.com/user/repo")).toBe("user/repo");
    });
  });

  describe("buildPushUrl", () => {
    it("uses the actual GITHUB_TOKEN instead of leaving a literal placeholder", () => {
      const previousToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "token-value";

      const url = buildPushUrl("owner/repo");

      expect(url).toBe(
        "https://x-access-token:token-value@github.com/owner/repo.git",
      );
      expect(url).not.toContain("$GITHUB_TOKEN");

      process.env.GITHUB_TOKEN = previousToken;
    });

    it("formats push URL with the token from the environment", () => {
      const previousToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "abc123";

      const url = buildPushUrl("owner/repo");
      expect(url).toBe("https://x-access-token:abc123@github.com/owner/repo.git");

      process.env.GITHUB_TOKEN = previousToken;
    });

    it("handles organization/repository format", () => {
      const previousToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "token";
      const url = buildPushUrl("myorg/myproject");
      expect(url).toBe(
        "https://x-access-token:token@github.com/myorg/myproject.git",
      );
      process.env.GITHUB_TOKEN = previousToken;
    });

    it("handles full GitHub URL by extracting owner/repo", () => {
      const previousToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "token";
      const url = buildPushUrl("https://github.com/myorg/myproject");
      expect(url).toBe(
        "https://x-access-token:token@github.com/myorg/myproject.git",
      );
      process.env.GITHUB_TOKEN = previousToken;
    });
  });

  describe("sanitizeBranchName", () => {
    it("strips unsafe characters from branch names", () => {
      expect(sanitizeBranchName("feature bad^name?")).toBe("feature-bad-name-");
    });
  });

  describe("buildCommitMessage", () => {
    it("includes co-author in commit message", () => {
      const message = buildCommitMessage(
        "feat: add new feature",
        "agent-vm-coding <noreply@agent-vm>",
      );
      expect(message).toBe(
        "feat: add new feature\n\nCo-Authored-By: agent-vm-coding <noreply@agent-vm>",
      );
    });

    it("handles multi-line commit messages", () => {
      const message = buildCommitMessage(
        "fix: resolve issue\n\nDetailed explanation here",
        "Agent Bot <bot@example.com>",
      );
      expect(message).toBe(
        "fix: resolve issue\n\nDetailed explanation here\n\nCo-Authored-By: Agent Bot <bot@example.com>",
      );
    });
  });

  describe("configureGit", () => {
    it("configures git with repo-local settings (not global)", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });

        await configureGit(
          {
            userEmail: "test@example.com",
            userName: "Test User",
          },
          tempDir,
        );

        // user.email and user.name should be local (repo-scoped)
        const emailResult = await execa(
          "git",
          ["config", "--local", "user.email"],
          {
            cwd: tempDir,
          },
        );
        expect(emailResult.stdout.trim()).toBe("test@example.com");

        const nameResult = await execa(
          "git",
          ["config", "--local", "user.name"],
          { cwd: tempDir },
        );
        expect(nameResult.stdout.trim()).toBe("Test User");

        // http.version should also be local
        const httpResult = await execa(
          "git",
          ["config", "--local", "http.version"],
          { cwd: tempDir },
        );
        expect(httpResult.stdout.trim()).toBe("HTTP/1.1");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("createBranch", () => {
    it("creates a new branch in a temp git repo", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["README.md"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial commit"], {
          cwd: tempDir,
        });

        await createBranch("test-branch", tempDir);

        const branchResult = await execa("git", ["branch", "--show-current"], {
          cwd: tempDir,
        });
        expect(branchResult.stdout.trim()).toBe("test-branch");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("stageAndCommit", () => {
    it("creates a commit with staged changes", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });

        await execa("touch", ["test.txt"], { shell: true, cwd: tempDir });

        await stageAndCommit({
          message: "test commit",
          coAuthor: "Co-Author <co@example.com>",
          cwd: tempDir,
        });

        const logResult = await execa("git", ["log", "--oneline"], {
          cwd: tempDir,
        });
        expect(logResult.stdout).toContain("test commit");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles nothing to commit gracefully", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["README.md"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial"], { cwd: tempDir });

        await expect(
          stageAndCommit({
            message: "empty commit",
            coAuthor: "Agent <agent@example.com>",
            cwd: tempDir,
          }),
        ).resolves.not.toThrow();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("handles nothing to commit when repo is clean", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["README.md"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial"], { cwd: tempDir });

        await expect(
          stageAndCommit({
            message: "attempt commit on clean",
            coAuthor: "Agent <agent@example.com>",
            cwd: tempDir,
          }),
        ).resolves.not.toThrow();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("getDiffStat", () => {
    it("returns empty string for clean repo", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["README.md"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial"], { cwd: tempDir });

        const diffStat = await getDiffStat(tempDir);
        expect(diffStat).toBe("");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("getDiff", () => {
    it("returns diff output for modified files", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("bash", ["-c", "echo 'initial' > test.txt"], {
          cwd: tempDir,
        });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial"], { cwd: tempDir });

        await execa("bash", ["-c", "echo 'modified' >> test.txt"], {
          cwd: tempDir,
        });

        const diff = await getDiff(tempDir);
        expect(diff).toContain("test.txt");
        expect(diff).toContain("+modified");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it("returns empty string on clean repo", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["README.md"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "initial"], { cwd: tempDir });

        const diff = await getDiff(tempDir);
        expect(diff).toBe("");
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("pushBranch", () => {
    it("error messages do not contain token URL", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "git-test-"));
      const previousToken = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = "super-secret-token";

      try {
        await execa("git", ["init"], { cwd: tempDir });
        await execa("git", ["config", "user.email", "test@example.com"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "user.name", "Test User"], {
          cwd: tempDir,
        });
        await execa("git", ["config", "commit.gpgsign", "false"], {
          cwd: tempDir,
        });
        await execa("touch", ["test.txt"], { shell: true, cwd: tempDir });
        await execa("git", ["add", "."], { cwd: tempDir });
        await execa("git", ["commit", "-m", "test"], { cwd: tempDir });
        await execa("git", ["checkout", "-b", "test-branch"], {
          cwd: tempDir,
        });

        await expect(
          pushBranch({
            repo: "nonexistent/repo",
            branchName: "test-branch",
            cwd: tempDir,
          }),
        ).rejects.toThrow();

        try {
          await pushBranch({
            repo: "nonexistent/repo",
            branchName: "test-branch",
            cwd: tempDir,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (error instanceof Error) {
            expect(error.message).not.toContain("x-access-token");
            expect(error.message).not.toContain("GITHUB_TOKEN");
            expect(error.message).toContain("git push failed");
          }
        }
      } finally {
        process.env.GITHUB_TOKEN = previousToken;
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("parseRepoFromUrl validation", () => {
    it("rejects malformed repository strings", () => {
      expect(() => parseRepoFromUrl("not a repo")).toThrow();
    });
  });
});
