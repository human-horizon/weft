import { invokeAgent } from "./agent.js";
import { schemaToPrompt } from "./schema-to-prompt.js";
// ── Extract JSON from agent response ────────────────────────────────────────
function extractJson(text) {
    // Try markdown code block: ```json ... ``` or ``` ... ```
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (blockMatch?.[1])
        return blockMatch[1].trim();
    // Try first { ... } or [ ... ] object/array in text
    const objMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (objMatch?.[1])
        return objMatch[1].trim();
    // Fallback: return as-is (will likely fail JSON.parse, but clear error)
    return text.trim();
}
// ── Invoke with schema validation ───────────────────────────────────────────
export async function invokeWithSchema(prompt, schema, opts) {
    const maxRetries = 1;
    const schemaDescription = schemaToPrompt(schema);
    let currentPrompt = `${prompt}

${schemaDescription}`;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const result = await invokeAgent(currentPrompt, opts);
        console.log(`[weft]   agent stdout (${result.stdout.length} chars):`, result.stdout.slice(0, 500));
        console.log(`[weft]   agent stderr:`, result.stderr || "(empty)");
        console.log(`[weft]   agent exitCode:`, result.exitCode, `ok:`, result.ok);
        try {
            const jsonText = extractJson(result.stdout);
            console.log(`[weft]   extracted JSON (${jsonText.length} chars):`, jsonText.slice(0, 300));
            const parsed = JSON.parse(jsonText);
            return schema.parse(parsed);
        }
        catch (err) {
            if (attempt === maxRetries)
                throw err;
            currentPrompt = `${prompt}\n\n${schemaDescription}\n\nPrevious response was invalid: ${String(err)}\nPlease fix and retry.`;
        }
    }
    throw new Error("unreachable");
}
// ── Fallback — no schema ─────────────────────────────────────────────────────
export async function invokeWithoutSchema(prompt, opts) {
    return invokeAgent(prompt, opts);
}
//# sourceMappingURL=zod-middleware.js.map