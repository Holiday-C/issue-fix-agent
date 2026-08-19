import Anthropic, {
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { z } from "zod";

import type {
  ConversationMessage,
  MessageBlock,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
  ToolDefinition,
  ToolUseBlock,
} from "./types.js";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const MAX_COLLECTION_ITEMS = 1_000;
const MAX_JSON_DEPTH = 20;

const optionsSchema = z
  .strictObject({
    apiKey: z.string().trim().min(1).max(10_000).optional(),
    authToken: z.string().trim().min(1).max(10_000).optional(),
    baseURL: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .refine(validBaseURL, "Base URL must be an HTTP(S) URL without embedded credentials")
      .optional(),
    model: z.string().trim().min(1).max(200),
    maxTokens: z.int().min(1).max(64_000),
    timeoutMilliseconds: z
      .int()
      .min(1)
      .max(10 * 60_000)
      .default(120_000),
  })
  .superRefine((value, context) => {
    if (value.apiKey === undefined && value.authToken === undefined) {
      context.addIssue({ code: "custom", message: "An API key or auth token is required" });
    }
  });

export type AnthropicModelOptions = Readonly<{
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  model: string;
  maxTokens: number;
  timeoutMilliseconds?: number;
}>;

export interface AnthropicClientPort {
  createMessage(request: unknown, signal: AbortSignal): Promise<unknown>;
}

export type AnthropicModelErrorCode =
  | "invalid_configuration"
  | "invalid_request"
  | "invalid_response"
  | "authentication_failed"
  | "rate_limited"
  | "timed_out"
  | "cancelled"
  | "provider_failed";

export class AnthropicModelError extends Error {
  public readonly code: AnthropicModelErrorCode;

  public constructor(code: AnthropicModelErrorCode, message: string) {
    super(message);
    this.name = "AnthropicModelError";
    this.code = code;
  }
}

export class AnthropicMessagesAdapter implements ModelPort {
  readonly #client: AnthropicClientPort;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #timeoutMilliseconds: number;

  public constructor(options: AnthropicModelOptions, client?: AnthropicClientPort) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new AnthropicModelError(
        "invalid_configuration",
        "Anthropic model configuration is invalid",
      );
    }

    this.#model = parsed.data.model;
    this.#maxTokens = parsed.data.maxTokens;
    this.#timeoutMilliseconds = parsed.data.timeoutMilliseconds;
    const authentication =
      parsed.data.authToken !== undefined
        ? { authToken: parsed.data.authToken }
        : parsed.data.apiKey !== undefined
          ? { apiKey: parsed.data.apiKey }
          : undefined;
    if (authentication === undefined) {
      throw new AnthropicModelError(
        "invalid_configuration",
        "Anthropic model configuration is invalid",
      );
    }
    this.#client =
      client ??
      new SdkAnthropicClient({
        ...authentication,
        ...(parsed.data.baseURL === undefined ? {} : { baseURL: parsed.data.baseURL }),
      });
  }

  public async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted === true) {
      throw new AnthropicModelError("cancelled", "Anthropic request was cancelled");
    }

    const body = createRequest(request, this.#model, this.#maxTokens);
    const deadline = createDeadline(this.#timeoutMilliseconds, signal);
    try {
      const response = await this.#client.createMessage(body, deadline.signal);
      if (deadline.signal.aborted) {
        throw new AnthropicModelError(
          deadline.timedOut() ? "timed_out" : "cancelled",
          deadline.timedOut() ? "Anthropic request timed out" : "Anthropic request was cancelled",
        );
      }
      return parseResponse(response);
    } catch (error: unknown) {
      throw normalizeError(error, deadline.timedOut(), signalIsAborted(signal));
    } finally {
      deadline.dispose();
    }
  }
}

class SdkAnthropicClient implements AnthropicClientPort {
  readonly #client: Anthropic;

  public constructor(options: Readonly<{ apiKey?: string; authToken?: string; baseURL?: string }>) {
    this.#client = new Anthropic({
      apiKey: options.apiKey ?? null,
      authToken: options.authToken ?? null,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      maxRetries: 0,
    });
  }

  public async createMessage(request: unknown, signal: AbortSignal): Promise<unknown> {
    return this.#client.messages.create(request as Anthropic.MessageCreateParamsNonStreaming, {
      signal,
    });
  }
}

function validBaseURL(source: string): boolean {
  try {
    const value = new URL(source);
    return (
      (value.protocol === "https:" || value.protocol === "http:") &&
      value.username.length === 0 &&
      value.password.length === 0 &&
      value.search.length === 0 &&
      value.hash.length === 0
    );
  } catch {
    return false;
  }
}

function createRequest(
  request: ModelRequest,
  model: string,
  maxTokens: number,
): Readonly<Record<string, unknown>> {
  if (
    request.messages.length > MAX_COLLECTION_ITEMS ||
    request.tools.length > MAX_COLLECTION_ITEMS
  ) {
    throw new AnthropicModelError("invalid_request", "Anthropic request has too many items");
  }
  const body = Object.freeze({
    model,
    max_tokens: maxTokens,
    system: boundedText(request.system, "system prompt"),
    messages: Object.freeze(request.messages.map(toProviderMessage)),
    tools: Object.freeze(request.tools.map(toProviderTool)),
  });
  const serialized = safeStringify(body, "request");
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
    throw new AnthropicModelError("invalid_request", "Anthropic request exceeds the size limit");
  }
  return body;
}

function toProviderMessage(message: ConversationMessage): Readonly<Record<string, unknown>> {
  const content = message.content.map((block) => toProviderBlock(message.role, block));
  return Object.freeze({ role: message.role, content: Object.freeze(content) });
}

function toProviderBlock(
  role: ConversationMessage["role"],
  block: MessageBlock,
): Readonly<Record<string, unknown>> {
  if (block.type === "text") {
    return Object.freeze({ type: "text", text: boundedText(block.text, "message text") });
  }
  if (block.type === "tool_use") {
    if (role !== "assistant") {
      throw new AnthropicModelError(
        "invalid_request",
        "Tool calls must belong to assistant messages",
      );
    }
    validateJsonValue(block.input, "tool input", MAX_TOOL_INPUT_BYTES);
    return Object.freeze({
      type: "tool_use",
      id: boundedIdentifier(block.id, "tool call ID"),
      name: boundedIdentifier(block.name, "tool name"),
      input: block.input,
    });
  }
  if (role !== "user") {
    throw new AnthropicModelError("invalid_request", "Tool results must belong to user messages");
  }
  return Object.freeze({
    type: "tool_result",
    tool_use_id: boundedIdentifier(block.toolUseId, "tool result ID"),
    content: boundedText(block.content, "tool result"),
    is_error: block.isError,
  });
}

function toProviderTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
  if (tool.inputSchema["type"] !== "object") {
    throw new AnthropicModelError("invalid_request", "Tool input schema must be an object schema");
  }
  validateJsonValue(tool.inputSchema, "tool schema", MAX_TOOL_INPUT_BYTES);
  return Object.freeze({
    name: boundedIdentifier(tool.name, "tool name"),
    description: boundedText(tool.description, "tool description"),
    input_schema: tool.inputSchema,
  });
}

function parseResponse(source: unknown): ModelResponse {
  if (!isRecord(source) || source["type"] !== "message" || source["role"] !== "assistant") {
    throw invalidResponse();
  }
  const model = source["model"];
  const content = source["content"];
  if (
    typeof model !== "string" ||
    model.length === 0 ||
    model.length > 200 ||
    !Array.isArray(content)
  ) {
    throw invalidResponse();
  }
  if (content.length > MAX_COLLECTION_ITEMS) throw invalidResponse();

  const blocks = content.map(parseResponseBlock);
  const toolCalls = blocks.filter((block): block is ToolUseBlock => block.type === "tool_use");
  return Object.freeze({
    message: Object.freeze({ role: "assistant", content: Object.freeze(blocks) }),
    stopReason: parseStopReason(source["stop_reason"]),
    toolCalls: Object.freeze(toolCalls),
    model,
    usage: parseUsage(source["usage"]),
  });
}

function parseResponseBlock(source: unknown): MessageBlock {
  if (!isRecord(source)) throw invalidResponse();
  if (source["type"] === "text") {
    if (typeof source["text"] !== "string") throw invalidResponse();
    return Object.freeze({ type: "text", text: boundedResponseText(source["text"]) });
  }
  if (source["type"] === "tool_use") {
    if (typeof source["id"] !== "string" || typeof source["name"] !== "string") {
      throw invalidResponse();
    }
    const input = source["input"];
    validateResponseJson(input);
    return Object.freeze({
      type: "tool_use",
      id: responseIdentifier(source["id"]),
      name: responseIdentifier(source["name"]),
      input,
    });
  }
  throw invalidResponse();
}

function parseUsage(source: unknown): ModelUsage {
  if (!isRecord(source)) throw invalidResponse();
  return Object.freeze({
    inputTokens: usageCount(source["input_tokens"]),
    outputTokens: usageCount(source["output_tokens"]),
    cacheCreationInputTokens: nullableUsageCount(source["cache_creation_input_tokens"]),
    cacheReadInputTokens: nullableUsageCount(source["cache_read_input_tokens"]),
  });
}

function parseStopReason(source: unknown): ModelStopReason {
  switch (source) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
      return source;
    case "model_context_window_exceeded":
      return "context_window_exceeded";
    default:
      throw invalidResponse();
  }
}

function boundedText(source: string, label: string): string {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_TEXT_BYTES) {
    throw new AnthropicModelError("invalid_request", `${label} exceeds the size limit`);
  }
  return source;
}

function boundedIdentifier(source: string, label: string): string {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > 200 ||
    source.includes("\0")
  ) {
    throw new AnthropicModelError("invalid_request", `${label} is invalid`);
  }
  return source;
}

function responseIdentifier(source: string): string {
  if (source.length === 0 || source.length > 200 || source.includes("\0")) throw invalidResponse();
  return source;
}

function boundedResponseText(source: string): string {
  if (Buffer.byteLength(source, "utf8") > MAX_TEXT_BYTES) throw invalidResponse();
  return source;
}

function validateJsonValue(source: unknown, label: string, maximumBytes: number): void {
  if (!isJsonValue(source, 0, new WeakSet<object>())) {
    throw new AnthropicModelError("invalid_request", `${label} is not valid JSON`);
  }
  if (Buffer.byteLength(safeStringify(source, label), "utf8") > maximumBytes) {
    throw new AnthropicModelError("invalid_request", `${label} exceeds the size limit`);
  }
}

function validateResponseJson(source: unknown): void {
  if (!isJsonValue(source, 0, new WeakSet<object>())) throw invalidResponse();
  let serialized: string;
  try {
    serialized = JSON.stringify(source);
  } catch {
    throw invalidResponse();
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_INPUT_BYTES) throw invalidResponse();
}

function isJsonValue(source: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (source === null || typeof source === "string" || typeof source === "boolean") return true;
  if (typeof source === "number") return Number.isFinite(source);
  if (typeof source !== "object" || depth > MAX_JSON_DEPTH || seen.has(source)) return false;
  seen.add(source);
  if (Array.isArray(source)) {
    return (
      source.length <= MAX_COLLECTION_ITEMS &&
      source.every((value) => isJsonValue(value, depth + 1, seen))
    );
  }
  const prototype: unknown = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(source);
  return (
    entries.length <= MAX_COLLECTION_ITEMS &&
    entries.every(([key, value]) => key.length <= 1_000 && isJsonValue(value, depth + 1, seen))
  );
}

function safeStringify(source: unknown, label: string): string {
  try {
    const value = JSON.stringify(source);
    if (value === undefined) throw new Error("not JSON");
    return value;
  } catch {
    throw new AnthropicModelError("invalid_request", `${label} is not valid JSON`);
  }
}

function usageCount(source: unknown): number {
  if (!Number.isSafeInteger(source) || typeof source !== "number" || source < 0) {
    throw invalidResponse();
  }
  return source;
}

function nullableUsageCount(source: unknown): number {
  return source === null || source === undefined ? 0 : usageCount(source);
}

function invalidResponse(): AnthropicModelError {
  return new AnthropicModelError("invalid_response", "Anthropic response is invalid");
}

function normalizeError(
  error: unknown,
  timedOut: boolean,
  externallyCancelled: boolean,
): AnthropicModelError {
  if (error instanceof AnthropicModelError) return error;
  if (timedOut || error instanceof APIConnectionTimeoutError) {
    return new AnthropicModelError("timed_out", "Anthropic request timed out");
  }
  if (externallyCancelled || error instanceof APIUserAbortError || isAbortError(error)) {
    return new AnthropicModelError("cancelled", "Anthropic request was cancelled");
  }
  if (error instanceof AuthenticationError || errorStatus(error) === 401) {
    return new AnthropicModelError("authentication_failed", "Anthropic authentication failed");
  }
  if (error instanceof RateLimitError || errorStatus(error) === 429) {
    return new AnthropicModelError("rate_limited", "Anthropic rate limit exceeded");
  }
  return new AnthropicModelError("provider_failed", "Anthropic request failed");
}

function errorStatus(error: unknown): unknown {
  return isRecord(error) ? error["status"] : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function signalIsAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isRecord(source: unknown): source is Readonly<Record<string, unknown>> {
  return typeof source === "object" && source !== null && !Array.isArray(source);
}

function createDeadline(
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal,
): Readonly<{
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}> {
  const controller = new AbortController();
  let didTimeOut = false;
  const cancel = (): void => controller.abort();
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMilliseconds);
  if (externalSignal?.aborted === true) cancel();
  else externalSignal?.addEventListener("abort", cancel, { once: true });

  return Object.freeze({
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", cancel);
    },
  });
}
