import type { z } from "zod";
import type { PromptOpts, StepOpts, Pipeline } from "./types.js";

// ── Step IR (Internal Representation) ────────────────────────────────────────

export type PromptStep = {
  kind: "prompt";
  name: string;
  fn: (ctx: any) => string;
  opts: PromptOpts & { schema?: z.ZodType };
};

export type StepStep = {
  kind: "step";
  name: string;
  fn: (ctx: any) => any;
  opts: StepOpts;
};

export type WhenStep = {
  kind: "when";
  predicate: (ctx: any) => boolean;
  then: Step[];
  else: Step[];
};

export type ParallelStep = {
  kind: "parallel";
  tasks: Record<string, Step[]>;
};

export type UseStep = {
  kind: "use";
  pipeline: Pipeline<any>;
};

export type Step =
  | PromptStep
  | StepStep
  | WhenStep
  | ParallelStep
  | UseStep;