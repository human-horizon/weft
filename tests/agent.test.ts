import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseEvent, type StreamState } from "../src/agent.js";

function makeState(): StreamState {
    return { finalText: "", streamedText: "", streamedThinking: "", stderr: [] };
}

function message_end(role: "user" | "assistant", text: string) {
    return {
        type: "message_end",
        message: {
            role,
            content: [{ type: "text", text }],
        },
    };
}

function text_end_with_role(
    role: "user" | "assistant" | undefined,
    text: string,
) {
    return {
        assistantMessageEvent: { type: "text_end", content: text },
        message: role ? { role, content: [{ type: "text", text }] } : undefined,
    };
}

describe("parseEvent - message_end role filter", () => {
    beforeEach(() => {
        // suppress noisy console writes from parseEvent during tests
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    it("does NOT update finalText on user-role message_end", () => {
        const state = makeState();
        parseEvent(state, message_end("user", "Our full prompt text here"));
        expect(state.finalText).toBe("");
    });

    it("updates finalText on assistant-role message_end", () => {
        const state = makeState();
        parseEvent(state, message_end("assistant", '{"ok": true}'));
        expect(state.finalText).toBe('{"ok": true}');
    });

    it("uses last assistant message_end, ignoring user messages in between", () => {
        const state = makeState();
        parseEvent(state, message_end("user", "first prompt"));
        parseEvent(state, message_end("assistant", '{"a":1}'));
        parseEvent(state, message_end("user", "second prompt"));
        parseEvent(state, message_end("assistant", '{"a":2}'));
        expect(state.finalText).toBe('{"a":2}');
    });

    it("joined textParts from assistant message_end", () => {
        const state = makeState();
        parseEvent(state, {
            type: "message_end",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: '{"title":' },
                    { type: "text", text: '"x"}' },
                ],
            },
        });
        expect(state.finalText).toBe('{"title":"x"}');
    });
});

describe("parseEvent - text_end role filter", () => {
    beforeEach(() => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    it("does NOT overwrite finalText on user-role text_end", () => {
        const state = makeState();
        state.finalText = "previous assistant text";
        parseEvent(state, text_end_with_role("user", "user prompt body"));
        expect(state.finalText).toBe("previous assistant text");
    });

    it("overwrites finalText on assistant-role text_end", () => {
        const state = makeState();
        state.finalText = "stale";
        parseEvent(state, text_end_with_role("assistant", "fresh answer"));
        expect(state.finalText).toBe("fresh answer");
    });
});

describe("parseEvent - text_delta accumulates streamedText", () => {
    beforeEach(() => {
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    });

    it("appends delta to streamedText", () => {
        const state = makeState();
        parseEvent(state, {
            assistantMessageEvent: { type: "text_delta", delta: "hello " },
        });
        parseEvent(state, {
            assistantMessageEvent: { type: "text_delta", delta: "world" },
        });
        expect(state.streamedText).toBe("hello world");
    });
});
