import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock agent module before any imports
vi.mock("../src/agent.js", () => ({
  invokeAgent: vi.fn(),
  setAgentPath: vi.fn(),
  clearSessions: vi.fn(),
  resolveModel: vi.fn((tag: string) =>
    tag === "medium" ? "ollama-cloud/deepseek-v4-flash" : tag,
  ),
}));

import { z } from "zod";
import { weave } from "../src/builder.js";
import type { AgentResult } from "../src/types.js";

const mockInvokeAgent = (await import("../src/agent.js")).invokeAgent as ReturnType<
  typeof vi.fn
>;

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    duration: 100,
    ok: true,
    ...overrides,
  };
}

const AnalyzeSchema = z.object({
  bugs: z.array(
    z.object({
      severity: z.enum(["low", "medium", "high"]),
      description: z.string(),
    }),
  ),
});

// ── Builder tests ───────────────────────────────────────────────────────────

describe("Weft Builder", () => {
  it("should build a simple chain", () => {
    const pipeline = weave("test")
      .prompt("analyze", (ctx) => `Analyze ${ctx.lang}`, {})
      .build();

    expect(pipeline).toBeDefined();
    expect(typeof pipeline.run).toBe("function");
  });

  it("should support step() between prompts", () => {
    const pipeline = weave("test")
      .prompt("fetch", () => "fetch", {})
      .step("parse", (ctx) => ({
        count: 42,
        text: ctx.fetch.stdout,
      }))
      .prompt("analyze", (ctx) => `count=${ctx.parse.count}`, {})
      .build();

    expect(pipeline).toBeDefined();
  });

  it("should support schema validation", () => {
    const pipeline = weave("test")
      .prompt("audit", () => "audit", { schema: AnalyzeSchema })
      .build();

    expect(pipeline).toBeDefined();
  });
});

// ── Executor tests ──────────────────────────────────────────────────────────

describe("Weft Executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvokeAgent.mockReset();
  });

  it("should execute a simple chain and accumulate ctx", async () => {
    mockInvokeAgent.mockResolvedValue(makeResult({ stdout: "analysis result" }));

    const pipeline = weave("test")
      .prompt("analyze", (ctx) => `Analyze ${ctx.lang} code`, {})
      .build();

    const result = await pipeline.run({ lang: "ts" });

    expect(result.lang).toBe("ts");
    expect(result.analyze).toEqual(makeResult({ stdout: "analysis result" }));
    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
  });

  it("should pass full ctx between steps", async () => {
    mockInvokeAgent
      .mockResolvedValueOnce(makeResult({ stdout: "step1 output" }))
      .mockResolvedValueOnce(makeResult({ stdout: "step2 processed" }));

    const pipeline = weave("test")
      .prompt("step1", () => "prompt1", {})
      .prompt("step2", (ctx) => `Process: ${ctx.step1.stdout}`, {})
      .build();

    const result = await pipeline.run({});

    expect(result.step1.stdout).toBe("step1 output");
    expect(result.step2.stdout).toBe("step2 processed");
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
  });

  it("should transform ctx with step()", async () => {
    mockInvokeAgent
      .mockResolvedValueOnce(makeResult({ stdout: '{"count": 42}' }))
      .mockResolvedValueOnce(makeResult({ stdout: "final" }));

    const pipeline = weave("test")
      .prompt("fetch", () => "fetch", {})
      .step("parse", (ctx) => ({
        count: JSON.parse(ctx.fetch.stdout).count as number,
      }))
      .prompt("analyze", (ctx) => `count=${ctx.parse.count}`, {})
      .build();

    const result = await pipeline.run({});

    expect(result.fetch.stdout).toBe('{"count": 42}');
    expect(result.parse.count).toBe(42);
    expect(result.analyze.stdout).toBe("final");
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
  });

  it("should validate schema successfully", async () => {
    mockInvokeAgent.mockResolvedValue(
      makeResult({
        stdout: JSON.stringify({
          bugs: [{ severity: "high", description: "crash on null" }],
        }),
      }),
    );

    const pipeline = weave("test")
      .prompt("audit", () => "audit", { schema: AnalyzeSchema })
      .build();

    const result = await pipeline.run({});

    expect(result.audit).toEqual({
      bugs: [{ severity: "high", description: "crash on null" }],
    });
  });

  it("should retry on schema validation failure", async () => {
    mockInvokeAgent
      .mockResolvedValueOnce(makeResult({ stdout: "not json" }))
      .mockResolvedValueOnce(
        makeResult({
          stdout: JSON.stringify({
            bugs: [{ severity: "low", description: "minor" }],
          }),
        }),
      );

    const pipeline = weave("test")
      .prompt("audit", () => "audit", { schema: AnalyzeSchema })
      .build();

    const result = await pipeline.run({});

    expect(result.audit).toEqual({
      bugs: [{ severity: "low", description: "minor" }],
    });
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
  });

  it("should handle parallel execution", async () => {
    mockInvokeAgent
      .mockResolvedValueOnce(makeResult({ stdout: "setup done" }))
      .mockResolvedValueOnce(makeResult({ stdout: "audit result" }))
      .mockResolvedValueOnce(makeResult({ stdout: "lint result" }))
      .mockResolvedValueOnce(makeResult({ stdout: "format result" }));

    const pipeline = weave("test")
      .prompt("setup", () => "setup", {})
      .parallel({
        security: weave()
          .prompt("audit", () => "audit", {})
          .step("score", (ctx) => ctx.audit.stdout.length),

        quality: weave()
          .prompt("lint", () => "lint", {})
          .prompt("format", () => "format", {}),
      })
      .build();

    const result = await pipeline.run({});

    expect(result.setup.stdout).toBe("setup done");
    expect(result.audit.stdout).toBe("audit result");
    expect(result.score).toBeTypeOf("number");
    expect(result.lint.stdout).toBe("lint result");
    expect(result.format.stdout).toBe("format result");
  });

  it("should handle retry on failure", async () => {
    mockInvokeAgent
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(makeResult({ stdout: "recovered" }));

    const pipeline = weave("test")
      .prompt("flaky", () => "retry me", { retry: 2 })
      .build();

    const result = await pipeline.run({});

    expect(result.flaky.stdout).toBe("recovered");
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
  });

  it("should continue on error", async () => {
    mockInvokeAgent
      .mockRejectedValueOnce(new Error("optional failed"))
      .mockResolvedValueOnce(makeResult({ stdout: "main result" }));

    const pipeline = weave("test")
      .prompt("optional", () => "optional", { continueOnError: true })
      .prompt("main", () => "main", {})
      .build();

    const result = await pipeline.run({});

    expect(result.main.stdout).toBe("main result");
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);
  });

  it("should dry-run without executing", async () => {
    const pipeline = weave("test")
      .prompt("step1", () => "prompt", {})
      .prompt("step2", (ctx) => `based on: ${ctx.step1.stdout}`, {})
      .build();

    const result = await pipeline.run({}, { dryRun: true });

    // dryRun returns the initial ctx unchanged
    expect(result).toEqual({});
    expect(mockInvokeAgent).not.toHaveBeenCalled();
  });

  it("should handle AbortSignal", async () => {
    mockInvokeAgent.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1000),
        ),
    );

    const controller = new AbortController();
    const pipeline = weave("test")
      .prompt("slow", () => "slow", {})
      .build();

    controller.abort();

    await expect(pipeline.run({}, { signal: controller.signal })).rejects.toThrow(
      "Aborted",
    );
  });
});

// ── Schema-to-prompt tests ──────────────────────────────────────────────────

describe("Zod schema to prompt", () => {
  it("should describe simple object", async () => {
    const { schemaToPrompt } = await import("../src/schema-to-prompt.js");
    const schema = z.object({ name: z.string(), age: z.number() });
    const prompt = schemaToPrompt(schema);
    expect(prompt).toContain("name: string");
    expect(prompt).toContain("age: number");
    expect(prompt).toContain("VALID JSON");
  });

  it("should describe nested objects", async () => {
    const { schemaToPrompt } = await import("../src/schema-to-prompt.js");
    const schema = z.object({
      user: z.object({
        name: z.string(),
        tags: z.array(z.string()),
      }),
    });
    const prompt = schemaToPrompt(schema);
    expect(prompt).toContain("user:");
    expect(prompt).toContain("tags: [string, ...]");
  });

  it("should describe enums", async () => {
    const { schemaToPrompt } = await import("../src/schema-to-prompt.js");
    const schema = z.object({
      status: z.enum(["active", "inactive"]),
    });
    const prompt = schemaToPrompt(schema);
    expect(prompt).toContain('"active" | "inactive"');
  });

  it("should describe optional fields", async () => {
    const { schemaToPrompt } = await import("../src/schema-to-prompt.js");
    const schema = z.object({
      name: z.string(),
      email: z.string().optional(),
    });
    const prompt = schemaToPrompt(schema);
    expect(prompt).toContain("email: string (optional)");
  });
});
