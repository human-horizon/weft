import { z } from "zod"
import type { AgentResult, PromptOpts } from "./types.js"
import { invokeAgent } from "./agent.js"
import { schemaToPrompt } from "./schema-to-prompt.js"
import { debugLog, debugTimer } from "./debug.js"

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
    repairAttempted: boolean
    repairResponse?: string
    repairError?: string

    constructor(opts: {
        rawResponse: string
        extractedResponse: string
        validationIssues: ValidationIssue[]
        schemaDescription: string
        looksLikeSchemaEcho?: boolean
        repairAttempted?: boolean
        repairResponse?: string
        repairError?: string
    }) {
        super(formatSchemaValidationError(opts))
        this.name = "WeftSchemaValidationError"
        this.rawResponse = opts.rawResponse
        this.extractedResponse = opts.extractedResponse
        this.validationIssues = opts.validationIssues
        this.schemaDescription = opts.schemaDescription
        this.looksLikeSchemaEcho = opts.looksLikeSchemaEcho ?? false
        this.repairAttempted = opts.repairAttempted ?? false
        this.repairResponse = opts.repairResponse
        this.repairError = opts.repairError
    }
}

// ── Format the full error message for humans ────────────────────────────────

function formatSchemaValidationError(opts: {
    rawResponse: string
    extractedResponse: string
    validationIssues: ValidationIssue[]
    schemaDescription: string
    looksLikeSchemaEcho?: boolean
    repairAttempted?: boolean
    repairResponse?: string
    repairError?: string
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

    if (opts.repairAttempted) {
        sections.push(
            "",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "JSON repair attempt",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            opts.repairError
                ? `Repair failed: ${opts.repairError}`
                : "The repair model returned a response that did not pass JSON/schema validation.",
        )
        if (opts.repairResponse) {
            sections.push(
                "",
                "Repair model response",
                "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
                opts.repairResponse,
            )
        }
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

// ── JSON repair ──────────────────────────────────────────────────────────────

const MAX_REPAIR_INPUT_CHARS = 64 * 1024
const MAX_REPAIR_RESPONSE_CHARS = 8 * 1024

function buildJsonRepairPrompt(
    malformedJson: string,
    schemaDescription: string,
): string {
    const input = malformedJson.length > MAX_REPAIR_INPUT_CHARS
        ? `${malformedJson.slice(0, MAX_REPAIR_INPUT_CHARS)}\n[truncated]`
        : malformedJson

    return [
        "Determine whether the following model response is valid JSON.",
        "If it is valid JSON, return the same data as normalized valid JSON.",
        "If it is almost valid JSON, repair only its JSON syntax and preserve its meaning.",
        "If it cannot be repaired, return an empty JSON object: {}.",
        "Return ONLY valid JSON. No markdown fences, commentary, explanations, or schema repetition.",
        "The repaired result must match this expected schema:",
        schemaDescription,
        "",
        "Model response to check:",
        input,
    ].join("\n")
}

type JsonRepairResult<T> =
    | { ok: true; value: T; response: string }
    | { ok: false; response: string; error: string }

async function repairJson<T>(
    malformedJson: string,
    schema: z.ZodType<T>,
    schemaDescription: string,
    opts: { signal?: AbortSignal; session?: string; model?: string; thinking?: string },
): Promise<JsonRepairResult<T>> {
    const repairPrompt = buildJsonRepairPrompt(malformedJson, schemaDescription)
    debugLog("invokeWithSchema: JSON repair started", {
        inputChars: malformedJson.length,
        promptChars: repairPrompt.length,
        model: opts.model,
    })

    const result = await invokeAgent(repairPrompt, opts)
    if (result.error) {
        debugLog("invokeWithSchema: JSON repair model error", { error: result.error })
        return { ok: false, response: result.stdout, error: result.error }
    }

    const response = extractJson(result.stdout)
    try {
        const parsed = JSON.parse(response) as unknown
        const value = schema.parse(parsed)
        debugLog("invokeWithSchema: JSON repair succeeded", { responseChars: response.length })
        return { ok: true, value, response }
    } catch (err) {
        const error = err instanceof z.ZodError
            ? `${err.issues.length} schema issue(s)`
            : String(err)
        debugLog("invokeWithSchema: JSON repair failed", {
            responseChars: response.length,
            error,
        })
        return {
            ok: false,
            response: response.slice(0, MAX_REPAIR_RESPONSE_CHARS),
            error,
        }
    }
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
    let repairAttempted = false
    let repairResponse: string | undefined
    let repairError: string | undefined

    debugLog(`invokeWithSchema: starting`, {
        maxRetries,
        schemaDescLen: schemaDescription.length,
        promptLen: currentPrompt.length,
        model: opts.model,
        session: opts.session,
    })

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        debugLog(`invokeWithSchema: attempt`, { attempt: `${attempt + 1}/${maxRetries + 1}` })
        const result = await invokeAgent(currentPrompt, opts)

        if (result.error) {
            debugLog(`invokeWithSchema: model error`, { error: result.error })
            throw new Error(
                `Model request failed (${opts.model ?? "default"}): ${result.error}`,
            )
        }

        const parseTimer = debugTimer(`extractJson+schema.parse attempt ${attempt + 1}`)
        const extractedJson = extractJson(result.stdout)
        debugLog(`invokeWithSchema: extracted JSON`, { chars: extractedJson.length })

        let parsed: unknown
        try {
            parsed = JSON.parse(extractedJson) as unknown
        } catch (err) {
            parseTimer()
            const errMsg = String(err)
            debugLog(`invokeWithSchema: JSON parse failed`, {
                attempt: `${attempt + 1}/${maxRetries + 1}`,
                error: errMsg,
            })

            if (!repairAttempted) {
                repairAttempted = true
                const repair = await repairJson(extractedJson, schema, schemaDescription, opts)
                repairResponse = repair.response.slice(0, MAX_REPAIR_RESPONSE_CHARS)
                if (repair.ok) {
                    return repair.value
                }
                repairError = repair.error
            }

            if (attempt === maxRetries) {
                debugLog(`invokeWithSchema: final failure, throwing`)
                throw new WeftSchemaValidationError({
                    rawResponse: result.stdout,
                    extractedResponse: extractedJson,
                    validationIssues: collectValidationIssuesFromError(err),
                    schemaDescription,
                    looksLikeSchemaEcho: looksLikeSchemaEcho(extractedJson),
                    repairAttempted,
                    repairResponse,
                    repairError,
                })
            }
            currentPrompt = `${prompt}\n\n${schemaDescription}\n\n${buildRetryHint(err, extractedJson)}`
            continue
        }

        try {
            const validated = schema.parse(parsed)
            parseTimer()
            debugLog(`invokeWithSchema: validation ok`, { attempt: `${attempt + 1}/${maxRetries + 1}` })
            return validated
        } catch (err) {
            parseTimer()
            const errMsg = `${err instanceof z.ZodError
                ? `${err.issues.length} issue(s): ${err.issues[0]?.path.join(".") || "(root)"} ${err.issues[0]?.message || ""}`
                : String(err)}`
            debugLog(`invokeWithSchema: schema validation failed`, {
                attempt: `${attempt + 1}/${maxRetries + 1}`,
                error: errMsg,
            })
            if (attempt === maxRetries) {
                const extractedResponse = extractJson(result.stdout)
                debugLog(`invokeWithSchema: final failure, throwing`)
                throw new WeftSchemaValidationError({
                    rawResponse: result.stdout,
                    extractedResponse,
                    validationIssues: collectValidationIssuesFromError(err),
                    schemaDescription,
                    looksLikeSchemaEcho: looksLikeSchemaEcho(extractedResponse),
                    repairAttempted,
                    repairResponse,
                    repairError,
                })
            }
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
