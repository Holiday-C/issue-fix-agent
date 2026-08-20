import { z } from "zod";

import { ModelAdapterError } from "./model-error.js";
import type {
  ConversationMessage,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
  ModelUsage,
  ToolDefinition,
  ToolUseBlock,
} from "./types.js";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const MAX_ITEMS = 1_000;
const MAX_JSON_DEPTH = 20;
const MAX_REASONING_BYTES = 1024 * 1024;

const optionsSchema = z.strictObject({
  baseURL: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .refine(validBaseURL, "Base URL must be an HTTP(S) URL without embedded credentials"),
  authToken: z.string().trim().min(1).max(10_000),
  model: z.string().trim().min(1).max(200),
  maxTokens: z.int().min(1).max(400_000),
  timeoutMilliseconds: z
    .int()
    .min(1)
    .max(10 * 60_000)
    .default(120_000),
  thinkingMode: z.enum(["enabled", "disabled"]).optional(),
});

export type OpenAIChatOptions = Readonly<{
  baseURL: string;
  authToken: string;
  model: string;
  maxTokens: number;
  timeoutMilliseconds?: number;
  thinkingMode?: "enabled" | "disabled";
}>;

export interface OpenAIChatClientPort {
  createChatCompletion(request: unknown, signal: AbortSignal): Promise<unknown>;
}

export class OpenAICompatibleAdapter implements ModelPort {
  readonly #client: OpenAIChatClientPort;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #timeoutMilliseconds: number;
  readonly #thinkingMode: "enabled" | "disabled" | undefined;
  readonly #reasoningByToolCall = new Map<string, string>();
  #reasoningBytes = 0;

  public constructor(options: OpenAIChatOptions, client?: OpenAIChatClientPort) {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new ModelAdapterError("invalid_configuration", "OpenAI model configuration is invalid");
    }
    this.#model = parsed.data.model;
    this.#maxTokens = parsed.data.maxTokens;
    this.#timeoutMilliseconds = parsed.data.timeoutMilliseconds;
    this.#thinkingMode = parsed.data.thinkingMode;
    this.#client = client ?? new FetchOpenAIChatClient(parsed.data.baseURL, parsed.data.authToken);
  }

  public async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted === true) {
      throw new ModelAdapterError("cancelled", "OpenAI-compatible request was cancelled");
    }
    const body = createRequest(
      request,
      this.#model,
      this.#maxTokens,
      this.#thinkingMode,
      this.#reasoningByToolCall,
    );
    const deadline = createDeadline(this.#timeoutMilliseconds, signal);
    try {
      const source = await this.#client.createChatCompletion(body, deadline.signal);
      if (deadline.signal.aborted) {
        throw new ModelAdapterError(
          deadline.timedOut() ? "timed_out" : "cancelled",
          deadline.timedOut()
            ? "OpenAI-compatible request timed out"
            : "OpenAI-compatible request was cancelled",
        );
      }
      const parsed = parseResponse(source, this.#thinkingMode);
      this.#rememberReasoning(parsed.toolCalls, parsed.reasoningContent);
      return parsed.response;
    } catch (error: unknown) {
      throw normalizeError(error, deadline.timedOut(), signalIsAborted(signal));
    } finally {
      deadline.dispose();
    }
  }

  #rememberReasoning(
    toolCalls: readonly ToolUseBlock[],
    reasoningContent: string | undefined,
  ): void {
    if (toolCalls.length === 0 || reasoningContent === undefined) return;
    const bytes = Buffer.byteLength(reasoningContent, "utf8");
    if (this.#reasoningBytes + bytes > MAX_REASONING_BYTES) throw invalidResponse();
    for (const call of toolCalls) this.#reasoningByToolCall.set(call.id, reasoningContent);
    this.#reasoningBytes += bytes;
  }
}

class FetchOpenAIChatClient implements OpenAIChatClientPort {
  readonly #url: string;
  readonly #authToken: string;

  public constructor(baseURL: string, authToken: string) {
    this.#url = `${baseURL.replace(/\/+$/u, "")}/chat/completions`;
    this.#authToken = authToken;
  }

  public async createChatCompletion(request: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenAIHttpError(response.status);
    }
    return readBoundedJson(response);
  }
}

class OpenAIHttpError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super("OpenAI-compatible HTTP request failed");
    this.name = "OpenAIHttpError";
    this.status = status;
  }
}

function createRequest(
  request: ModelRequest,
  model: string,
  maxTokens: number,
  thinkingMode: "enabled" | "disabled" | undefined,
  reasoningByToolCall: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  if (request.messages.length > MAX_ITEMS || request.tools.length > MAX_ITEMS) {
    throw new ModelAdapterError("invalid_request", "OpenAI request has too many items");
  }
  const messages = [
    Object.freeze({ role: "system", content: boundedText(request.system) }),
    ...request.messages.flatMap((message) => toOpenAIMessages(message, reasoningByToolCall)),
  ];
  const body = Object.freeze({
    model,
    max_tokens: maxTokens,
    stream: false,
    ...(thinkingMode === undefined ? {} : { thinking: Object.freeze({ type: thinkingMode }) }),
    messages: Object.freeze(messages),
    tools: Object.freeze(request.tools.map(toOpenAITool)),
  });
  if (Buffer.byteLength(stringifyJson(body), "utf8") > MAX_REQUEST_BYTES) {
    throw new ModelAdapterError("invalid_request", "OpenAI request exceeds the size limit");
  }
  return body;
}

function toOpenAIMessages(
  message: ConversationMessage,
  reasoningByToolCall: ReadonlyMap<string, string>,
): readonly Readonly<Record<string, unknown>>[] {
  if (message.role === "user") {
    const text = message.content.filter((block) => block.type === "text");
    const results = message.content.filter((block) => block.type === "tool_result");
    if (text.length > 0 && results.length > 0) throw invalidRequest();
    if (results.length > 0) {
      return results.map((result) =>
        Object.freeze({
          role: "tool",
          tool_call_id: boundedIdentifier(result.toolUseId),
          content: boundedText(result.content),
        }),
      );
    }
    if (text.length !== message.content.length) throw invalidRequest();
    return Object.freeze([
      Object.freeze({
        role: "user",
        content: boundedText(text.map((block) => block.text).join("\n")),
      }),
    ]);
  }

  const text = message.content.filter((block) => block.type === "text");
  const calls = message.content.filter((block) => block.type === "tool_use");
  if (text.length + calls.length !== message.content.length) throw invalidRequest();
  const reasoningContent = calls.length > 0 ? reasoningByToolCall.get(calls[0]!.id) : undefined;
  return Object.freeze([
    Object.freeze({
      role: "assistant",
      content: text.length === 0 ? null : boundedText(text.map((block) => block.text).join("\n")),
      ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
      ...(calls.length === 0
        ? {}
        : {
            tool_calls: Object.freeze(
              calls.map((call) => {
                validateJson(call.input, "tool input");
                return Object.freeze({
                  id: boundedIdentifier(call.id),
                  type: "function",
                  function: Object.freeze({
                    name: boundedIdentifier(call.name),
                    arguments: stringifyJson(call.input),
                  }),
                });
              }),
            ),
          }),
    }),
  ]);
}

function toOpenAITool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
  if (tool.inputSchema["type"] !== "object") throw invalidRequest();
  validateJson(tool.inputSchema, "tool schema");
  return Object.freeze({
    type: "function",
    function: Object.freeze({
      name: boundedIdentifier(tool.name),
      description: boundedText(tool.description),
      parameters: tool.inputSchema,
    }),
  });
}

function parseResponse(
  source: unknown,
  thinkingMode: "enabled" | "disabled" | undefined,
): Readonly<{
  response: ModelResponse;
  toolCalls: readonly ToolUseBlock[];
  reasoningContent?: string;
}> {
  if (!isRecord(source) || typeof source["model"] !== "string") throw invalidResponse();
  const choices = source["choices"];
  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw invalidResponse();
  }
  const choice = choices[0];
  const message = choice["message"];
  if (!isRecord(message) || message["role"] !== "assistant") throw invalidResponse();

  const blocks: Array<Readonly<{ type: "text"; text: string }> | ToolUseBlock> = [];
  const content = message["content"];
  if (content !== null && content !== undefined) {
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) {
      throw invalidResponse();
    }
    if (content.length > 0) blocks.push(Object.freeze({ type: "text", text: content }));
  }
  const toolCalls = parseToolCalls(message["tool_calls"]);
  blocks.push(...toolCalls);

  const reasoningContent = message["reasoning_content"];
  if (reasoningContent !== undefined && reasoningContent !== null) {
    if (
      thinkingMode !== "enabled" ||
      typeof reasoningContent !== "string" ||
      Buffer.byteLength(reasoningContent, "utf8") > MAX_REASONING_BYTES
    ) {
      throw invalidResponse();
    }
  }
  const frozenToolCalls = Object.freeze(toolCalls);
  const response = Object.freeze({
    message: Object.freeze({ role: "assistant" as const, content: Object.freeze(blocks) }),
    stopReason: parseFinishReason(choice["finish_reason"]),
    toolCalls: frozenToolCalls,
    model: boundedResponseIdentifier(source["model"]),
    usage: parseUsage(source["usage"]),
  });
  return Object.freeze({
    response,
    toolCalls: frozenToolCalls,
    ...(typeof reasoningContent === "string" && toolCalls.length > 0 ? { reasoningContent } : {}),
  });
}

function parseToolCalls(source: unknown): ToolUseBlock[] {
  if (source === undefined || source === null) return [];
  if (!Array.isArray(source) || source.length > MAX_ITEMS) throw invalidResponse();
  return source.map((call): ToolUseBlock => {
    if (!isRecord(call) || call["type"] !== "function" || typeof call["id"] !== "string") {
      throw invalidResponse();
    }
    const fn = call["function"];
    if (!isRecord(fn) || typeof fn["name"] !== "string" || typeof fn["arguments"] !== "string") {
      throw invalidResponse();
    }
    if (Buffer.byteLength(fn["arguments"], "utf8") > MAX_TOOL_INPUT_BYTES) throw invalidResponse();
    let input: unknown;
    try {
      input = JSON.parse(fn["arguments"]);
    } catch {
      throw invalidResponse();
    }
    if (!isJsonValue(input, 0, new WeakSet<object>())) throw invalidResponse();
    return Object.freeze({
      type: "tool_use",
      id: boundedResponseIdentifier(call["id"]),
      name: boundedResponseIdentifier(fn["name"]),
      input,
    });
  });
}

function parseUsage(source: unknown): ModelUsage {
  if (!isRecord(source)) throw invalidResponse();
  const promptTokens = tokenCount(source["prompt_tokens"]);
  const completionTokens = tokenCount(source["completion_tokens"]);
  let cachedTokens = 0;
  const details = source["prompt_tokens_details"];
  if (isRecord(details) && details["cached_tokens"] !== undefined) {
    cachedTokens = tokenCount(details["cached_tokens"]);
  } else if (source["prompt_cache_hit_tokens"] !== undefined) {
    cachedTokens = tokenCount(source["prompt_cache_hit_tokens"]);
  }
  if (cachedTokens > promptTokens) throw invalidResponse();
  return Object.freeze({
    inputTokens: promptTokens - cachedTokens,
    outputTokens: completionTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedTokens,
  });
}

function parseFinishReason(source: unknown): ModelStopReason {
  if (source === "stop") return "end_turn";
  if (source === "tool_calls" || source === "function_call") return "tool_use";
  if (source === "length") return "max_tokens";
  if (source === "content_filter") return "refusal";
  if (typeof source === "string") return "unknown";
  throw invalidResponse();
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null)
    throw new ModelAdapterError("invalid_response", "Response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result: unknown = await reader.read();
    if (!isRecord(result) || typeof result["done"] !== "boolean") throw invalidResponse();
    if (result["done"]) break;
    const chunk = result["value"];
    if (!(chunk instanceof Uint8Array)) throw invalidResponse();
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ModelAdapterError("invalid_response", "Response body exceeds the size limit");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ModelAdapterError("invalid_response", "Response body is invalid JSON");
  }
}

function normalizeError(
  error: unknown,
  timedOut: boolean,
  externallyCancelled: boolean,
): ModelAdapterError {
  if (error instanceof ModelAdapterError) return error;
  if (timedOut) return new ModelAdapterError("timed_out", "OpenAI-compatible request timed out");
  if (externallyCancelled || isAbortError(error)) {
    return new ModelAdapterError("cancelled", "OpenAI-compatible request was cancelled");
  }
  const status = error instanceof OpenAIHttpError ? error.status : errorStatus(error);
  if (status === 401 || status === 403) {
    return new ModelAdapterError(
      "authentication_failed",
      "OpenAI-compatible authentication failed",
    );
  }
  if (status === 429) {
    return new ModelAdapterError("rate_limited", "OpenAI-compatible rate limit exceeded");
  }
  return new ModelAdapterError("provider_failed", "OpenAI-compatible request failed");
}

function errorStatus(error: unknown): unknown {
  return isRecord(error) ? error["status"] : undefined;
}

function validateJson(source: unknown, label: string): void {
  if (!isJsonValue(source, 0, new WeakSet<object>())) {
    throw new ModelAdapterError("invalid_request", `${label} is not valid JSON`);
  }
  if (Buffer.byteLength(stringifyJson(source), "utf8") > MAX_TOOL_INPUT_BYTES) {
    throw new ModelAdapterError("invalid_request", `${label} exceeds the size limit`);
  }
}

function isJsonValue(source: unknown, depth: number, seen: WeakSet<object>): boolean {
  if (source === null || typeof source === "string" || typeof source === "boolean") return true;
  if (typeof source === "number") return Number.isFinite(source);
  if (typeof source !== "object" || depth > MAX_JSON_DEPTH || seen.has(source)) return false;
  seen.add(source);
  if (Array.isArray(source)) {
    return source.length <= MAX_ITEMS && source.every((item) => isJsonValue(item, depth + 1, seen));
  }
  const prototype: unknown = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(source);
  return (
    entries.length <= MAX_ITEMS &&
    entries.every(([key, value]) => key.length <= 1_000 && isJsonValue(value, depth + 1, seen))
  );
}

function stringifyJson(source: unknown): string {
  try {
    const value = JSON.stringify(source);
    if (value === undefined) throw new Error("not JSON");
    return value;
  } catch {
    throw invalidRequest();
  }
}

function boundedText(source: string): string {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_TEXT_BYTES) {
    throw invalidRequest();
  }
  return source;
}

function boundedIdentifier(source: string): string {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > 200 ||
    source.includes("\0")
  ) {
    throw invalidRequest();
  }
  return source;
}

function boundedResponseIdentifier(source: string): string {
  if (source.length === 0 || source.length > 200 || source.includes("\0")) throw invalidResponse();
  return source;
}

function tokenCount(source: unknown): number {
  if (typeof source !== "number" || !Number.isSafeInteger(source) || source < 0)
    throw invalidResponse();
  return source;
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

function invalidRequest(): ModelAdapterError {
  return new ModelAdapterError("invalid_request", "OpenAI-compatible request is invalid");
}

function invalidResponse(): ModelAdapterError {
  return new ModelAdapterError("invalid_response", "OpenAI-compatible response is invalid");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function signalIsAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDeadline(
  timeoutMilliseconds: number,
  externalSignal?: AbortSignal,
): Readonly<{ signal: AbortSignal; timedOut(): boolean; dispose(): void }> {
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
