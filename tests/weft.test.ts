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
import { WeftSchemaValidationError } from "../src/zod-middleware.js";

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

  it("should throw a pretty error on final invalid JSON failure", async () => {
    mockInvokeAgent.mockResolvedValue(makeResult({ stdout: "not valid json" }));

    const pipeline = weave("test")
      .prompt("audit", () => "audit", { schema: AnalyzeSchema })
      .build();

    const err = await pipeline.run({}).catch((e) => e) as WeftSchemaValidationError;

    expect(err).toBeInstanceOf(WeftSchemaValidationError);
    expect(err.rawResponse).toBe("not valid json");
    expect(err.extractedResponse).toBe("not valid json");
    expect(err.validationIssues).toEqual([
      {
        path: "(root)",
        message: expect.stringContaining("Failed to parse JSON"),
      },
    ]);
  });

  it("should throw a pretty error with Zod issues on final validation failure", async () => {
    mockInvokeAgent.mockResolvedValue(
      makeResult({
        stdout: JSON.stringify({
          bugs: [{ severity: "critical", description: "crash" }],
        }),
      }),
    );

    const pipeline = weave("test")
      .prompt("audit", () => "audit", { schema: AnalyzeSchema })
      .build();

    const err = await pipeline.run({}).catch((e) => e) as WeftSchemaValidationError;

    expect(err).toBeInstanceOf(WeftSchemaValidationError);
    expect(err.rawResponse).toBe(
      JSON.stringify({ bugs: [{ severity: "critical", description: "crash" }] }),
    );
    expect(err.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "bugs.0.severity",
          message: expect.any(String),
        }),
      ]),
    );
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
    expect(prompt).toContain('"name": string');
    expect(prompt).toContain('"age": number');
    expect(prompt).toContain("JSON object containing the actual data");
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
    expect(prompt).toContain('"user":');
    expect(prompt).toContain('"tags": [string]');
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
    expect(prompt).toContain('"email": string (optional)');
  });

  it("should include example data and forbid schema echo", async () => {
    const { schemaToPrompt } = await import("../src/schema-to-prompt.js");
    const schema = z.object({
      title: z.string(),
      content: z.string(),
      keywords: z.array(z.string()),
    });
    const prompt = schemaToPrompt(schema);
    expect(prompt).toContain("Do NOT echo or repeat the schema description");
    expect(prompt).toContain("Do NOT use TypeScript syntax");
    expect(prompt).toContain("Example of correct answer:");
    expect(prompt).toContain('"title": ""');
    expect(prompt).toContain('"keywords": []');
  });
});

// ── Schema echo detection tests ─────────────────────────────────────────────

describe("Schema echo detection", () => {
  it("detects TS-style type annotations", async () => {
    const { looksLikeSchemaEcho } = await import("../src/zod-middleware.js");
    expect(looksLikeSchemaEcho("{ title: string, content: string }")).toBe(true);
    expect(looksLikeSchemaEcho('[{ name: "a" }, { name: "b" }]')).toBe(false);
    expect(looksLikeSchemaEcho("{ title: number, age: boolean }")).toBe(true);
  });

  it("detects tuple rest syntax", async () => {
    const { looksLikeSchemaEcho } = await import("../src/zod-middleware.js");
    expect(looksLikeSchemaEcho("{ tags: [string, ...] }")).toBe(true);
    expect(looksLikeSchemaEcho('{ tags: ["a", "b"] }')).toBe(false);
  });

  it("returns false for empty or plain JSON", async () => {
    const { looksLikeSchemaEcho } = await import("../src/zod-middleware.js");
    expect(looksLikeSchemaEcho("")).toBe(false);
    expect(looksLikeSchemaEcho('{"title":"hello","tags":["a"]}')).toBe(false);
  });
});

// ── Schema echo handling tests ──────────────────────────────────────────────

describe("Schema echo handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvokeAgent.mockReset();
  });

  it("should send an enhanced retry prompt when schema echo is detected", async () => {
    // First response: TS-shape echo, second: valid data
    mockInvokeAgent
      .mockResolvedValueOnce(
        makeResult({
          stdout: "{ title: string, content: string, keywords: [string, ...] }",
        }),
      )
      .mockResolvedValueOnce(
        makeResult({
          stdout: JSON.stringify({
            title: "Hello",
            content: "World",
            keywords: ["a", "b"],
          }),
        }),
      );

    const EchoSchema = z.object({
      title: z.string(),
      content: z.string(),
      keywords: z.array(z.string()),
    });

    const pipeline = weave("test")
      .prompt("write", () => "write", { schema: EchoSchema })
      .build();

    const result = await pipeline.run({});

    expect(result.write).toEqual({
      title: "Hello",
      content: "World",
      keywords: ["a", "b"],
    });
    expect(mockInvokeAgent).toHaveBeenCalledTimes(2);

    // Second call (retry) must contain the strict format rules hint
    const retryCall = mockInvokeAgent.mock.calls[1]?.[0] as string;
    expect(retryCall).toContain("Strict format rules");
    expect(retryCall).not.toContain("BAD (schema echo");
    expect(retryCall).toContain("Begin your response with the character");
  });

  it("should throw WeftSchemaValidationError with looksLikeSchemaEcho=true on final echo", async () => {
    mockInvokeAgent.mockResolvedValue(
      makeResult({
        stdout: "{ title: string, content: string, keywords: [string, ...] }",
      }),
    );

    const EchoSchema = z.object({
      title: z.string(),
      content: z.string(),
      keywords: z.array(z.string()),
    });

    const pipeline = weave("test")
      .prompt("write", () => "write", { schema: EchoSchema })
      .build();

    const err = (await pipeline.run({}).catch((e) => e)) as WeftSchemaValidationError;

    expect(err).toBeInstanceOf(WeftSchemaValidationError);
    expect(err.looksLikeSchemaEcho).toBe(true);
    expect(err.message).toContain("Possible cause");
    expect(err.message).toContain("schema description");
  });

  it("should throw WeftSchemaValidationError with looksLikeSchemaEcho=false for plain invalid JSON", async () => {
    mockInvokeAgent.mockResolvedValue(
      makeResult({ stdout: "{ broken json without type annotations" }),
    );

    const EchoSchema = z.object({
      title: z.string(),
    });

    const pipeline = weave("test")
      .prompt("write", () => "write", { schema: EchoSchema })
      .build();

    const err = (await pipeline.run({}).catch((e) => e)) as WeftSchemaValidationError;

    expect(err).toBeInstanceOf(WeftSchemaValidationError);
    expect(err.looksLikeSchemaEcho).toBe(false);
    expect(err.message).not.toContain("Possible cause");
  });
});

// ── extractJson balanced-bracket tests ─────────────────────────────────────

describe("extractJson", () => {
  it("returns the first balanced object when multiple blocks are present", async () => {
    const { extractJson } = await import("../src/zod-middleware.js");
    const text =
      'first: {"a": 1, "b": 2}\nsome trailing prose\nnotes: {"c": 3}'
    expect(extractJson(text)).toBe('{"a": 1, "b": 2}')
  })

  it("handles escaped quotes inside strings", async () => {
    const { extractJson } = await import("../src/zod-middleware.js");
    const text = 'noise {"a": "say \\"hi\\"", "b": "} brace \\""} tail'
    expect(extractJson(text)).toBe('{"a": "say \\"hi\\"", "b": "} brace \\""}')
  })

  it("returns the first balanced array when no object is present", async () => {
    const { extractJson } = await import("../src/zod-middleware.js");
    expect(extractJson("prefix [1, 2, 3] suffix")).toBe("[1, 2, 3]")
  })

  it("does not swallow text after the closing brace", async () => {
    const { extractJson } = await import("../src/zod-middleware.js");
    const text =
      '{"title": "T", "content": "C", "keywords": ["k"]}\n\nSome explanation after.'
    expect(extractJson(text)).toBe('{"title": "T", "content": "C", "keywords": ["k"]}')
    expect(extractJson(text)).not.toContain("Some explanation after")
  })
})
