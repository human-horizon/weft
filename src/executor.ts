import type { Pipeline, RunOpts, StepOpts } from "./types.js";
import type { Step } from "./ir.js";
import { invokeWithoutSchema, invokeWithSchema } from "./zod-middleware.js";
import { clearSessions, resolveModel } from "./agent.js";

// ── Colours ─────────────────────────────────────────────────────────────────

const isColour = process.env.FORCE_COLOR || (process.env.TERM && process.env.TERM !== "dumb");
const c = (code: string, text: string) => isColour ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = (s: string) => c("2", s);
const cyan = (s: string) => c("36", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const bold = (s: string) => c("1", s);

// ── Pipeline implementation ─────────────────────────────────────────────────

export class PipelineImpl<FinalCtx = Record<string, never>, InitialCtx = FinalCtx>
  implements Pipeline<FinalCtx, InitialCtx>
{
  constructor(
    private steps: Step[],
  ) {}

  async run(ctx: InitialCtx, opts?: RunOpts): Promise<FinalCtx> {
    const signal = opts?.signal;
    const failFast = opts?.failFast ?? true;

    if (opts?.dryRun) {
      this.dryRun();
      return ctx as unknown as FinalCtx;
    }

    // Show pipeline tree before execution
    this.showPipelineTree();

    let acc: Record<string, unknown> = ctx as Record<string, unknown>;
    try {
      for (const step of this.steps) {
        if (signal?.aborted) throw new Error("Aborted");

        try {
          acc = await this.executeStep(step, acc, { ...opts, signal });
        } catch (err) {
          const canContinue = isContinuingStep(step) && (step.opts.continueOnError ?? false);
          if (!canContinue && failFast) throw err;
          console.error(`[weft] step error (continuing):`, err);
        }
      }
    } finally {
      clearSessions();
    }

    return acc as unknown as FinalCtx;
  }

  // ── Step dispatcher ─────────────────────────────────────────────────────

  private async executeStep(
    step: Step,
    ctx: Record<string, unknown>,
    runOpts: RunOpts & { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    switch (step.kind) {
      case "prompt": {
        return this.executePrompt(step, ctx, runOpts);
      }
      case "step": {
        return this.executeJsStep(step, ctx, runOpts);
      }
      case "when": {
        return this.executeWhen(step, ctx, runOpts);
      }
      case "parallel": {
        return this.executeParallel(step, ctx, runOpts);
      }
      case "use": {
        return step.pipeline.run(ctx as any, runOpts) as Promise<Record<string, unknown>>;
      }
    }
  }

  // ── Individual step executors ───────────────────────────────────────────

  private async executePrompt(
    step: Step & { kind: "prompt" },
    ctx: Record<string, unknown>,
    runOpts: RunOpts & { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const prompt = step.fn(ctx);

    console.log(`\n[weft] → prompt: "${step.name}"`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(prompt);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const result: unknown = await this.withRetry(step.opts, async () => {
      return this.withTimeout(step.opts.timeout, runOpts.signal, async (signal) => {
        if (step.opts.schema) {
          return invokeWithSchema(prompt, step.opts.schema, {
            signal,
            session: step.opts.session,
            model: step.opts.model,
            thinking: step.opts.thinking,
          });
        }
        return invokeWithoutSchema(prompt, { signal, session: step.opts.session, model: step.opts.model, thinking: step.opts.thinking });
      });
    });

    console.log(`[weft] ← result: "${step.name}"`);
    if (typeof result === 'object' && result !== null) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(String(result));
    }
    console.log();

    return { ...ctx, [step.name]: result };
  }

  private async executeJsStep(
    step: Step & { kind: "step"; opts: StepOpts },
    ctx: Record<string, unknown>,
    _runOpts: RunOpts & { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    console.log(`[weft] → step: "${step.name}"`);
    const result = await this.withRetry(step.opts ?? {}, () => step.fn(ctx));
    console.log(`[weft] ← result: "${step.name}" =`, typeof result === 'object' ? JSON.stringify(result) : String(result));
    return { ...ctx, [step.name]: result };
  }

  private async executeWhen(
    step: Step & { kind: "when" },
    ctx: Record<string, unknown>,
    runOpts: RunOpts & { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const branch = step.predicate(ctx) ? step.then : step.else;
    let result = ctx;
    for (const s of branch) {
      result = await this.executeStep(s, result, runOpts);
    }
    return result;
  }

  private async executeParallel(
    step: Step & { kind: "parallel" },
    ctx: Record<string, unknown>,
    runOpts: RunOpts & { signal?: AbortSignal },
  ): Promise<Record<string, unknown>> {
    const entries = Object.entries(step.tasks);
    const results = await Promise.all(
      entries.map(async ([name, steps]) => {
        let p = ctx;
        for (const s of steps) {
          p = await this.executeStep(s, p, runOpts);
        }
        return [name, p] as const;
      }),
    );
    const merged = { ...ctx };
    for (const [, subCtx] of results) {
      Object.assign(merged, subCtx);
    }
    return merged;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async withRetry<T>(
    opts: { retry?: number; retryDelay?: number; retryBackoff?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const max = opts.retry ?? 0;
    let delay = opts.retryDelay ?? 1000;

    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === max) throw err;
        await sleep(delay);
        if (opts.retryBackoff === "exponential") delay *= 2;
        else if (opts.retryBackoff === "linear") delay += opts.retryDelay ?? 1000;
      }
    }
    throw new Error("unreachable");
  }

  private async withTimeout<T>(
    timeout: string | number | undefined,
    parentSignal: AbortSignal | undefined,
    fn: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!timeout) return fn(parentSignal);

    const ms = typeof timeout === "string" ? parseHumanTime(timeout) : timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    if (parentSignal) {
      parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private dryRun(): void {
    console.log("[weft] Dry run — steps:");
    for (const step of this.steps) {
      switch (step.kind) {
        case "prompt":
          console.log(`  → prompt: ${step.name}`);
          break;
        case "step":
          console.log(`  → step: ${step.name}`);
          break;
        case "when":
          console.log(`  → when → then:${step.then.length}, else:${step.else.length}`);
          break;
        case "parallel":
          console.log(`  → parallel: ${Object.keys(step.tasks).join(", ")}`);
          break;
        case "use":
          console.log(`  → use: embedded pipeline`);
          break;
      }
    }
  }

  // ── Pipeline tree display ────────────────────────────────────────────────

  private showPipelineTree(): void {
    console.log(`\n${bold("⚡ Pipeline plan:")}`);
    this.renderSteps(this.steps, "");
    console.log();
  }

  private renderSteps(steps: Step[], prefix: string): void {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const isLast = i === steps.length - 1;
      const connector = isLast ? "└──" : "├──";
      const childPrefix = isLast ? "    " : "│   ";

      switch (step.kind) {
        case "prompt":
          this.renderPromptStep(step, prefix, connector, childPrefix);
          break;
        case "step":
          console.log(`${prefix}${connector} ${yellow("⚡")} ${cyan(step.name)} ${dim("(step)")}`);
          break;
        case "when":
          console.log(`${prefix}${connector} ${yellow("◇")} ${bold("when")}`);
          this.renderSteps(step.then, prefix + childPrefix + "│   ");
          if (step.else.length > 0) {
            console.log(`${prefix}${childPrefix}${bold("else")}`);
            this.renderSteps(step.else, prefix + childPrefix + "    ");
          }
          break;
        case "parallel":
          console.log(`${prefix}${connector} ${yellow("▤")} ${bold("parallel")} ${dim(Object.keys(step.tasks).join(", "))}`);
          break;
        case "use":
          console.log(`${prefix}${connector} ${dim("⊞")} ${cyan("use")} ${dim("(embedded pipeline)")}`);
          break;
      }
    }
  }

  private renderPromptStep(
    step: Step & { kind: "prompt" },
    prefix: string,
    connector: string,
    childPrefix: string,
  ): void {
    const modelTag = step.opts.model ?? "medium";
    const modelName = resolveModel(modelTag);
    const thinking = step.opts.thinking ? dim(`thinking: ${step.opts.thinking}`) : "";
    const session = step.opts.session ? dim(`[${step.opts.session}]`) : "";

    console.log(`${prefix}${connector} ${green("◆")} ${cyan(step.name)}`);
    console.log(`${prefix}${childPrefix}${dim("model:")} ${modelTag} ${dim("→")} ${modelName} ${thinking} ${session}`);
  }
}

// ── Type guard ────────────────────────────────────────────────────────────

type ContinuingStep = Extract<Step, { opts: StepOpts }>;

function isContinuingStep(step: Step): step is ContinuingStep {
  return step.kind === "prompt" || step.kind === "step";
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHumanTime(input: string): number {
  const match = input.match(/^(\d+)(ms|s|m)$/);
  if (!match) throw new Error(`Invalid time format: ${input}`);
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1000;
    case "m": return value * 60000;
    default: return value;
  }
}