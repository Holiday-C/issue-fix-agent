import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicMessagesAdapter,
  AnthropicModelError,
  type AnthropicClientPort,
} from "../../src/model/anthropic-messages-adapter.js";
import type { ModelRequest } from "../../src/model/types.js";

afterEach(() => vi.useRealTimers());

describe("AnthropicMessagesAdapter", () => {
  it("maps provider-neutral messages, tools, response blocks, and usage", async () => {
    const client = new RecordingClient(() => Promise.resolve(validResponse));
    const adapter = createAdapter(client);

    const response = await adapter.complete(modelRequest);

    expect(response).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting." },
          {
            type: "tool_use",
            id: "provider-call",
            name: "read_file",
            input: { path: "src/example.ts" },
          },
        ],
      },
      stopReason: "tool_use",
      toolCalls: [
        {
          type: "tool_use",
          id: "provider-call",
          name: "read_file",
          input: { path: "src/example.ts" },
        },
      ],
      model: "claude-test",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 20,
      },
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      model: "claude-configured",
      max_tokens: 4_096,
      system: "System instructions",
      messages: [
        { role: "user", content: [{ type: "text", text: "Fix it" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "src/example.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "file content",
              is_error: false,
            },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read one file",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(JSON.stringify(client.requests[0])).not.toContain("test-api-key");
  });

  it.each([
    [providerError(401), "authentication_failed"],
    [providerError(429), "rate_limited"],
    [new Error("provider details"), "provider_failed"],
  ] as const)("normalizes provider error %j as %s", async (error, code) => {
    const client = new RecordingClient(() => Promise.reject(error));

    await expect(createAdapter(client).complete(modelRequest)).rejects.toMatchObject({
      name: "AnthropicModelError",
      code,
    });
  });

  it("rejects unsupported or malformed provider content", async () => {
    const client = new RecordingClient(() =>
      Promise.resolve({ ...validResponse, content: [{ type: "thinking", thinking: "hidden" }] }),
    );

    await expect(createAdapter(client).complete(modelRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    ["end_turn", "end_turn"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["pause_turn", "pause_turn"],
    ["refusal", "refusal"],
    ["model_context_window_exceeded", "context_window_exceeded"],
  ] as const)("maps stop reason %s as %s", async (providerReason, expectedReason) => {
    const client = new RecordingClient(() =>
      Promise.resolve({ ...validResponse, stop_reason: providerReason }),
    );

    await expect(createAdapter(client).complete(modelRequest)).resolves.toMatchObject({
      stopReason: expectedReason,
    });
  });

  it("cancels before calling the provider when the caller is already aborted", async () => {
    const client = new RecordingClient(() => Promise.resolve(validResponse));
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAdapter(client).complete(modelRequest, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(client.requests).toEqual([]);
  });

  it("propagates cancellation while a provider request is running", async () => {
    const client = new RecordingClient(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = createAdapter(client).complete(modelRequest, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "cancelled" });

    controller.abort();

    await rejection;
  });

  it("enforces its request timeout through the provider signal", async () => {
    vi.useFakeTimers();
    const client = new RecordingClient(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const adapter = new AnthropicMessagesAdapter(
      {
        apiKey: "test-api-key",
        model: "claude-configured",
        maxTokens: 4_096,
        timeoutMilliseconds: 25,
      },
      client,
    );
    const pending = adapter.complete(modelRequest);
    const rejection = expect(pending).rejects.toMatchObject({ code: "timed_out" });

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("rejects invalid configuration and tool schemas before a provider call", async () => {
    expect(
      () =>
        new AnthropicMessagesAdapter({
          apiKey: "",
          model: "claude-configured",
          maxTokens: 4_096,
        }),
    ).toThrow(AnthropicModelError);
    const client = new RecordingClient(() => Promise.resolve(validResponse));
    const invalidRequest: ModelRequest = {
      ...modelRequest,
      tools: [{ ...modelRequest.tools[0]!, inputSchema: { type: "array" } }],
    };

    await expect(createAdapter(client).complete(invalidRequest)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(client.requests).toEqual([]);
  });
});

class RecordingClient implements AnthropicClientPort {
  public readonly requests: unknown[] = [];
  readonly #handler: (request: unknown, signal: AbortSignal) => Promise<unknown>;

  public constructor(handler: (request: unknown, signal: AbortSignal) => Promise<unknown>) {
    this.#handler = handler;
  }

  public async createMessage(request: unknown, signal: AbortSignal): Promise<unknown> {
    this.requests.push(request);
    return this.#handler(request, signal);
  }
}

function createAdapter(client: AnthropicClientPort): AnthropicMessagesAdapter {
  return new AnthropicMessagesAdapter(
    {
      apiKey: "test-api-key",
      model: "claude-configured",
      maxTokens: 4_096,
      timeoutMilliseconds: 5_000,
    },
    client,
  );
}

const modelRequest: ModelRequest = {
  system: "System instructions",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Fix it" }],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "read_file",
          input: { path: "src/example.ts" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "call-1",
          content: "file content",
          isError: false,
        },
      ],
    },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read one file",
      inputSchema: { type: "object" },
    },
  ],
};

const validResponse = Object.freeze({
  id: "message-1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  stop_reason: "tool_use",
  stop_sequence: null,
  content: Object.freeze([
    Object.freeze({ type: "text", text: "Inspecting." }),
    Object.freeze({
      type: "tool_use",
      id: "provider-call",
      name: "read_file",
      input: Object.freeze({ path: "src/example.ts" }),
    }),
  ]),
  usage: Object.freeze({
    input_tokens: 120,
    output_tokens: 30,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 20,
  }),
});

function providerError(status: number): Error & Readonly<{ status: number }> {
  return Object.assign(new Error("provider details"), { status });
}
