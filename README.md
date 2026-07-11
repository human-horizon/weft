# Weft

**TypeScript-native workflow engine for orchestrating AI agent calls.**

No YAML. No DSL. Just typed TypeScript with a fluent builder API.

```ts
import { z } from 'zod';
import { weave } from '@human-horizon/weft';

const pipeline = weave('review')
  .prompt('analyze', (ctx) => `Analyze ${ctx.files}`, { schema: BugSchema })
  .step('report', (ctx) => `Found ${ctx.analyze.bugs.length} bugs`)
  .build();

const result = await pipeline.run({ files: ['src/main.ts'] });
// result = { files: ['src/main.ts'], analyze: { bugs: [...] }, report: '...' }
```

## Installation

```bash
pnpm add @human-horizon/weft
```

Requires Node.js 20+.

---

## Quick Start

### 1. Setup a new project

```bash
mkdir my-project && cd my-project
weft install
```

This creates `.lore/weft/package.json` and `.lore/weft/pipelines/`, then runs `pnpm install` inside `.lore/weft/`. It does not create `.gitignore` or `pnpm-workspace.yaml`.

### 2. Create a pipeline

```bash
weft init my-pipeline
```

Edit `.lore/weft/pipelines/my-pipeline.ts`:

```typescript
export const meta = {
    description: "Analyzes code for bugs",
    args: [
        { name: "path", type: "string", description: "Path to file" },
    ],
};

export async function main(args: string[]) {
    const path = args[0];
    if (!path) {
        console.error("Usage: weft run my-pipeline.ts <path>");
        process.exit(1);
    }
    // ... your pipeline code
}
```

### 3. Run it

```bash
weft run my-pipeline.ts ./src/main.ts
```

Or interactively:

```bash
weft
# → Shows list of pipelines
# → Asks for arguments based on meta
# → Runs the selected one
```

### 4. Pipeline plan preview

Before executing, weft shows the pipeline tree:

```
⚡ Pipeline plan:
├── ◆ analyze
│   model: free → home-pc/qwen-3.5-9b thinking: high [reviewer]
└── ◆ report
    model: medium → ollama-cloud/deepseek-v4-flash
```

Each prompt step shows: model tag → resolved model name, thinking level, and session name (if any).

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `weft run <file> [args...]` | Run a pipeline |
| `weft list [dir]` | List available pipelines (recursively) |
| `weft init <name>` | Create a new pipeline template |
| `weft install` | Setup `.lore/weft/` in the project |
| `weft` (no args) | Interactive mode — select and run |
| `weft help [command]` | Show help |

See [specs/cli.spec.md](./specs/cli.spec.md) for details.

---

## Core concept: context accumulation

Each step **adds** a named field to the context object. Everything accumulates.

```ts
const pipeline = weave('example')
  .prompt('analyze', (ctx) => `Work with ${ctx.lang}`, { schema: BugSchema })
  // ctx after: { lang: 'ts', analyze: { bugs: [...] } }

  .step('count', (ctx) => ctx.analyze.bugs.length)
  // ctx after: { lang: 'ts', analyze: { bugs: [...] }, count: 3 }

  .build();

const result = await pipeline.run({ lang: 'ts' });
// result contains all fields: lang, analyze, count
```

## API Reference

### `weave(name?: string): Workflow<{}>`

Create a new pipeline.

```ts
const pipeline = weave('my-pipeline');
```

---

### `.prompt(name, fn, opts): Workflow<Ctx & { name: AgentResult | T }>`

Call the agent. Result is stored under `name` in the context.

```ts
.prompt('analyze', (ctx) => `Analyze ${ctx.lang} code`, {
  session: 'my-session',  // optional: multi-turn
  model: 'sonnet',         // optional: model level (free, simple, medium, high, expert)
  schema: MySchema,        // optional: zod schema for structured response
  retry: 3,                // optional: retry on failure
  timeout: '30s',          // optional: per-step timeout
  continueOnError: true,   // optional: don't fail on this step
})
```

**Context access:** the prompt function receives the full accumulated context:

```ts
.prompt('fix', (ctx) => `Fix these bugs: ${JSON.stringify(ctx.analyze)}`, { session: 'fixer' })
```

**Return type:**
- Without `schema` → `Workflow<Ctx & { name: AgentResult }>`
- With `schema` → `Workflow<Ctx & { name: z.infer<typeof schema> }>`

```ts
interface AgentResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  ok: boolean;
}
```

**Model levels** (resolved from `~/.ai/settings.json`):

| Tag | Example model |
|-----|---------------|
| `free` | `home-pc/qwen-3.5-9b` |
| `simple` | varies |
| `medium` | varies |
| `high` | varies |
| `expert` | varies |

You can also use a full model name like `"ollama-cloud/deepseek-v4-flash"`. Unknown short tags throw an error.

---

### `.step(name, fn, opts?): Workflow<Ctx & { name: Awaited<Out> }>`

Transform the context with a JS function.

```ts
.step('count', (ctx) => ctx.analyze.bugs.length)
.step('summary', async (ctx) => {
  await db.save(ctx.analyze);
  return `Processed ${ctx.count} bugs`;
})
```

---

### `.clearSession(sessionId): Workflow<Ctx>`

Delete a session folder (clears conversation history). Context passes through.

---

### `.when(predicate)`

Conditional branching. Both branches add fields to the context.

```ts
.when(ctx => ctx.analyze.critical > 0)
  .then(w => w.prompt('alert', () => 'Alert!', { session: 'alerts' }))
  .else(w => w.prompt('log', () => 'All good', { session: 'logs' }))
.end()
```

---

### `.parallel(tasks)`

Run sub-pipelines concurrently. All results merge into the context.

```ts
.parallel({
  security: weave()
    .prompt('audit', () => 'Security audit', { schema: AuditSchema }),

  quality: weave()
    .prompt('lint', () => 'Run linter', { schema: LintSchema }),
})
// ctx now has both audit and lint results
```

---

### `.use(pipeline)`

Embed a pre-built pipeline. Its context fields merge in.

```ts
const shared = weave()
  .prompt('setup', () => 'Initialize', { schema: SetupSchema })
  .build();

weave('job')
  .use(shared)
  .prompt('process', (ctx) => `Process: ${JSON.stringify(ctx.setup)}`)
  .build();
```

---

### `.build(): Pipeline<Ctx>`

Compile the pipeline.

---

### `Pipeline.run(ctx, opts?): Promise<Ctx>`

Execute the pipeline with initial context.

```ts
await pipeline.run({ files: ['src/'], lang: 'ts' });
await pipeline.run({}, { dryRun: true });
await pipeline.run({}, { failFast: false });
await pipeline.run({}, { signal: controller.signal });
controller.abort();
```

---

## Pipeline files — `main()` pattern

Each pipeline is a `.ts` file with `export async function main(args: string[])`:

```typescript
// .lore/weft/pipelines/МойПайплайн.ts
import { weave } from '@human-horizon/weft';

export const meta = {
    description: "What this pipeline does",
    args: [
        { name: "input", type: "string", description: "Input value" },
    ],
};

export async function main(args: string[]) {
    const input = args[0];
    // ... pipeline logic
}

await main(process.argv.slice(2));
```

This makes the file both:
- Importable programmatically (call `main(args)`)
- Runnable directly via `weft run` or `bun/tsx`

---

## Options Reference

### Step Options (`StepOpts`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `session` | `string` | none | Session ID for multi-turn |
| `model` | `string` | inherited | Model level or full name |
| `thinking` | `string` | inherited | Thinking level |
| `schema` | `z.ZodType` | none | Zod schema for response |
| `retry` | `number` | `0` | Retries on failure |
| `retryDelay` | `number` | `1000` | Initial retry delay (ms) |
| `retryBackoff` | `'linear' \| 'exponential'` | none | Backoff strategy |
| `timeout` | `string \| number` | none | Per-step timeout (`'30s'`, `'1m'`) |
| `continueOnError` | `boolean` | `false` | Don't fail on this step |

### Run Options (`RunOpts`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dryRun` | `boolean` | `false` | Print steps without executing |
| `failFast` | `boolean` | `true` | Stop pipeline on first error |
| `signal` | `AbortSignal` | none | Cancel the pipeline mid-flight |

## Architecture

```
weave()           WorkflowImpl<Ctx>     PipelineImpl<Ctx>
   │                  │                    │
   ├── .prompt()      ├── accumulate Step[] ├── spread ctx
   ├── .step()        │     (IR)           ├── add field to ctx
   ├── .when()        │                    ├── invoke agent
   ├── .parallel()    │                    ├── retry / timeout
   ├── .clearSession()│                    ├── validate zod schema
   ├── .use()         │                    └── resolve model
   └── .build()       ▼                    ▼
              Pipeline<Ctx>            RunOpts
```

## Project Structure

```
project/
├── .lore/
│   └── weft/                      # weft config (separate package)
│       ├── package.json           # latest @human-horizon/weft dependency
│       ├── pnpm-lock.yaml         # generated by pnpm
│       ├── node_modules/          # generated by pnpm
│       └── pipelines/             # pipeline .ts files
├── src/                           # project source code
├── code-specs/                    # per-file specs (generated)
├── specs/                         # project specs (generated)
├── docs/                          # documentation
└── package.json                   # project manifest
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `WEFT_PIPELINES_DIR` | `.lore/weft/pipelines/` | Pipelines directory |
| `WEFT_PI_HOME` | `~/.ai/weft/pi/` | Pi environment |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent/` | Pi agent directory |

## License

MIT