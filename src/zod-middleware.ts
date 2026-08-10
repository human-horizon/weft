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

// Find the first balanced {...} or [...] block in `text`.
// Tracks strings (including escape characters) so braces inside strings
// don't throw off the depth counter. Returns null if no balanced block
// is found.
function findBalancedJson(
    text: string,
    openChar: "{" | "[",
    closeChar: "}" | "]",
): { start: number; end: number } | null {
    let depth = 0
    let inString = false
    let escape = false
    let start = -1

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        if (escape) {
            escape = false
            continue
        }
        if (inString && ch === "\\") {
            escape = true
            continue
        }
        if (ch === '"') {
            inString = !inString
            continue
        }
        if (inString) continue

        if (ch === openChar) {
            if (depth === 0) start = i
            depth++
        } else if (ch === closeChar && depth > 0) {
            depth--
            if (depth === 0 && start >= 0) return { start, end: i + 1 }
        }
    }
    return null
}

// Exported for unit testing.
export function extractJson(text: string): string {
    // Prefer explicit markdown code block: ```json ... ``` or ``` ... ```
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (blockMatch?.[1]) return blockMatch[1].trim()

    // Otherwise find the first balanced object or array
    const obj = findBalancedJson(text, "{", "}")
    if (obj) return text.slice(obj.start, obj.end).trim()

    const arr = findBalancedJson(text, "[", "]")
    if (arr) return text.slice(arr.start, arr.end).trim()

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

// ── Build retry hint for schema echo ────────────────────────────────────
//
// Note: we deliberately do NOT include a literal "BAD" example, because
// models sometimes copy the most prominent block in the prompt and echo
// it back. Instead we emit a numbered list of strict format rules.

function buildRetryHint(err: unknown, extractedJson: string): string {
    const base = `Previous response was invalid: ${String(err)}\nPlease fix and retry.`
    if (!looksLikeSchemaEcho(extractedJson)) return base

    return [
        base,
        "",
        "⚠ Your previous response was a schema description, not data.",
        "",
        "Strict format rules for this retry:",
        "1. Output ONLY a JSON object with real data values.",
        "2. Strings are wrapped in DOUBLE QUOTES. Example: \"hello\"",
        "3. Numbers are plain digits without quotes. Example: 42",
        "4. Arrays use square brackets with comma-separated values.",
        "5. Booleans are true or false (no quotes).",
        "6. NEVER use the words `string`, `number`, `boolean`, `null` as values — they are types, not data.",
        "7. Begin your response with the character `{` and end with `}`. No preamble, no commentary, no markdown.",
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

        try {
            const jsonText = extractJson(result.stdout)
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
