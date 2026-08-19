import { open, stat } from "node:fs/promises";

import type { TaskContract } from "../task/task-contract.js";
import type { PathPolicy, PathDenialReason } from "../permissions/path-policy.js";

export const REPOSITORY_INSTRUCTION_LIMITS = Object.freeze({
  maximumFiles: 20,
  maximumCandidates: 100,
  maximumFileBytes: 32 * 1024,
  maximumTotalBytes: 64 * 1024,
});

export type RepositoryInstructionDocument = Readonly<{
  path: string;
  content: string;
  truncated: boolean;
}>;

export type OmittedRepositoryInstruction = Readonly<{
  path: string;
  reason: Exclude<PathDenialReason, "path_not_found"> | "not_file" | "invalid_utf8" | "read_failed";
}>;

export type RepositoryInstructionSet = Readonly<{
  documents: readonly RepositoryInstructionDocument[];
  omitted: readonly OmittedRepositoryInstruction[];
  totalBytes: number;
  truncated: boolean;
}>;

export async function loadRepositoryInstructions(
  task: TaskContract,
  pathPolicy: PathPolicy,
): Promise<RepositoryInstructionSet> {
  const candidates = instructionCandidates(task.allowedPaths);
  const documents: RepositoryInstructionDocument[] = [];
  const omitted: OmittedRepositoryInstruction[] = [];
  let totalBytes = 0;
  let truncated = candidates.truncated;

  for (const path of candidates.paths) {
    if (documents.length >= REPOSITORY_INSTRUCTION_LIMITS.maximumFiles) {
      truncated = true;
      break;
    }
    const decision = await pathPolicy.authorize({ operation: "read", path });
    if (!decision.allowed) {
      if (decision.reason !== "path_not_found") {
        omitted.push(Object.freeze({ path, reason: decision.reason }));
      }
      continue;
    }

    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(decision.canonicalPath);
    } catch {
      omitted.push(Object.freeze({ path, reason: "read_failed" }));
      continue;
    }
    if (!metadata.isFile()) {
      omitted.push(Object.freeze({ path, reason: "not_file" }));
      continue;
    }

    const remaining = REPOSITORY_INSTRUCTION_LIMITS.maximumTotalBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const maximumBytes = Math.min(remaining, REPOSITORY_INSTRUCTION_LIMITS.maximumFileBytes);
    let content: Awaited<ReturnType<typeof readUtf8Prefix>>;
    try {
      content = await readUtf8Prefix(decision.canonicalPath, metadata.size, maximumBytes);
    } catch {
      omitted.push(Object.freeze({ path, reason: "read_failed" }));
      continue;
    }
    if (content === undefined) {
      omitted.push(Object.freeze({ path, reason: "invalid_utf8" }));
      continue;
    }
    documents.push(
      Object.freeze({
        path: decision.relativePath,
        content: content.text,
        truncated: content.truncated,
      }),
    );
    totalBytes += Buffer.byteLength(content.text, "utf8");
    truncated ||= content.truncated;
  }

  return Object.freeze({
    documents: Object.freeze(documents),
    omitted: Object.freeze(omitted),
    totalBytes,
    truncated,
  });
}

function instructionCandidates(
  allowedPaths: readonly string[],
): Readonly<{ paths: readonly string[]; truncated: boolean }> {
  const paths = new Set<string>(["AGENTS.md"]);
  let truncated = false;

  for (const pattern of allowedPaths) {
    const segments = pattern.replaceAll("\\", "/").split("/").filter(Boolean);
    const wildcardIndex = segments.findIndex(hasGlobSyntax);
    const staticSegments = segments.slice(0, wildcardIndex === -1 ? -1 : wildcardIndex);
    let directory = "";
    for (const segment of staticSegments) {
      directory = directory.length === 0 ? segment : `${directory}/${segment}`;
      paths.add(`${directory}/AGENTS.md`);
      if (paths.size >= REPOSITORY_INSTRUCTION_LIMITS.maximumCandidates) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return Object.freeze({
    paths: Object.freeze(
      [...paths]
        .sort(
          (left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right, "en-US"),
        )
        .slice(0, REPOSITORY_INSTRUCTION_LIMITS.maximumCandidates),
    ),
    truncated,
  });
}

async function readUtf8Prefix(
  path: string,
  fileBytes: number,
  maximumBytes: number,
): Promise<Readonly<{ text: string; truncated: boolean }> | undefined> {
  const bytesToRead = Math.min(fileBytes, maximumBytes);
  const handle = await open(path, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }

  const maximumTrim = bytes.length < fileBytes ? Math.min(3, bytes.length) : 0;
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    const candidate = bytes.subarray(0, bytes.length - trim);
    try {
      return Object.freeze({
        text: new TextDecoder("utf-8", { fatal: true }).decode(candidate),
        truncated: candidate.length < fileBytes,
      });
    } catch {
      // A byte limit may split the last UTF-8 code point.
    }
  }
  return undefined;
}

function hasGlobSyntax(segment: string): boolean {
  return /[*?[\]{}!]/u.test(segment);
}

function pathDepth(path: string): number {
  return path.split("/").length - 1;
}
