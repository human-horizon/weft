import { z } from "zod";
/**
 * Convert a zod schema to a text prompt describing the expected JSON shape.
 * Appended to the user's prompt so the agent knows what format to return.
 */
export declare function schemaToPrompt(schema: z.ZodType): string;
//# sourceMappingURL=schema-to-prompt.d.ts.map