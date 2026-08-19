import { describe, expect, it } from "vitest";

import { LiveM3ConfigurationError, loadLiveM3Config } from "../../evals/live-m3-config.js";

describe("loadLiveM3Config", () => {
  it("requires an explicit paid-evaluation switch and credentials", () => {
    expect(() => loadLiveM3Config({}, "/workspace")).toThrow(LiveM3ConfigurationError);
    expect(() =>
      loadLiveM3Config(
        {
          ISSUE_FIX_LIVE_EVAL: "1",
          ANTHROPIC_MODEL: "claude-test",
          ANTHROPIC_PRICING: "1,2,3,4",
        },
        "/workspace",
      ),
    ).toThrow("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is required");
  });

  it("supports an Anthropic-compatible base URL and auth token without retaining the token", () => {
    const config = loadLiveM3Config(
      {
        ISSUE_FIX_LIVE_EVAL: "1",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_BASE_URL: "https://gateway.example/v1",
        ANTHROPIC_MODEL: "qwen3.8-max-preview[1m]",
        ANTHROPIC_PRICING: "1,2,3,4",
        ANTHROPIC_THINKING: "enabled",
      },
      "/workspace",
    );

    expect(config).toMatchObject({
      model: "qwen3.8-max-preview[1m]",
      baseURL: "https://gateway.example/v1",
      thinkingMode: "enabled",
    });
    expect(JSON.stringify(config)).not.toContain("gateway-token");
  });

  it("returns bounded non-secret configuration", () => {
    const config = loadLiveM3Config(
      {
        ISSUE_FIX_LIVE_EVAL: "1",
        ANTHROPIC_API_KEY: "must-not-be-returned",
        ANTHROPIC_MODEL: "claude-test",
        ANTHROPIC_PRICING: "1,2,3,4",
        ISSUE_FIX_MAX_COST_USD: "2.5",
        ISSUE_FIX_EVAL_OUTPUT_ROOT: "evidence",
      },
      "/workspace",
    );

    expect(config).toEqual({
      model: "claude-test",
      pricing: "1,2,3,4",
      maxCostUsd: 2.5,
      outputRoot: "/workspace/evidence",
      thinkingMode: "disabled",
    });
    expect(JSON.stringify(config)).not.toContain("must-not-be-returned");
  });

  it.each(["1,2,3", "1,2,,4", "1,2,-3,4", "not-pricing"])(
    "rejects invalid pricing %s",
    (pricing) => {
      expect(() =>
        loadLiveM3Config(
          {
            ISSUE_FIX_LIVE_EVAL: "1",
            ANTHROPIC_API_KEY: "key",
            ANTHROPIC_MODEL: "claude-test",
            ANTHROPIC_PRICING: pricing,
          },
          "/workspace",
        ),
      ).toThrow("ANTHROPIC_PRICING");
    },
  );
});
