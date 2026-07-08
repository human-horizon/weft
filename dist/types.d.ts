export interface AgentResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    duration: number;
    ok: boolean;
}
export interface StepOpts {
    retry?: number;
    retryDelay?: number;
    retryBackoff?: "constant" | "linear" | "exponential";
    timeout?: number | `${number}${"ms" | "s" | "m"}`;
    continueOnError?: boolean;
}
export interface PromptOpts extends StepOpts {
    session?: string;
    model?: "simple" | "medium" | "high" | "xhigh" | "expert" | string;
    thinking?: "off" | "minimal" | "low" | "medium" | "high";
    schema?: z.ZodType;
}
export interface RunOpts {
    timeout?: number | `${number}${"ms" | "s" | "m"}`;
    failFast?: boolean;
    dryRun?: boolean;
    signal?: AbortSignal;
}
export interface Pipeline<FinalCtx = Record<string, never>, InitialCtx = FinalCtx> {
    run(ctx: InitialCtx, opts?: RunOpts): Promise<FinalCtx>;
}
import type { z } from "zod";
export interface Workflow<CurrentCtx = Record<string, never>, InitialCtx = CurrentCtx> {
    prompt<Name extends string>(name: Name, fn: (ctx: CurrentCtx) => string, opts?: Omit<PromptOpts, "schema">): Workflow<CurrentCtx & {
        [K in Name]: AgentResult;
    }, InitialCtx>;
    prompt<Name extends string, S extends z.ZodType>(name: Name, fn: (ctx: CurrentCtx) => string, opts: PromptOpts & {
        schema: S;
    }): Workflow<CurrentCtx & {
        [K in Name]: z.infer<S>;
    }, InitialCtx>;
    step<Name extends string, Out>(name: Name, fn: (ctx: CurrentCtx) => Out | Promise<Out>, opts?: StepOpts): Workflow<CurrentCtx & {
        [K in Name]: Awaited<Out>;
    }, InitialCtx>;
    when(predicate: (ctx: CurrentCtx) => boolean): WhenBuilder<CurrentCtx>;
    parallel<const Tasks extends Record<string, Workflow<CurrentCtx>>>(tasks: Tasks, opts?: {
        failFast?: boolean;
    }): Workflow<CurrentCtx & MergedStates<Tasks>, InitialCtx>;
    use<InnerCtx>(pipeline: Pipeline<InnerCtx>): Workflow<CurrentCtx & InnerCtx, InitialCtx>;
    build(): Pipeline<CurrentCtx, InitialCtx>;
}
export interface WhenBuilder<Ctx> {
    then(branch: (w: Workflow<Ctx>) => Workflow<any>): WhenElseBuilder<Ctx, any>;
}
export interface WhenElseBuilder<Ctx, ThenCtx> {
    else(branch: (w: Workflow<Ctx>) => Workflow<any>): WhenEndBuilder<Ctx, ThenCtx, any>;
    end(): Workflow<Ctx & ThenCtx>;
}
export interface WhenEndBuilder<Ctx, ThenCtx, ElseCtx> {
    end(): Workflow<Ctx & ThenCtx & ElseCtx>;
}
type MergedStates<Tasks extends Record<string, Workflow<any>>> = {
    [K in keyof Tasks]: Tasks[K] extends Workflow<infer Ctx> ? Ctx : never;
}[keyof Tasks] extends infer Union ? Union extends Record<string, unknown> ? {
    [K in keyof Union]: Union[K];
} : Record<string, never> : Record<string, never>;
export {};
//# sourceMappingURL=types.d.ts.map