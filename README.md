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
  model: 'sonnet',         // optional: model level
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

## Options Reference

### Step Options (`StepOpts`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retry` | `number` | `0` | Retries on failure |
| `timeout` | `string` | none | Per-step timeout (`'30s'`, `'1m'`) |
| `continueOnError` | `boolean` | `false` | Don't fail pipeline on this step |

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
   ├── .clearSession()│                    └── validate zod schema
   ├── .use()         │
   └── .build()       ▼
              Pipeline<Ctx>
```

## License

MIT