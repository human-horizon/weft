import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
// ── Resolve pi from weft's own node_modules ────────────────────────────────
const require = createRequire(import.meta.url);
let agentPath;
const WEFT_PI_HOME = process.env.WEFT_PI_HOME || join(homedir(), ".ai", "weft", "pi");
try {
    agentPath = require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
}
catch {
    agentPath = "pi";
}
export function setAgentPath(path) {
    agentPath = path;
}
// ── Session cleanup ─────────────────────────────────────────────────────────
/**
 * Remove all session files created by pi agent.
 * Sessions are stored in {agentDir}/sessions/<encoded-cwd>/*.jsonl.
 */
export function clearSessions() {
    const sessionsDir = join(WEFT_PI_HOME, "sessions");
    if (!existsSync(sessionsDir))
        return;
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
let _modelMapping = null;
function loadModelMapping() {
    if (_modelMapping)
        return _modelMapping;
    const settingsPath = join(homedir(), ".ai", "settings.json");
    try {
        const raw = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(raw);
        _modelMapping = settings.modelMapping ?? {};
    }
    catch {
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
export function resolveModel(tag) {
    const mapping = loadModelMapping();
    const mapped = mapping[tag];
    if (mapped)
        return mapped;
    // Full model names contain '/', e.g. "ollama-cloud/deepseek-v4-flash"
    if (tag.includes("/"))
        return tag;
    throw new Error(`Unknown model tag: "${tag}". ` +
        `Valid tags: ${[...VALID_TAGS].join(", ")}. ` +
        `Or use a full model name like "provider/model-name".\n` +
        `Model mapping is read from ~/.ai/settings.json (modelMapping field).`);
}
// ── Invoke agent via JSON mode (streaming events) ───────────────────────────
export async function invokeAgent(prompt, opts) {
    const args = buildCliArgs(prompt, opts);
    return invokeJsonMode(args, opts.signal);
}
function buildCliArgs(prompt, opts) {
    const args = ["--mode", "json", "--no-session"];
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
function invokeJsonMode(args, signal) {
    return new Promise((resolve, reject) => {
        const start = performance.now();
        const stderr = [];
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
        child.stdout.on("data", (chunk) => {
            buffer += chunk.toString("utf-8");
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim())
                    continue;
                processEvent(line);
            }
        });
        // ── Forward stderr ───────────────────────────────────────────────
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString("utf-8");
            stderr.push(text);
            process.stderr.write(text);
        });
        // ── Process a JSON event line ────────────────────────────────────
        function processEvent(line) {
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
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
//# sourceMappingURL=agent.js.map