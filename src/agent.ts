import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import type { AgentResult } from "./types.js";

// Resolve pi from PATH

const agentPath = "pi";

const WEFT_PI_HOME =
    process.env.WEFT_PI_HOME || join(homedir(), ".ai", "weft", "pi");

// Weft home directory (parent of the pi env). Holds the .env model mapping.
const WEFT_HOME = join(homedir(), ".ai", "weft");
const WEFT_ENV_PATH = join(WEFT_HOME, ".env");

// Session cleanup

/**
 * Remove all session files created by pi agent.
 * Sessions are stored in {agentDir}/sessions/<encoded-cwd>/*.jsonl.
 */
export function clearSessions(): void {
    const sessionsDir = join(WEFT_PI_HOME, "sessions");
    if (!existsSync(sessionsDir)) return;

    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const dirPath = join(sessionsDir, entry.name);
            const files = readdirSync(dirPath);
            for (const file of files) {
                if (file.endsWith(".jsonl")) {
                    rmSync(join(dirPath, file));
                }
            }
            // Remove empty dirs
            if (readdirSync(dirPath).length === 0) {
                rmSync(dirPath, { recursive: true });
            }
        }
    }
}

// Model mapping from ~/.ai/weft/.env
//
// The .env file maps model tags to full model names, one per line:
//   simple=ollama-cloud/deepseek-v4-flash
//   expert=openai-codex/gpt-5.5
//
// Lines starting with '#' are comments. Values may be wrapped in quotes.
// The file is not committed (it lives in the weft home, outside any repo).

let _modelMapping: Record<string, string> | null = null;

function parseEnvFile(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (key) result[key] = value;
    }
    return result;
}

function loadModelMapping(): Record<string, string> {
    if (_modelMapping) return _modelMapping;

    try {
        const raw = readFileSync(WEFT_ENV_PATH, "utf-8");
        _modelMapping = parseEnvFile(raw);
    } catch {
        _modelMapping = {};
    }
    return _modelMapping;
}

/**
 * Resolve a model tag to a full model name.
 * Reads mapping from ~/.ai/weft/.env (TAG=MODEL lines).
 * Throws if the tag is unknown and doesn't look like a full model name (contains '/').
 */
export function resolveModel(tag: string): string {
    const mapping = loadModelMapping();
    const mapped = mapping[tag];
    if (mapped) return mapped;
    // Full model names contain '/', e.g. "ollama-cloud/deepseek-v4-flash"
    if (tag.includes("/")) return tag;
    throw new Error(
        `Unknown model tag: "${tag}". ` +
        `Define it in ${WEFT_ENV_PATH} as "${tag}=provider/model-name". ` +
        `Or use a full model name like "provider/model-name".`
    );
}

// Invoke agent via JSON mode (streaming events)

export async function invokeAgent(
    prompt: string,
    opts: {
        session?: string;
        model?: string;
        thinking?: string;
        signal?: AbortSignal;
    },
): Promise<AgentResult> {
    const args = buildCliArgs(prompt, opts);
    return invokeJsonMode(args, opts.signal);
}

function buildCliArgs(
    prompt: string,
    opts: {
        session?: string;
        model?: string;
        thinking?: string;
    },
): string[] {
    const args: string[] = ["--mode", "json"];

    // Session: --session-id <name> creates a new session if missing.
    // --session <name> only looks up existing sessions, which fails with
    // "No session found matching '...'" for new sessions.
    if (opts.session) {
        args.push("--session-id", opts.session);
    } else {
        args.push("--no-session");
    }

    // Set model if specified
    if (opts.model) {
        args.push("--model", resolveModel(opts.model));
    }

    if (opts.thinking) {
        args.push("--thinking", opts.thinking);
    }

    args.push("-p", prompt);
    return args;
}

// JSON mode event parsing

interface JsonEvent {
    type: string;
    message?: {
        role: string;
        content: Array<{ type: string; text?: string; thinking?: string }>;
    };
    assistantMessageEvent?: {
        type: string;
        delta?: string;
        content?: string;
        contentIndex?: number;
    };
    [key: string]: unknown;
}

// Accumulated state of a streaming run. Exported so tests can construct
// and verify state transitions without spawning an actual process.
export interface StreamState {
    finalText: string;
    streamedText: string;
    streamedThinking: string;
    stderr: string[];
}

// Pure event handler. Updates `state` in place.
//
// IMPORTANT: `message_end` and `text_end` MUST filter by
// `event.message?.role === "assistant"` (or exclude `user`). The agent
// streams BOTH user and assistant messages; an unfiltered handler would
// overwrite the model's response with the user prompt (which is exactly
// what was happening to sofia before round-3 fix).
//
// Diagnostic: when env var WEFT_DEBUG_EVENTS is set to a non-empty value,
// every event is dumped to stderr with a `[weft-evt] ` prefix so an
// operator can inspect the raw JSON stream. Off by default.
export function parseEvent(state: StreamState, event: JsonEvent): void {
    if (process.env.WEFT_DEBUG_EVENTS) {
        process.stderr.write(`[weft-evt] ${JSON.stringify(event)}\n`)
    }

    // Thinking blocks

    if (event.assistantMessageEvent?.type === "thinking_delta") {
        const delta = event.assistantMessageEvent.delta;
        if (delta) {
            process.stderr.write(`\x1b[2m${delta}\x1b[0m`);
            state.streamedThinking += delta;
        }
        return;
    }

    if (event.assistantMessageEvent?.type === "thinking_start") {
        state.streamedThinking = "";
        return;
    }

    if (event.assistantMessageEvent?.type === "thinking_end") {
        process.stderr.write("\n");
        return;
    }

    // Text blocks

    if (event.assistantMessageEvent?.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        if (delta) {
            process.stdout.write(delta);
            state.streamedText += delta;
        }
        return;
    }

    if (event.assistantMessageEvent?.type === "text_start") {
        return;
    }

    if (event.assistantMessageEvent?.type === "text_end") {
        if (event.message?.role !== "user") {
            const content = event.assistantMessageEvent.content;
            if (content) state.finalText = content;
        }
        return;
    }

    // Message end - critical role filter here

    if (event.type === "message_end" && event.message?.role === "assistant") {
        const content = event.message.content;
        if (Array.isArray(content)) {
            const textParts = content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text);
            if (textParts.length > 0) {
                state.finalText = textParts.join("");
            }
        }
    }
}

function invokeJsonMode(
    args: string[],
    signal?: AbortSignal,
): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const state: StreamState = {
            finalText: "",
            streamedText: "",
            streamedThinking: "",
            stderr: [],
        };

        const child = spawn(agentPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            signal,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: WEFT_PI_HOME,
            },
        });

        let buffer = "";

        // Parse JSON events from stdout

        child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf-8");

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                let event: JsonEvent;
                try {
                    event = JSON.parse(line) as JsonEvent;
                } catch {
                    continue; // skip non-JSON lines
                }
                parseEvent(state, event);
            }
        });

        // Forward stderr

        child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            state.stderr.push(text);
            process.stderr.write(text);
        });

        // Handle close

        child.on("error", (err) => {
            reject(new Error(`Agent process error: ${err.message}`));
        });

        child.on("close", (code) => {
            const duration = performance.now() - start;
            const stdout = state.finalText || state.streamedText;

            resolve({
                stdout,
                stderr: state.stderr.join(""),
                exitCode: code ?? -1,
                duration,
                ok: code === 0,
            });
        });
    });
}
