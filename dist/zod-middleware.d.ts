import type { z } from "zod";
import type { AgentResult } from "./types.js";
export declare function invokeWithSchema<T>(prompt: string, schema: z.ZodType<T>, opts: {
    signal?: AbortSignal;
    session?: string;
    model?: string;
    thinking?: string;
}): Promise<T>;
export declare function invokeWithoutSchema(prompt: string, opts: {
    signal?: AbortSignal;
    session?: string;
    model?: string;
    thinking?: string;
}): Promise<AgentResult>;
//# sourceMappingURL=zod-middleware.d.ts.map