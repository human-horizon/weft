import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import type { AgentResult } from "./types.js";

// ── Resolve pi from weft's own node_modules ────────────────────────────────

const require = createRequire(import.meta.url);
let agentPath: string;

const WEFT_PI_HOME =
    process.env.WEFT_PI_HOME || join(homedir(), ".ai", "weft", "pi");

try {
    agentPath = require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
} catch {
    agentPath = "pi";
}

export function setAgentPath(path: string): void {
    agentPath = path;
}

// ── Session cleanup ─────────────────────────────────────────────────────────

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

// ── Model mapping from ~/.ai/settings.json ──────────────────────────────────

interface PiSettings {
    modelMapping?: Record<string, string>;
}

let _modelMapping: Record<string, string> | null = null;

function loadModelMapping(): Record<string, string> {
    if (_modelMapping) return _modelMapping;

    const settingsPath = join(homedir(), ".ai", "settings.json");
    try {
        const raw = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(raw) as PiSettings;
        _modelMapping = settings.modelMapping ?? {};
    } catch {
        _modelMapping = {};
    }
    return _modelMapping;
}

const VALID_TAGS = new Set([
    "free", "cheap", "fastest", "fast",
    "simple", "medium", "high", "xhigh", "expert", "ultra",
]);

/**
 * Resolve a model tag to a full model name.
 * Reads mapping from ~/.ai/settings.json.
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
        `Valid tags: ${[...VALID_TAGS].join(", ")}. ` +
        `Or use a full model name like "provider/model-name".\n` +
        `Model mapping is read from ~/.ai/settings.json (modelMapping field).`
    );
}

// ── Invoke agent via JSON mode (streaming events) ───────────────────────────

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
    const args: string[] = ["--mode", "json", "--no-session"];

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

// ── JSON mode event parsing ────────────────────────────────────────────────

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

function invokeJsonMode(
    args: string[],
    signal?: AbortSignal,
): Promise<AgentResult> {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const stderr: string[] = [];

        // Track streaming state
        let finalText = "";
        let streamedText = "";
        let streamedThinking = "";

        const child = spawn(agentPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            signal,
            env: {
                ...process.env,
                PI_CODING_AGENT_DIR: WEFT_PI_HOME,
            },
        });

        let buffer = "";

        // ── Parse JSON events from stdout ────────────────────────────────

        child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf-8");

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.trim()) continue;
                processEvent(line);
            }
        });

        // ── Forward stderr ───────────────────────────────────────────────

        child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            stderr.push(text);
            process.stderr.write(text);
        });

        // ── Process a JSON event line ────────────────────────────────────

        function processEvent(line: string) {
            let event: JsonEvent;
            try {
                event = JSON.parse(line) as JsonEvent;
            } catch {
                return; // skip non-JSON lines
            }

            // ── Thinking blocks ──────────────────────────────────────────

            if (event.assistantMessageEvent?.type === "thinking_delta") {
                const delta = event.assistantMessageEvent.delta;
                if (delta) {
                    process.stderr.write(`\x1b[2m${delta}\x1b[0m`);
                    streamedThinking += delta;
                }
                return;
            }

            if (event.assistantMessageEvent?.type === "thinking_start") {
                // Thinking block started — clear for new thinking
                streamedThinking = "";
                return;
            }

            if (event.assistantMessageEvent?.type === "thinking_end") {
                process.stderr.write("\n");
                return;
            }

            // ── Text blocks ─────────────────────────────────────────────

            if (event.assistantMessageEvent?.type === "text_delta") {
                const delta = event.assistantMessageEvent.delta;
                if (delta) {
                    process.stdout.write(delta);
                    streamedText += delta;
                }
                return;
            }

            if (event.assistantMessageEvent?.type === "text_start") {
                // Text block started
                return;
            }

            if (event.assistantMessageEvent?.type === "text_end") {
                const content = event.assistantMessageEvent.content;
                if (content) {
                    finalText = content;
                }
                return;
            }

            // ── Message end — capture final content ─────────────────────

            if (event.type === "message_end" && event.message) {
                const content = event.message.content;
                if (Array.isArray(content)) {
                    const textParts = content
                        .filter((b) => b.type === "text" && b.text)
                        .map((b) => b.text);
                    if (textParts.length > 0) {
                        finalText = textParts.join("");
                    }
                }
                return;
            }
        }

        // ── Handle close ────────────────────────────────────────────────

        child.on("error", (err) => {
            reject(new Error(`Agent process error: ${err.message}`));
        });

        child.on("close", (code) => {
            const duration = performance.now() - start;
            const stdout = finalText || streamedText;

            resolve({
                stdout,
                stderr: stderr.join(""),
                exitCode: code ?? -1,
                duration,
                ok: code === 0,
            });
        });
    });
}
