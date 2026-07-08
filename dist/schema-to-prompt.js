/**
 * Convert a zod schema to a text prompt describing the expected JSON shape.
 * Appended to the user's prompt so the agent knows what format to return.
 */
export function schemaToPrompt(schema) {
    const shape = describeSchema(schema);
    return [
        "Respond in valid JSON only. No markdown fences, no commentary.",
        "Expected format:",
        shape,
        "",
        "Your response must be VALID JSON matching this schema exactly.",
    ].join("\n");
}
// ── Recursive schema descriptor ─────────────────────────────────────────────
function describeSchema(schema, indent = 0) {
    const def = schema.def;
    if (!def)
        return "unknown";
    const pad = "  ".repeat(indent);
    switch (def.type) {
        case "object": {
            const shape = def.shape;
            if (!shape || Object.keys(shape).length === 0)
                return "{}";
            const entries = Object.entries(shape).map(([key, value]) => {
                const desc = value.description ?? describeSchema(value, indent + 1);
                return `${pad}  ${key}: ${desc}`;
            });
            return `{\n${entries.join(",\n")}\n${pad}}`;
        }
        case "array": {
            const element = def.element;
            const inner = describeSchema(element, indent);
            return `[${inner}, ...]`;
        }
        case "enum": {
            const entries = Object.keys(def.entries);
            return entries.map((o) => JSON.stringify(o)).join(" | ");
        }
        case "string":
            return schema.description ?? "string";
        case "number":
            return schema.description ?? "number";
        case "boolean":
            return "boolean";
        case "null":
            return "null";
        case "undefined":
            return "undefined";
        case "union": {
            const options = def.options;
            return options.map((o) => describeSchema(o, indent)).join(" | ");
        }
        case "literal": {
            const values = def.values;
            return JSON.stringify(values[0]);
        }
        case "tuple": {
            const items = def.items;
            return `[${items.map((item) => describeSchema(item, indent)).join(", ")}]`;
        }
        case "record": {
            const valueType = def.valueType;
            return `{ [key: string]: ${describeSchema(valueType, indent)} }`;
        }
        case "optional": {
            const inner = def.innerType;
            return `${describeSchema(inner, indent)} (optional)`;
        }
        case "nullable": {
            const inner = def.innerType;
            return `${describeSchema(inner, indent)} | null`;
        }
        default:
            return "unknown";
    }
}
//# sourceMappingURL=schema-to-prompt.js.map