import { open, opendir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";

import { z } from "zod";

import type { PathDecision, PathPolicy } from "../permissions/path-policy.js";
import type { ToolExecutor } from "./types.js";

const MAX_RESULT_BYTES = 48 * 1024;
const MAX_READ_BYTES = 16 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_PREVIEW_CHARACTERS = 400;
const OMITTED_DIRECTORIES = new Set([".git", ".issue-fix", "coverage", "dist", "node_modules"]);
const SENSITIVE_SEGMENTS = new Set([".aws", ".gnupg", ".ssh"]);
const SENSITIVE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "id_ed25519",
  "id_rsa",
]);
const SENSITIVE_EXTENSIONS = [".key", ".p12", ".pem", ".pfx"];

const listFilesInput = z.strictObject({
  path: z.string().min(1).max(500),
  maxDepth: z.int().min(0).max(5).default(2),
  cursor: z.int().min(0).max(10_000).default(0),
  limit: z.int().min(1).max(200).default(100),
});

const searchCodeInput = z.strictObject({
  path: z.string().min(1).max(500),
  query: z.string().min(1).max(200),
  caseSensitive: z.boolean().default(true),
  maxDepth: z.int().min(0).max(20).default(12),
  maxFiles: z.int().min(1).max(500).default(200),
  maxFileBytes: z
    .int()
    .min(1)
    .max(MAX_SEARCH_FILE_BYTES)
    .default(128 * 1024),
  cursor: z.int().min(0).max(10_000).default(0),
  limit: z.int().min(1).max(100).default(50),
});

const readFileInput = z.strictObject({
  path: z.string().min(1).max(500),
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  maxBytes: z
    .int()
    .min(1)
    .max(MAX_READ_BYTES)
    .default(8 * 1024),
});

type ListedEntry = Readonly<{
  path: string;
  kind: "directory" | "file";
  size?: number;
}>;

type SearchMatch = Readonly<{
  path: string;
  line: number;
  column: number;
  preview: string;
  previewTruncated: boolean;
}>;

type TraversalStats = {
  omitted: number;
  fileLimitReached: boolean;
};

export function createRepositoryDiscoveryTools(pathPolicy: PathPolicy): readonly ToolExecutor[] {
  return Object.freeze([
    createExecutor(
      "list_files",
      "List a bounded, deterministic page of files and directories in the prepared worktree.",
      listFilesInput,
      (input) => listFiles(pathPolicy, input),
    ),
    createExecutor(
      "search_code",
      "Search text files for a bounded literal query without shell execution.",
      searchCodeInput,
      (input) => searchCode(pathPolicy, input),
    ),
    createExecutor(
      "read_file",
      "Read a bounded UTF-8 byte segment from a non-sensitive file in the prepared worktree.",
      readFileInput,
      (input) => readTextFile(pathPolicy, input),
    ),
  ]);
}

function createExecutor<Schema extends z.ZodType>(
  name: string,
  description: string,
  schema: Schema,
  execute: (input: z.output<Schema>) => Promise<Readonly<Record<string, unknown>>>,
): ToolExecutor {
  return Object.freeze({
    definition: Object.freeze({ name, description, inputSchema: jsonSchema(schema) }),
    execute: async (input: unknown) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return toolError("invalid_arguments", {
          issues: parsed.error.issues.slice(0, 10).map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        });
      }

      try {
        return { content: JSON.stringify(await execute(parsed.data)), isError: false };
      } catch (error: unknown) {
        if (error instanceof RepositoryReadError) {
          return toolError(error.code, error.metadata);
        }
        return toolError("read_failed");
      }
    },
  });
}

async function listFiles(
  pathPolicy: PathPolicy,
  input: z.output<typeof listFilesInput>,
): Promise<Readonly<Record<string, unknown>>> {
  const start = await authorizeRead(pathPolicy, input.path);
  if (!(await stat(start.canonicalPath)).isDirectory()) {
    throw new RepositoryReadError("not_directory");
  }

  const entries: ListedEntry[] = [];
  const stats: TraversalStats = { omitted: 0, fileLimitReached: false };
  await collectEntries(
    pathPolicy,
    start.relativePath,
    input.maxDepth,
    entries,
    stats,
    input.cursor + input.limit + 1,
  );

  const page = entries.slice(input.cursor, input.cursor + input.limit);
  const moreEntries = entries.length > input.cursor + page.length;
  return fitEntryResult(
    {
      ok: true,
      path: start.relativePath,
      cursor: input.cursor,
      omittedEntries: stats.omitted,
    },
    page,
    moreEntries || stats.fileLimitReached,
    input.cursor,
  );
}

async function searchCode(
  pathPolicy: PathPolicy,
  input: z.output<typeof searchCodeInput>,
): Promise<Readonly<Record<string, unknown>>> {
  const start = await authorizeRead(pathPolicy, input.path);
  const startMetadata = await stat(start.canonicalPath);
  const files: string[] = startMetadata.isFile() ? [start.relativePath] : [];
  const stats: TraversalStats = { omitted: 0, fileLimitReached: false };
  if (startMetadata.isDirectory()) {
    await collectFiles(
      pathPolicy,
      start.relativePath,
      input.maxDepth,
      files,
      stats,
      input.maxFiles,
    );
  } else if (!startMetadata.isFile()) {
    throw new RepositoryReadError("invalid_search_path");
  }

  const matches: SearchMatch[] = [];
  let totalMatchesSeen = 0;
  let filesScanned = 0;
  let skippedFiles = 0;
  let scannedBytes = 0;
  let scanLimitReached = false;
  const query = input.caseSensitive ? input.query : input.query.toLocaleLowerCase("en-US");

  outer: for (const path of files) {
    filesScanned += 1;
    const decision = await authorizeRead(pathPolicy, path);
    const metadata = await stat(decision.canonicalPath);
    if (!metadata.isFile() || metadata.size > input.maxFileBytes) {
      skippedFiles += 1;
      continue;
    }
    if (scannedBytes + metadata.size > MAX_SEARCH_TOTAL_BYTES) {
      skippedFiles += 1;
      scanLimitReached = true;
      break;
    }

    const bytes = await readFile(decision.canonicalPath);
    scannedBytes += bytes.length;
    const text = decodeSafeText(bytes);
    if (text === undefined) {
      skippedFiles += 1;
      continue;
    }

    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const comparable = input.caseSensitive ? line : line.toLocaleLowerCase("en-US");
      let column = comparable.indexOf(query);
      while (column !== -1) {
        if (totalMatchesSeen >= input.cursor) {
          matches.push(
            Object.freeze({
              path: decision.relativePath,
              line: index + 1,
              column: column + 1,
              preview: line.slice(0, MAX_PREVIEW_CHARACTERS),
              previewTruncated: line.length > MAX_PREVIEW_CHARACTERS,
            }),
          );
          if (matches.length > input.limit) {
            break outer;
          }
        }
        totalMatchesSeen += 1;
        column = comparable.indexOf(query, column + Math.max(query.length, 1));
      }
    }
  }

  const page = matches.slice(0, input.limit);
  const moreMatches = matches.length > page.length;
  return fitEntryResult(
    {
      ok: true,
      path: start.relativePath,
      query: input.query,
      cursor: input.cursor,
      filesScanned,
      scannedBytes,
      skippedFiles,
      omittedEntries: stats.omitted,
    },
    page,
    moreMatches || stats.fileLimitReached || scanLimitReached,
    input.cursor,
  );
}

async function readTextFile(
  pathPolicy: PathPolicy,
  input: z.output<typeof readFileInput>,
): Promise<Readonly<Record<string, unknown>>> {
  const decision = await authorizeRead(pathPolicy, input.path);
  if (isSensitivePath(decision.relativePath)) {
    throw new RepositoryReadError("sensitive_path");
  }

  const metadata = await stat(decision.canonicalPath);
  if (!metadata.isFile()) {
    throw new RepositoryReadError("not_file");
  }
  if (input.offset > metadata.size) {
    throw new RepositoryReadError("invalid_offset");
  }

  const handle = await open(decision.canonicalPath, "r");
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(input.maxBytes, metadata.size - input.offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const decoded = decodeUtf8Segment(bytes, input.offset);
  if (decoded === undefined) {
    throw new RepositoryReadError("binary_or_invalid_utf8");
  }

  const nextOffset = input.offset + decoded.bytesRead;
  return Object.freeze({
    ok: true,
    path: decision.relativePath,
    offset: input.offset,
    bytesRead: decoded.bytesRead,
    totalBytes: metadata.size,
    content: decoded.text,
    truncated: nextOffset < metadata.size,
    nextOffset: nextOffset < metadata.size ? nextOffset : null,
  });
}

async function collectEntries(
  pathPolicy: PathPolicy,
  directory: string,
  remainingDepth: number,
  output: ListedEntry[],
  stats: TraversalStats,
  maximumEntries: number,
): Promise<void> {
  if (output.length >= maximumEntries) {
    stats.fileLimitReached = true;
    return;
  }

  const decision = await authorizeRead(pathPolicy, directory);
  const children = await readDirectory(decision.canonicalPath);

  for (const child of children) {
    const path = joinPortable(decision.relativePath, child.name);
    if (isSensitivePath(path) || child.isSymbolicLink()) {
      stats.omitted += 1;
      continue;
    }

    if (child.isDirectory()) {
      if (OMITTED_DIRECTORIES.has(child.name)) {
        stats.omitted += 1;
        continue;
      }
      output.push(Object.freeze({ path, kind: "directory" }));
      if (remainingDepth > 0) {
        await collectEntries(pathPolicy, path, remainingDepth - 1, output, stats, maximumEntries);
      }
    } else if (child.isFile()) {
      const childDecision = await authorizeRead(pathPolicy, path);
      output.push(
        Object.freeze({
          path: childDecision.relativePath,
          kind: "file",
          size: (await stat(childDecision.canonicalPath)).size,
        }),
      );
    } else {
      stats.omitted += 1;
    }

    if (output.length >= maximumEntries) {
      stats.fileLimitReached = true;
      return;
    }
  }
}

async function collectFiles(
  pathPolicy: PathPolicy,
  directory: string,
  remainingDepth: number,
  output: string[],
  stats: TraversalStats,
  maximumFiles: number,
): Promise<void> {
  if (output.length >= maximumFiles) {
    stats.fileLimitReached = true;
    return;
  }

  const decision = await authorizeRead(pathPolicy, directory);
  const children = await readDirectory(decision.canonicalPath);

  for (const child of children) {
    const path = joinPortable(decision.relativePath, child.name);
    if (isSensitivePath(path) || child.isSymbolicLink()) {
      stats.omitted += 1;
      continue;
    }
    if (child.isDirectory()) {
      if (OMITTED_DIRECTORIES.has(child.name)) {
        stats.omitted += 1;
      } else if (remainingDepth > 0) {
        await collectFiles(pathPolicy, path, remainingDepth - 1, output, stats, maximumFiles);
        if (output.length >= maximumFiles) {
          stats.fileLimitReached = true;
          return;
        }
      }
    } else if (child.isFile()) {
      output.push(path);
      if (output.length >= maximumFiles) {
        stats.fileLimitReached = true;
        return;
      }
    }
  }
}

async function readDirectory(path: string): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    entries.push(entry);
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new RepositoryReadError("directory_too_large");
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, "en-US"));
}

async function authorizeRead(
  pathPolicy: PathPolicy,
  path: string,
): Promise<Extract<PathDecision, { allowed: true }>> {
  const decision = await pathPolicy.authorize({ operation: "read", path });
  if (!decision.allowed) {
    throw new RepositoryReadError("path_denied", { reason: decision.reason });
  }
  return decision;
}

function fitEntryResult(
  metadata: Readonly<Record<string, unknown>>,
  sourceEntries: readonly Readonly<Record<string, unknown>>[],
  initiallyTruncated: boolean,
  cursor: number,
): Readonly<Record<string, unknown>> {
  const entries = [...sourceEntries];
  let truncated = initiallyTruncated;
  let result: Readonly<Record<string, unknown>>;

  while (true) {
    result = Object.freeze({
      ...metadata,
      entries: Object.freeze([...entries]),
      truncated,
      nextCursor: truncated ? cursor + entries.length : null,
    });
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_RESULT_BYTES) {
      return result;
    }
    if (entries.length === 0) {
      throw new RepositoryReadError("result_too_large");
    }
    entries.pop();
    truncated = true;
  }
}

function decodeUtf8Segment(
  bytes: Buffer,
  offset: number,
): Readonly<{ text: string; bytesRead: number }> | undefined {
  if (bytes.length > 0 && offset > 0 && (bytes[0]! & 0xc0) === 0x80) {
    return undefined;
  }

  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    const candidate = bytes.subarray(0, bytes.length - trim);
    const text = decodeSafeText(candidate);
    if (text !== undefined) {
      return Object.freeze({ text, bytesRead: candidate.length });
    }
  }
  return undefined;
}

function decodeSafeText(bytes: Uint8Array): string | undefined {
  for (const byte of bytes.subarray(0, 8 * 1024)) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      return undefined;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isSensitivePath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.at(-1)?.toLocaleLowerCase("en-US") ?? "";
  return (
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment.toLocaleLowerCase("en-US"))) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    SENSITIVE_NAMES.has(name) ||
    SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

function joinPortable(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function jsonSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const value: unknown = z.toJSONSchema(schema);
  if (!isRecord(value)) {
    throw new Error("Zod did not produce an object JSON schema");
  }
  return Object.freeze({ ...value });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RepositoryReadError extends Error {
  public readonly code: string;
  public readonly metadata: Readonly<Record<string, unknown>>;

  public constructor(code: string, metadata: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.name = "RepositoryReadError";
    this.code = code;
    this.metadata = metadata;
  }
}

function toolError(
  code: string,
  metadata: Readonly<Record<string, unknown>> = {},
): Readonly<{ content: string; isError: true }> {
  return Object.freeze({
    content: JSON.stringify({ ok: false, error: { code, ...metadata } }),
    isError: true,
  });
}
