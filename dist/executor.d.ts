import type { Pipeline, RunOpts } from "./types.js";
import type { Step } from "./ir.js";
export declare class PipelineImpl<FinalCtx = Record<string, never>, InitialCtx = FinalCtx> implements Pipeline<FinalCtx, InitialCtx> {
    private steps;
    constructor(steps: Step[]);
    run(ctx: InitialCtx, opts?: RunOpts): Promise<FinalCtx>;
    private executeStep;
    private executePrompt;
    private executeJsStep;
    private executeWhen;
    private executeParallel;
    private withRetry;
    private withTimeout;
    private dryRun;
    private showPipelineTree;
    private renderSteps;
    private renderPromptStep;
}
//# sourceMappingURL=executor.d.ts.map