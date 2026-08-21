import { describe, expect, it } from "vitest";

import {
  countToolErrors,
  credentialValues,
  extractPatchPaths,
  isRegressionFree,
  LiveM4ConfigurationError,
  loadLiveM4Config,
  parseLiveM4CliResult,
  parseLiveM4Verification,
} from "../../evals/live-m4.js";

describe("M4 live evaluation support", () => {
  it("requires a distinct explicit paid-evaluation switch", () => {
    expect(() =>
      loadLiveM4Config(
        {
          ISSUE_FIX_LIVE_EVAL: "1",
          ANTHROPIC_API_KEY: "key",
          ANTHROPIC_MODEL: "model",
          ANTHROPIC_PRICING: "1,2,3,4",
        },
        "/workspace",
      ),
    ).toThrow(LiveM4ConfigurationError);
  });

  it("loads bounded Anthropic configuration without retaining credentials", () => {
    const config = loadLiveM4Config(
      {
        ISSUE_FIX_M4_LIVE_EVAL: "1",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_BASE_URL: "https://gateway.example/anthropic",
        ANTHROPIC_MODEL: "model-a",
        ANTHROPIC_PRICING: "1,2,3,4",
        ISSUE_FIX_MAX_COST_USD: "0.5",
        ISSUE_FIX_M4_MAX_TOTAL_COST_USD: "2",
      },
      "/workspace",
    );

    expect(config).toEqual({
      protocol: "anthropic",
      model: "model-a",
      pricing: "1,2,3,4",
      maxCostUsdPerRun: 0.5,
      maxTotalCostUsd: 2,
      outputRoot: "/workspace/.tmp",
      baseURL: "https://gateway.example/anthropic",
      thinkingMode: "disabled",
    });
    expect(JSON.stringify(config)).not.toContain("gateway-token");
  });

  it("supports explicit OpenAI-compatible configuration", () => {
    const config = loadLiveM4Config(
      {
        ISSUE_FIX_M4_LIVE_EVAL: "1",
        ISSUE_FIX_MODEL_PROTOCOL: "openai",
        OPENAI_AUTH_TOKEN: "token",
        OPENAI_BASE_URL: "https://gateway.example/v1",
        OPENAI_MODEL: "model-b",
        OPENAI_PRICING: "1,2,0,0",
        OPENAI_THINKING: "enabled",
      },
      "/workspace",
    );

    expect(config).toMatchObject({
      protocol: "openai",
      model: "model-b",
      thinkingMode: "enabled",
    });
    expect(JSON.stringify(config)).not.toContain('"token"');
  });

  it("rejects invalid pricing and inconsistent cost ceilings", () => {
    const base = {
      ISSUE_FIX_M4_LIVE_EVAL: "1",
      ANTHROPIC_API_KEY: "key",
      ANTHROPIC_MODEL: "model",
      ANTHROPIC_PRICING: "1,2,3,4",
    };
    expect(() => loadLiveM4Config({ ...base, ANTHROPIC_PRICING: "1,2" }, "/w")).toThrow(
      "ANTHROPIC_PRICING",
    );
    expect(() =>
      loadLiveM4Config(
        {
          ...base,
          ISSUE_FIX_MAX_COST_USD: "3",
          ISSUE_FIX_M4_MAX_TOTAL_COST_USD: "2",
        },
        "/w",
      ),
    ).toThrow("must not exceed");
  });

  it("parses bounded public results and verification evidence", () => {
    const run = parseLiveM4CliResult(
      JSON.stringify({
        status: "failed",
        reason: "verification_failed",
        runId: "run-1",
        artifactDirectory: "/evidence/run-1",
        changedFiles: 1,
        scopeCompliant: true,
        usage: {
          iterations: 2,
          elapsedMilliseconds: 100,
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalInputTokens: 10,
          estimatedCostUsd: 0.01,
          models: ["model"],
        },
      }),
    );
    const verification = parseLiveM4Verification(
      JSON.stringify({
        verdict: "failed",
        completedAllChecks: true,
        checks: [
          { index: 0, status: "passed", stdout: { text: "private" } },
          { index: 1, status: "non_zero_exit" },
        ],
      }),
    );

    expect(run).toMatchObject({ status: "failed", verification: null, changedFiles: 1 });
    expect(verification).toEqual({
      verdict: "failed",
      checks: [
        { index: 0, status: "passed" },
        { index: 1, status: "non_zero_exit" },
      ],
    });
    expect(JSON.stringify(verification)).not.toContain("private");
    expect(
      parseLiveM4Verification(JSON.stringify({ verdict: "not_run", reason: "blocked" })),
    ).toBeNull();
  });

  it("accepts only the declared pattern of verification failures", () => {
    const verification = parseLiveM4Verification(
      JSON.stringify({
        verdict: "failed",
        checks: [
          { index: 0, status: "passed" },
          { index: 1, status: "non_zero_exit" },
        ],
      }),
    );

    expect(isRegressionFree(verification, 2, [1])).toBe(true);
    expect(isRegressionFree(verification, 2, [])).toBe(false);
    expect(isRegressionFree(verification, 3, [1])).toBe(false);
    expect(isRegressionFree(null, 2, [1])).toBe(false);
  });

  it("counts tool errors and extracts sorted patch paths", () => {
    const trace = [
      { type: "tool_completed", iteration: 1, metadata: { tool: "read_file", isError: false } },
      { type: "tool_completed", iteration: 1, metadata: { tool: "apply_patch", isError: true } },
      { type: "run_completed", iteration: 1 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    const patch = [
      "diff --git a/src/z.js b/src/z.js",
      "diff --git a/src/a.js b/src/a.js",
      "diff --git a/old.js b/new.js",
    ].join("\n");

    expect(countToolErrors(trace)).toBe(1);
    expect(extractPatchPaths(patch)).toEqual(["src/a.js", "src/z.js"]);
  });

  it("returns credentials only for in-memory disclosure checks", () => {
    expect(
      credentialValues({
        ANTHROPIC_AUTH_TOKEN: "a",
        ANTHROPIC_API_KEY: "b",
        OPENAI_AUTH_TOKEN: "c",
      }),
    ).toEqual(["a", "b", "c"]);
  });
});
