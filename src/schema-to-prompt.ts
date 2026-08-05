import { z } from "zod";

/**
 * Convert a zod schema to a text prompt describing the expected JSON shape.
 * Appended to the user's prompt so the agent knows what format to return.
 */
export function schemaToPrompt(schema: z.ZodType): string {
  const shape = describeSchema(schema);
  const example = buildExample(schema);
  return [
    "Respond in valid JSON only. No markdown fences, no commentary.",
    "Start your response directly with `{`. No preamble, no explanation, no schema repetition.",
    "Expected format:",
    shape,
    "",
    "Your response must be a JSON object containing the actual data for the fields above.",
    "Do NOT echo or repeat the schema description.",
    "Do NOT use TypeScript syntax — values like `string`, `number`, `boolean` are not valid JSON values.",
    "Example of correct answer:",
    example,
  ].join("\n");
}

// ── Recursive schema descriptor ─────────────────────────────────────────────

function describeSchema(schema: z.ZodType, indent = 0): string {
  const def = (schema as any).def;
  if (!def) return "unknown";

  const pad = "  ".repeat(indent);

  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape || Object.keys(shape).length === 0) return "{}";
      const entries = Object.entries(shape).map(([key, value]) => {
        const desc = (value as any).description ?? describeSchema(value, indent + 1);
        return `${pad}"${key}": ${desc}`;
      });
      return `{\n${entries.join(",\n")}\n${pad}}`;
    }

    case "array": {
      const element = def.element as z.ZodType;
      const inner = describeSchema(element, indent);
      return `[${inner}]`;
    }

    case "enum": {
      const entries = Object.keys(def.entries as Record<string, string>);
      return entries.map((o) => JSON.stringify(o)).join(" | ");
    }

    case "string":
      return (schema as any).description ?? "string";

    case "number":
      return (schema as any).description ?? "number";

    case "boolean":
      return "boolean";

    case "null":
      return "null";

    case "undefined":
      return "undefined";

    case "union": {
      const options = def.options as z.ZodType[];
      return options.map((o) => describeSchema(o, indent)).join(" | ");
    }

    case "literal": {
      const values = def.values as unknown[];
      return JSON.stringify(values[0]);
    }

    case "tuple": {
      const items = def.items as z.ZodType[];
      return `[${items.map((item) => describeSchema(item, indent)).join(", ")}]`;
    }

    case "record": {
      const valueType = def.valueType as z.ZodType;
      return `{ [key: string]: ${describeSchema(valueType, indent)} }`;
    }

    case "optional": {
      const inner = def.innerType as z.ZodType;
      return `${describeSchema(inner, indent)} (optional)`;
    }

    case "nullable": {
      const inner = def.innerType as z.ZodType;
      return `${describeSchema(inner, indent)} | null`;
    }

    default:
      return "unknown";
  }
}

// ── Minimal example value generator ────────────────────────────────────────

function buildExample(schema: z.ZodType, indent = 0): string {
  const def = (schema as any).def;
  if (!def) return "null";

  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, z.ZodType> | undefined;
      if (!shape || Object.keys(shape).length === 0) return "{}";
      const pad = "  ".repeat(indent);
      const innerPad = "  ".repeat(indent + 1);
      const entries = Object.entries(shape).map(([key, value]) => {
        return `${innerPad}"${key}": ${exampleValue(value, indent + 1)}`;
      });
      return `{\n${entries.join(",\n")}\n${pad}}`;
    }
    default:
      return exampleValue(schema, indent);
  }
}

function exampleValue(schema: z.ZodType, indent = 0): string {
  const def = (schema as any).def;
  if (!def) return "null";

  switch (def.type) {
    case "string":
      return `""`;
    case "number":
      return `0`;
    case "boolean":
      return `false`;
    case "null":
      return `null`;
    case "undefined":
      return `null`;
    case "enum": {
      const entries = Object.values(def.entries as Record<string, string>);
      return JSON.stringify(entries[0] ?? "");
    }
    case "literal": {
      const values = def.values as unknown[];
      return JSON.stringify(values[0] ?? null);
    }
    case "array":
      return `[]`;
    case "tuple": {
      const items = def.items as z.ZodType[];
      return `[${items.map((i) => exampleValue(i, indent)).join(", ")}]`;
    }
    case "record":
      return `{}`;
    case "union": {
      const options = def.options as z.ZodType[];
      const first = options[0];
      return first ? exampleValue(first, indent) : `null`;
    }
    case "optional":
    case "nullable": {
      const inner = def.innerType as z.ZodType;
      return exampleValue(inner, indent);
    }
    case "object":
      return buildExample(schema, indent);
    default:
      return `null`;
  }
}
