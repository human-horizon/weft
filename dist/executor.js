import { invokeWithoutSchema, invokeWithSchema } from "./zod-middleware.js";
import { clearSessions, resolveModel } from "./agent.js";
// ── Colours ─────────────────────────────────────────────────────────────────
const isColour = process.env.FORCE_COLOR || (process.env.TERM && process.env.TERM !== "dumb");
const c = (code, text) => isColour ? `\x1b[${code}m${text}\x1b[0m` : text;
const dim = (s) => c("2", s);
const cyan = (s) => c("36", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const bold = (s) => c("1", s);
// ── Pipeline implementation ─────────────────────────────────────────────────
export class PipelineImpl {
    steps;
    constructor(steps) {
        this.steps = steps;
    }
    async run(ctx, opts) {
        const signal = opts?.signal;
        const failFast = opts?.failFast ?? true;
        if (opts?.dryRun) {
            this.dryRun();
            return ctx;
        }
        // Show pipeline tree before execution
        this.showPipelineTree();
        let acc = ctx;
        try {
            for (const step of this.steps) {
                if (signal?.aborted)
                    throw new Error("Aborted");
                try {
                    acc = await this.executeStep(step, acc, { ...opts, signal });
                }
                catch (err) {
                    const canContinue = isContinuingStep(step) && (step.opts.continueOnError ?? false);
                    if (!canContinue && failFast)
                        throw err;
                    console.error(`[weft] step error (continuing):`, err);
                }
            }
        }
        finally {
            clearSessions();
        }
        return acc;
    }
    // ── Step dispatcher ─────────────────────────────────────────────────────
    async executeStep(step, ctx, runOpts) {
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
                return step.pipeline.run(ctx, runOpts);
            }
        }
    }
    // ── Individual step executors ───────────────────────────────────────────
    async executePrompt(step, ctx, runOpts) {
        const prompt = step.fn(ctx);
        console.log(`\n[weft] → prompt: "${step.name}"`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(prompt);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        const result = await this.withRetry(step.opts, async () => {
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
        }
        else {
            console.log(String(result));
        }
        console.log();
        return { ...ctx, [step.name]: result };
    }
    async executeJsStep(step, ctx, _runOpts) {
        console.log(`[weft] → step: "${step.name}"`);
        const result = await this.withRetry(step.opts ?? {}, () => step.fn(ctx));
        console.log(`[weft] ← result: "${step.name}" =`, typeof result === 'object' ? JSON.stringify(result) : String(result));
        return { ...ctx, [step.name]: result };
    }
    async executeWhen(step, ctx, runOpts) {
        const branch = step.predicate(ctx) ? step.then : step.else;
        let result = ctx;
        for (const s of branch) {
            result = await this.executeStep(s, result, runOpts);
        }
        return result;
    }
    async executeParallel(step, ctx, runOpts) {
        const entries = Object.entries(step.tasks);
        const results = await Promise.all(entries.map(async ([name, steps]) => {
            let p = ctx;
            for (const s of steps) {
                p = await this.executeStep(s, p, runOpts);
            }
            return [name, p];
        }));
        const merged = { ...ctx };
        for (const [, subCtx] of results) {
            Object.assign(merged, subCtx);
        }
        return merged;
    }
    // ── Helpers ──────────────────────────────────────────────────────────────
    async withRetry(opts, fn) {
        const max = opts.retry ?? 0;
        let delay = opts.retryDelay ?? 1000;
        for (let attempt = 0; attempt <= max; attempt++) {
            try {
                return await fn();
            }
            catch (err) {
                if (attempt === max)
                    throw err;
                await sleep(delay);
                if (opts.retryBackoff === "exponential")
                    delay *= 2;
                else if (opts.retryBackoff === "linear")
                    delay += opts.retryDelay ?? 1000;
            }
        }
        throw new Error("unreachable");
    }
    async withTimeout(timeout, parentSignal, fn) {
        if (!timeout)
            return fn(parentSignal);
        const ms = typeof timeout === "string" ? parseHumanTime(timeout) : timeout;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        if (parentSignal) {
            parentSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
            return await fn(controller.signal);
        }
        finally {
            clearTimeout(timer);
        }
    }
    dryRun() {
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
    showPipelineTree() {
        console.log(`\n${bold("⚡ Pipeline plan:")}`);
        this.renderSteps(this.steps, "");
        console.log();
    }
    renderSteps(steps, prefix) {
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
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
    renderPromptStep(step, prefix, connector, childPrefix) {
        const modelTag = step.opts.model ?? "medium";
        const modelName = resolveModel(modelTag);
        const thinking = step.opts.thinking ? dim(`thinking: ${step.opts.thinking}`) : "";
        const session = step.opts.session ? dim(`[${step.opts.session}]`) : "";
        console.log(`${prefix}${connector} ${green("◆")} ${cyan(step.name)}`);
        console.log(`${prefix}${childPrefix}${dim("model:")} ${modelTag} ${dim("→")} ${modelName} ${thinking} ${session}`);
    }
}
function isContinuingStep(step) {
    return step.kind === "prompt" || step.kind === "step";
}
// ── Utilities ───────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseHumanTime(input) {
    const match = input.match(/^(\d+)(ms|s|m)$/);
    if (!match)
        throw new Error(`Invalid time format: ${input}`);
    const value = Number(match[1]);
    switch (match[2]) {
        case "ms": return value;
        case "s": return value * 1000;
        case "m": return value * 60000;
        default: return value;
    }
}
//# sourceMappingURL=executor.js.map