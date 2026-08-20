import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OpenAICompatibleAdapter,
  type OpenAIChatClientPort,
} from "../../src/model/openai-chat-adapter.js";
import type { ModelRequest } from "../../src/model/types.js";

afterEach(() => vi.useRealTimers());

describe("OpenAICompatibleAdapter", () => {
  it("maps messages, functions, tool calls, stop reasons, and cached usage", async () => {
    const client = new RecordingClient(() => Promise.resolve(validResponse));
    const adapter = createAdapter(client);

    const response = await adapter.complete(modelRequest);

    expect(response).toMatchObject({
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
      model: "deepseek-v4-flash",
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 20,
      },
    });
    expect(client.requests[0]).toMatchObject({
      model: "deepseek-v4-flash[1m]",
      max_tokens: 4_096,
      messages: [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Fix it" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/example.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file content" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read one file",
            parameters: { type: "object" },
          },
        },
      ],
    });
    expect(client.requests[0]).not.toHaveProperty("thinking");
  });

  it.each([
    [providerError(401), "authentication_failed"],
    [providerError(429), "rate_limited"],
    [new Error("provider details"), "provider_failed"],
  ] as const)("normalizes provider error %j as %s", async (error, code) => {
    const client = new RecordingClient(() => Promise.reject(error));

    await expect(createAdapter(client).complete(modelRequest)).rejects.toMatchObject({ code });
  });

  it("rejects malformed function arguments", async () => {
    const client = new RecordingClient(() =>
      Promise.resolve({
        ...validResponse,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call",
                  type: "function",
                  function: { name: "read_file", arguments: "not-json" },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(createAdapter(client).complete(modelRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects unrequested reasoning content", async () => {
    const client = new RecordingClient(() =>
      Promise.resolve({
        ...validResponse,
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Done",
              reasoning_content: "hidden",
            },
          },
        ],
      }),
    );

    await expect(createAdapter(client).complete(modelRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("replays reasoning content opaquely for matching tool calls", async () => {
    const hidden = "private reasoning";
    const responses: unknown[] = [
      {
        ...validResponse,
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              reasoning_content: hidden,
              tool_calls: [
                {
                  id: "thinking-call",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"src/example.ts"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        ...validResponse,
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Done", tool_calls: null },
          },
        ],
      },
    ];
    const client = new RecordingClient(() => Promise.resolve(responses.shift()));
    const adapter = new OpenAICompatibleAdapter(
      {
        baseURL: "https://api.example/v1",
        authToken: "test-token",
        model: "deepseek-v4-flash[1m]",
        maxTokens: 4_096,
        thinkingMode: "enabled",
      },
      client,
    );

    const first = await adapter.complete(modelRequest);
    expect(JSON.stringify(first)).not.toContain(hidden);
    await adapter.complete({
      system: modelRequest.system,
      tools: modelRequest.tools,
      messages: [
        { role: "user", content: [{ type: "text", text: "Fix it" }] },
        first.message,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "thinking-call",
              content: "file content",
              isError: false,
            },
          ],
        },
      ],
    });

    expect(client.requests[1]).toMatchObject({
      messages: [
        { role: "system" },
        { role: "user" },
        { role: "assistant", reasoning_content: hidden },
        { role: "tool", tool_call_id: "thinking-call" },
      ],
    });
    expect(client.requests[0]).toMatchObject({ thinking: { type: "enabled" } });
  });

  it("enforces timeout and cancellation through the client signal", async () => {
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
    const adapter = new OpenAICompatibleAdapter(
      {
        baseURL: "https://api.example/v1",
        authToken: "test-token",
        model: "model",
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

  it("cancels before calling the client when the host is already aborted", async () => {
    const client = new RecordingClient(() => Promise.resolve(validResponse));
    const controller = new AbortController();
    controller.abort();

    await expect(
      createAdapter(client).complete(modelRequest, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(client.requests).toEqual([]);
  });

  it("rejects invalid endpoint configuration", () => {
    expect(
      () =>
        new OpenAICompatibleAdapter({
          baseURL: "https://user:password@api.example/v1",
          authToken: "test-token",
          model: "model",
          maxTokens: 4_096,
        }),
    ).toThrow("OpenAI model configuration is invalid");
  });
});

class RecordingClient implements OpenAIChatClientPort {
  public readonly requests: unknown[] = [];
  readonly #handler: (request: unknown, signal: AbortSignal) => Promise<unknown>;

  public constructor(handler: (request: unknown, signal: AbortSignal) => Promise<unknown>) {
    this.#handler = handler;
  }

  public createChatCompletion(request: unknown, signal: AbortSignal): Promise<unknown> {
    this.requests.push(request);
    return this.#handler(request, signal);
  }
}

function createAdapter(client: OpenAIChatClientPort): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(
    {
      baseURL: "https://api.example/v1",
      authToken: "test-token",
      model: "deepseek-v4-flash[1m]",
      maxTokens: 4_096,
    },
    client,
  );
}

function providerError(status: number): Error & Readonly<{ status: number }> {
  return Object.assign(new Error("provider details"), { status });
}

const modelRequest: ModelRequest = {
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
          toolUseId: "call-1",
          content: "file content",
          isError: false,
        },
      ],
    },
  ],
  tools: [{ name: "read_file", description: "Read one file", inputSchema: { type: "object" } }],
};

const validResponse = {
  id: "completion-1",
  model: "deepseek-v4-flash",
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "Inspecting.",
        tool_calls: [
          {
            id: "provider-call",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/example.ts"}' },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 20 },
  },
};
