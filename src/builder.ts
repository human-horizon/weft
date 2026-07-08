import type {
    Workflow,
    PromptOpts,
    StepOpts,
    Pipeline,
    RunOpts,
    WhenBuilder,
    WhenElseBuilder,
    WhenEndBuilder,
} from "./types.js"
import type { Step } from "./ir.js"
import { PipelineImpl } from "./executor.js"

// ── Workflow implementation ─────────────────────────────────────────────────

class WorkflowImpl<
    CurrentCtx = Record<string, never>,
    InitialCtx = CurrentCtx,
> implements Workflow<CurrentCtx, InitialCtx> {
    private _steps: Step[] = []

    get steps(): readonly Step[] {
        return this._steps
    }

    prompt<Name extends string>(
        name: Name,
        fn: (ctx: CurrentCtx) => string,
        opts?: Omit<PromptOpts, "schema">,
    ): Workflow<any> {
        this._steps.push({ kind: "prompt", name, fn, opts: opts ?? {} } as Step)
        return this as unknown as Workflow<any>
    }

    step<Name extends string, Out>(
        name: Name,
        fn: (ctx: CurrentCtx) => Out | Promise<Out>,
        opts?: StepOpts,
    ): Workflow<any> {
        this._steps.push({ kind: "step", name, fn, opts: opts ?? {} })
        return this as unknown as Workflow<any>
    }

    when(predicate: (ctx: CurrentCtx) => boolean): WhenBuilder<CurrentCtx> {
        return new WhenBuilderImpl(this, predicate)
    }

    parallel<const Tasks extends Record<string, Workflow<CurrentCtx>>>(
        tasks: Tasks,
        _opts?: { failFast?: boolean },
    ): Workflow<any> {
        const taskSteps: Record<string, Step[]> = {}
        for (const [name, wf] of Object.entries(tasks)) {
            taskSteps[name] = (wf as unknown as WorkflowImpl).steps as Step[]
        }
        this._steps.push({ kind: "parallel", tasks: taskSteps })
        return this as unknown as Workflow<any>
    }

    use<InnerCtx>(
        pipeline: Pipeline<InnerCtx>,
    ): Workflow<CurrentCtx & InnerCtx, InitialCtx> {
        this._steps.push({ kind: "use", pipeline })
        return this as unknown as Workflow<CurrentCtx & InnerCtx, InitialCtx>
    }

    build(): Pipeline<CurrentCtx, InitialCtx> {
        return new PipelineImpl<CurrentCtx, InitialCtx>(this._steps)
    }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function weave<InitialCtx = Record<string, never>>(): Workflow<
    InitialCtx,
    InitialCtx
> {
    return new WorkflowImpl<InitialCtx, InitialCtx>() as unknown as Workflow<
        InitialCtx,
        InitialCtx
    >
}

// ── Branch builders ─────────────────────────────────────────────────────────

class WhenBuilderImpl<Ctx, Init = Ctx> implements WhenBuilder<Ctx> {
    constructor(
        private parent: WorkflowImpl<Ctx, Init>,
        private predicate: (ctx: Ctx) => boolean,
    ) {}

    then(
        branch: (w: Workflow<Ctx>) => Workflow<any>,
    ): WhenElseBuilder<Ctx, any> {
        const wf = new WorkflowImpl<Ctx, Init>()
        branch(wf as unknown as Workflow<Ctx>)
        const elseBranch: Step[] = []

        this.parent["_steps"].push({
            kind: "when",
            predicate: this.predicate,
            then: wf.steps as Step[],
            else: elseBranch,
        })

        return new WhenElseBuilderImpl(this.parent, elseBranch)
    }
}

class WhenElseBuilderImpl<Ctx, ThenCtx, Init = Ctx> implements WhenElseBuilder<
    Ctx,
    ThenCtx
> {
    constructor(
        private parent: WorkflowImpl<Ctx, Init>,
        private elseBranch: Step[],
    ) {}

    else(
        branch: (w: Workflow<Ctx>) => Workflow<any>,
    ): WhenEndBuilder<Ctx, ThenCtx, any> {
        const wf = new WorkflowImpl<Ctx, Init>()
        branch(wf as unknown as Workflow<Ctx>)
        this.elseBranch.push(...(wf.steps as Step[]))
        return new WhenEndBuilderImpl(this.parent)
    }

    end(): Workflow<Ctx & ThenCtx> {
        return this.parent as unknown as Workflow<Ctx & ThenCtx>
    }
}

class WhenEndBuilderImpl<
    Ctx,
    ThenCtx,
    ElseCtx,
    Init = Ctx,
> implements WhenEndBuilder<Ctx, ThenCtx, ElseCtx> {
    constructor(private parent: WorkflowImpl<Ctx, Init>) {}

    end(): Workflow<Ctx & ThenCtx & ElseCtx> {
        return this.parent as unknown as Workflow<Ctx & ThenCtx & ElseCtx>
    }
}
