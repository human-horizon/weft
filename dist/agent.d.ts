import type { AgentResult } from "./types.js";
export declare function setAgentPath(path: string): void;
/**
 * Remove all session files created by pi agent.
 * Sessions are stored in {agentDir}/sessions/<encoded-cwd>/*.jsonl.
 */
export declare function clearSessions(): void;
/**
 * Resolve a model tag to a full model name.
 * Reads mapping from ~/.ai/settings.json.
 * Throws if the tag is unknown and doesn't look like a full model name (contains '/').
 */
export declare function resolveModel(tag: string): string;
export declare function invokeAgent(prompt: string, opts: {
    session?: string;
    model?: string;
    thinking?: string;
    signal?: AbortSignal;
}): Promise<AgentResult>;
//# sourceMappingURL=agent.d.ts.map