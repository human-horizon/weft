import type { Pipeline, RunOpts, StepOpts } from "./types.js";
import type { Step } from "./ir.js";
import { invokeWithoutSchema, invokeWithSchema } from "./zod-middleware.js";
import { clearSessions } from "./agent.js";

// ── Step status output ────────────────────────────────────────────────────

const isColour = process.env.FORCE_COLOR || (process.env.TERM && process.env.TERM !== "dumb");
const c = (code: string, text: string) => isColour ? `\x1b[${code}m${text}\x1b[0m` : text;
const green = (s: string) => c("32", s);
const red = (s: string) => c("31", s);

// ── Spinner ───────────────────────────────────────────────────────────────

class Spinner {
    private interval: NodeJS.Timeout | null = null;
    private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    private frameIndex = 0;
    private text = "";

    start(text: string): void {
        this.stop();
        this.text = text;
        this.frameIndex = 0;
        process.stdout.write(`${this.text} ${this.frames[0]}`);
        this.interval = setInterval(() => {
            this.frameIndex = (this.frameIndex + 1) % this.frames.length;
            process.stdout.write(`\r${this.text} ${this.frames[this.frameIndex]}`);
        }, 80);
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    clear(): void {
        process.stdout.write("\r\x1b[K");
    }
}

const spinner = new Spinner();

function stepName(step: Step): string {
    switch (step.kind) {
        case "prompt":
            return step.name;
        case "step":
            return step.name;
        case "when":
            return "when";
        case "parallel":
            return `parallel(${Object.keys(step.tasks).join(", ")})`;
        case "use":
            return "use";
    }
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

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

        let acc: Record<string, unknown> = ctx as Record<string, unknown>;
        try {
            for (const step of this.steps) {
                if (signal?.aborted) throw new Error("Aborted");

                const canContinue = isContinuingStep(step) && (step.opts.continueOnError ?? false);
                if (!canContinue && failFast) {
                    acc = await this.executeStep(step, acc, { ...opts, signal });
                } else {
                    try {
                        acc = await this.executeStep(step, acc, { ...opts, signal });
                    } catch (err) {
                        console.error(`[weft] step error (continuing):`, err);
                    }
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
        const start = performance.now();
        const name = stepName(step);
        const startText = `[weft] → ${name}`;
        spinner.start(startText);
        try {
            const result = await this.executeStepBody(step, ctx, runOpts);
            const duration = formatDuration(performance.now() - start);
            spinner.stop();
            spinner.clear();
            console.log(`[weft] ${green("✓")} ${name} (${duration})`);
            return result;
        } catch (err) {
            const duration = formatDuration(performance.now() - start);
            spinner.stop();
            spinner.clear();
            console.log(`[weft] ${red("✗")} ${name} (${duration}): ${(err as Error).message}`);
            throw err;
        }
    }

    private async executeStepBody(
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

        return { ...ctx, [step.name]: result };
    }

    private async executeJsStep(
        step: Step & { kind: "step"; opts: StepOpts },
        ctx: Record<string, unknown>,
        _runOpts: RunOpts & { signal?: AbortSignal },
    ): Promise<Record<string, unknown>> {
        const result = await this.withRetry(step.opts ?? {}, () => step.fn(ctx));
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
