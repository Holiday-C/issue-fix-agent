import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

import type { ProcessInvocation, ProcessPort, ProcessResult } from "./types.js";

let activeAdapter = false;

export class SandboxRuntimeAdapter implements ProcessPort {
  readonly #worktreeRoot: string;
  readonly #temporaryRoot: string;
  #closed = false;
  #running = false;

  private constructor(worktreeRoot: string, temporaryRoot: string) {
    this.#worktreeRoot = worktreeRoot;
    this.#temporaryRoot = temporaryRoot;
  }

  public static async create(worktreeRoot: string): Promise<SandboxRuntimeAdapter> {
    if (activeAdapter) {
      throw new Error("Only one command sandbox may be active");
    }
    if (process.platform === "win32" || !SandboxManager.isSupportedPlatform()) {
      throw new Error("Command sandbox is not supported on this platform");
    }

    const canonicalRoot = await realpath(worktreeRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("Sandbox worktree root must be a directory");
    }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "issue-fix-sandbox-"));
    activeAdapter = true;

    try {
      await SandboxManager.initialize(createSandboxConfig(canonicalRoot, temporaryRoot));
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length > 0) {
        throw new Error("Sandbox dependencies are unavailable");
      }
      return new SandboxRuntimeAdapter(canonicalRoot, temporaryRoot);
    } catch (error: unknown) {
      activeAdapter = false;
      await SandboxManager.reset().catch(() => undefined);
      await rm(temporaryRoot, { force: true, recursive: true });
      throw error;
    }
  }

  public async run(invocation: ProcessInvocation, signal?: AbortSignal): Promise<ProcessResult> {
    if (this.#closed || this.#running) {
      return emptyResult("sandbox_unavailable");
    }
    if (!isInvocationInside(this.#worktreeRoot, invocation.cwd)) {
      return emptyResult("sandbox_unavailable");
    }

    this.#running = true;
    const startedAt = performance.now();
    const commandId = randomUUID();

    try {
      const command = [invocation.executable, ...invocation.args].map(quotePosix).join(" ");
      const wrapped = await wrapWithDedicatedTemp(
        command,
        commandId,
        invocation.cwd,
        this.#temporaryRoot,
        signal,
      );
      const result = await spawnBounded(
        wrapped.argv,
        invocation.cwd,
        minimalEnvironment(this.#temporaryRoot),
        invocation.timeoutMilliseconds,
        invocation.maxOutputBytes,
        signal,
      );
      const violations =
        SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId);
      return Object.freeze({
        ...result,
        durationMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
        sandboxViolation: violations.length > 0,
      });
    } catch {
      return Object.freeze({
        ...emptyResult(signal?.aborted === true ? "cancelled" : "sandbox_unavailable"),
        durationMilliseconds: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } finally {
      SandboxManager.cleanupAfterCommand();
      this.#running = false;
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await SandboxManager.reset();
    } finally {
      activeAdapter = false;
      await rm(this.#temporaryRoot, { force: true, recursive: true });
    }
  }
}

function createSandboxConfig(worktreeRoot: string, temporaryRoot: string): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [homedir()],
      allowRead: [worktreeRoot, temporaryRoot],
      allowWrite: [worktreeRoot, temporaryRoot],
      denyWrite: [
        join(worktreeRoot, ".git"),
        join(worktreeRoot, ".issue-fix"),
        join(worktreeRoot, ".env"),
        join(worktreeRoot, ".env.*"),
        "/tmp/claude",
        "/private/tmp/claude",
        join(homedir(), ".npm/_logs"),
        join(homedir(), ".claude/debug"),
      ],
      allowGitConfig: false,
    },
    credentials: {
      envVars: [],
      files: [],
    },
    ignoreViolations: {},
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

async function spawnBounded(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMilliseconds: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<Omit<ProcessResult, "durationMilliseconds" | "sandboxViolation">> {
  if (argv.length === 0 || argv[0] === undefined) {
    return emptyProcessResult("spawn_failed");
  }
  if (signal?.aborted === true) {
    return emptyProcessResult("cancelled");
  }

  return new Promise((resolveResult) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createCollector(maxOutputBytes);
    const stderr = createCollector(maxOutputBytes);
    let outcome: ProcessResult["outcome"] = "completed";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.on("error", () => {
      outcome = "spawn_failed";
    });

    const timeout = setTimeout(() => {
      if (outcome === "completed") {
        outcome = "timed_out";
      }
      child.kill("SIGKILL");
    }, timeoutMilliseconds);
    const cancel = (): void => {
      if (outcome === "completed") {
        outcome = "cancelled";
      }
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", cancel, { once: true });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      resolveResult(
        Object.freeze({
          outcome,
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        }),
      );
    });
  });
}

function createCollector(limit: number): Readonly<{
  add(chunk: Buffer): void;
  text(): string;
  truncated(): boolean;
}> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    add: (chunk) => {
      const remaining = limit - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
      }
      wasTruncated ||= chunk.length > Math.max(remaining, 0);
    },
    text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    truncated: () => wasTruncated,
  };
}

function minimalEnvironment(temporaryRoot: string): NodeJS.ProcessEnv {
  return {
    HOME: temporaryRoot,
    LANG: "C",
    LC_ALL: "C",
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isInvocationInside(root: string, cwd: string): boolean {
  const relativePath = relative(root, cwd);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function wrapWithDedicatedTemp(
  command: string,
  commandId: string,
  cwd: string,
  temporaryRoot: string,
  signal?: AbortSignal,
): Promise<Readonly<{ argv: string[]; env: NodeJS.ProcessEnv }>> {
  const previous = process.env["CLAUDE_CODE_TMPDIR"];
  process.env["CLAUDE_CODE_TMPDIR"] = temporaryRoot;
  try {
    return await SandboxManager.wrapWithSandboxArgv(command, "/bin/sh", undefined, signal, cwd, {
      commandId,
      commandText: "node",
    });
  } finally {
    if (previous === undefined) {
      delete process.env["CLAUDE_CODE_TMPDIR"];
    } else {
      process.env["CLAUDE_CODE_TMPDIR"] = previous;
    }
  }
}

function emptyResult(outcome: ProcessResult["outcome"]): ProcessResult {
  return Object.freeze({
    ...emptyProcessResult(outcome),
    durationMilliseconds: 0,
    sandboxViolation: false,
  });
}

function emptyProcessResult(
  outcome: ProcessResult["outcome"],
): Omit<ProcessResult, "durationMilliseconds" | "sandboxViolation"> {
  return Object.freeze({
    outcome,
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}
