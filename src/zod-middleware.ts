import { z } from "zod"
import type { AgentResult, PromptOpts } from "./types.js"
import { invokeAgent } from "./agent.js"
import { schemaToPrompt } from "./schema-to-prompt.js"

// ── Validation issue shape ───────────────────────────────────────────────────

type ValidationIssue = {
    path: string
    message: string
}

// ── Custom error for schema validation failures ─────────────────────────────

export class WeftSchemaValidationError extends Error {
    rawResponse: string
    extractedResponse: string
    validationIssues: ValidationIssue[]
    schemaDescription: string
    looksLikeSchemaEcho: boolean

    constructor(opts: {
        rawResponse: string
        extractedResponse: string
        validationIssues: ValidationIssue[]
        schemaDescription: string
        looksLikeSchemaEcho?: boolean
    }) {
        super(formatSchemaValidationError(opts))
        this.name = "WeftSchemaValidationError"
        this.rawResponse = opts.rawResponse
        this.extractedResponse = opts.extractedResponse
        this.validationIssues = opts.validationIssues
        this.schemaDescription = opts.schemaDescription
        this.looksLikeSchemaEcho = opts.looksLikeSchemaEcho ?? false
    }
}

// ── Format the full error message for humans ────────────────────────────────

function formatSchemaValidationError(opts: {
    rawResponse: string
    extractedResponse: string
    validationIssues: ValidationIssue[]
    schemaDescription: string
    looksLikeSchemaEcho?: boolean
}): string {
    const issues = opts.validationIssues
        .map((issue) => `  - ${issue.path}: ${issue.message}`)
        .join("\n")

    const sections = [
        "Schema validation failed: the model response does not match the expected schema.",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Raw model response",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        opts.rawResponse,
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Extracted JSON",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        opts.extractedResponse,
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Validation errors",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        issues,
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "Expected schema",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        opts.schemaDescription,
    ]

    if (opts.looksLikeSchemaEcho) {
        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "Possible cause",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "The model response looks like a schema description (TypeScript-style type annotations like `: string`, `: number`, or tuple syntax like `[string, ...]`) rather than actual data. The agent may have echoed back the schema prompt instead of generating real values. Try rephrasing your prompt, switching to a more compliant model, or removing the schema requirement.",
        )
    }

    return sections.join("\n")
}

// ── Collect Zod issues into a flat list ─────────────────────────────────────

function collectValidationIssues(error: z.ZodError): ValidationIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
    }))
}

// ── Build issues from any error (Zod or JSON parse) ─────────────────────────

function collectValidationIssuesFromError(err: unknown): ValidationIssue[] {
    if (err instanceof z.ZodError) {
        return collectValidationIssues(err)
    }

    return [
        {
            path: "(root)",
            message: `Failed to parse JSON: ${String(err)}`,
        },
    ]
}

// ── Extract JSON from agent response ────────────────────────────────────────

function extractJson(text: string): string {
    // Try markdown code block: ```json ... ``` or ``` ... ```
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (blockMatch?.[1]) return blockMatch[1].trim()

    // Try first { ... } or [ ... ] object/array in text
    const objMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (objMatch?.[1]) return objMatch[1].trim()

    // Fallback: return as-is (will likely fail JSON.parse, but clear error)
    return text.trim()
}

// ── Detect "schema echo" — model repeated the schema description ────────────
//
// Looks for TypeScript-style type annotations or tuple rest patterns that
// indicate the model copied the schema-prompt instead of generating data.

const SCHEMA_ECHO_RE =
    /:\s*(string|number|boolean|unknown|null|undefined|any)\b|\[\s*(string|number|boolean|\w+\s*,\s*\.\.\.)\s*\]|\btype\s+\w+\s*=\s*\{/

export function looksLikeSchemaEcho(text: string): boolean {
    if (!text) return false
    return SCHEMA_ECHO_RE.test(text)
}

// ── Build retry hint with BAD/GOOD example when schema echo is detected ────

function buildRetryHint(err: unknown, extractedJson: string): string {
    const base = `Previous response was invalid: ${String(err)}\nPlease fix and retry.`
    if (!looksLikeSchemaEcho(extractedJson)) return base

    return [
        base,
        "",
        "⚠ Your previous response looked like a schema description, not data.",
        "",
        "BAD (schema echo — do NOT return this):",
        "{ title: string, content: string, keywords: [string, ...] }",
        "",
        "GOOD (actual JSON data — return THIS form):",
        '{ "title": "...", "content": "...", "keywords": ["..."] }',
        "",
        "Return a JSON object with real values: strings in double quotes, numbers without quotes, arrays as [item1, item2], booleans as true/false.",
    ].join("\n")
}

// ── Invoke with schema validation ───────────────────────────────────────────

export async function invokeWithSchema<T>(
    prompt: string,
    schema: z.ZodType<T>,
    opts: { signal?: AbortSignal; session?: string; model?: string; thinking?: string },
): Promise<T> {
    const maxRetries = 1
    const schemaDescription = schemaToPrompt(schema)
    let currentPrompt = `${prompt}\n\n${schemaDescription}`

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const result = await invokeAgent(currentPrompt, opts)

        console.log(`[weft]   agent stdout (${result.stdout.length} chars):`, result.stdout.slice(0, 500))
        console.log(`[weft]   agent stderr:`, result.stderr || "(empty)")
        console.log(`[weft]   agent exitCode:`, result.exitCode, `ok:`, result.ok)

        try {
            const jsonText = extractJson(result.stdout)
            console.log(`[weft]   extracted JSON (${jsonText.length} chars):`, jsonText.slice(0, 300))
            const parsed = JSON.parse(jsonText) as unknown
            return schema.parse(parsed)
        } catch (err) {
            if (attempt === maxRetries) {
                const extractedResponse = extractJson(result.stdout)
                throw new WeftSchemaValidationError({
                    rawResponse: result.stdout,
                    extractedResponse,
                    validationIssues: collectValidationIssuesFromError(err),
                    schemaDescription,
                    looksLikeSchemaEcho: looksLikeSchemaEcho(extractedResponse),
                })
            }
            const extractedJson = extractJson(result.stdout)
            currentPrompt = `${prompt}\n\n${schemaDescription}\n\n${buildRetryHint(err, extractedJson)}`
        }
    }

    throw new Error("unreachable")
}

// ── Fallback — no schema ─────────────────────────────────────────────────────

export async function invokeWithoutSchema(
    prompt: string,
    opts: { signal?: AbortSignal; session?: string; model?: string; thinking?: string },
): Promise<AgentResult> {
    return invokeAgent(prompt, opts)
}
