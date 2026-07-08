import { PipelineImpl } from "./executor.js";
// ── Workflow implementation ─────────────────────────────────────────────────
class WorkflowImpl {
    _steps = [];
    get steps() {
        return this._steps;
    }
    prompt(name, fn, opts) {
        this._steps.push({ kind: "prompt", name, fn, opts: opts ?? {} });
        return this;
    }
    step(name, fn, opts) {
        this._steps.push({ kind: "step", name, fn, opts: opts ?? {} });
        return this;
    }
    when(predicate) {
        return new WhenBuilderImpl(this, predicate);
    }
    parallel(tasks, _opts) {
        const taskSteps = {};
        for (const [name, wf] of Object.entries(tasks)) {
            taskSteps[name] = wf.steps;
        }
        this._steps.push({ kind: "parallel", tasks: taskSteps });
        return this;
    }
    use(pipeline) {
        this._steps.push({ kind: "use", pipeline });
        return this;
    }
    build() {
        return new PipelineImpl(this._steps);
    }
}
// ── Factory ─────────────────────────────────────────────────────────────────
export function weave() {
    return new WorkflowImpl();
}
// ── Branch builders ─────────────────────────────────────────────────────────
class WhenBuilderImpl {
    parent;
    predicate;
    constructor(parent, predicate) {
        this.parent = parent;
        this.predicate = predicate;
    }
    then(branch) {
        const wf = new WorkflowImpl();
        branch(wf);
        const elseBranch = [];
        this.parent["_steps"].push({
            kind: "when",
            predicate: this.predicate,
            then: wf.steps,
            else: elseBranch,
        });
        return new WhenElseBuilderImpl(this.parent, elseBranch);
    }
}
class WhenElseBuilderImpl {
    parent;
    elseBranch;
    constructor(parent, elseBranch) {
        this.parent = parent;
        this.elseBranch = elseBranch;
    }
    else(branch) {
        const wf = new WorkflowImpl();
        branch(wf);
        this.elseBranch.push(...wf.steps);
        return new WhenEndBuilderImpl(this.parent);
    }
    end() {
        return this.parent;
    }
}
class WhenEndBuilderImpl {
    parent;
    constructor(parent) {
        this.parent = parent;
    }
    end() {
        return this.parent;
    }
}
//# sourceMappingURL=builder.js.map