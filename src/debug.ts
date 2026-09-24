// ── Debug logging helper ──────────────────────────────────────────────────
//
// Activated by setting WEFT_DEBUG_THINKING=1 (e.g. via the `--debug` CLI flag
// in cli.ts which exports WEFT_DEBUG_THINKING to the spawned pipeline child).
//
// All debug output goes to stderr with a timestamp so it doesn't pollute
// stdout (which may contain JSON the caller parses). Use stderr to watch
// the model think / answer in real time and see what's happening at every
// stage of a pipeline run.

export function debugEnabled(): boolean {
    const v = process.env.WEFT_DEBUG_THINKING;
    return v === "1" || v === "true";
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function timestamp(): string {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatValue(v: unknown): string {
    if (typeof v === "string") return v;
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

export function debugLog(...args: unknown[]): void {
    if (!debugEnabled()) return;
    const msg = args.map(formatValue).join(" ");
    process.stderr.write(`[weft:debug] ${timestamp()} ${msg}\n`);
}

/**
 * Returns a function that logs the elapsed ms since this call. Use with
 * `const done = debugTimer("spawn"); ... done();` for ad-hoc timing.
 */
export function debugTimer(label: string): () => void {
    const start = performance.now();
    return () => {
        const ms = (performance.now() - start).toFixed(1);
        debugLog(`${label} took ${ms}ms`);
    };
}
