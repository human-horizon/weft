# Weft — движок оркестрации AI-агентов

## Контекст

При работе с AI-агентами через CLI возникает потребность собирать цепочки вызовов: одноразовые запросы, сессионные диалоги, параллельные проверки, условные ветвления. Сейчас это делается вручную — shell-скриптами или ad-hoc TypeScript-кодом. Нет переиспользуемой абстракции, нет type safety, нет валидации структурированных ответов.

**Weft** (уток — поперечная нить в ткачестве) — TypeScript-библиотека, которая позволяет «сплетать» вызовы агентов в типизированные пайплайны. Подход «code as config»: никакого YAML/DSL, только TypeScript-код с полным автодополнением и проверкой типов.

## Цель

Создать TypeScript-библиотеку `@human-horizon/weft` с fluent API для определения и выполнения цепочек AI-агентов. Библиотека должна:

1. Позволять описывать пайплайн как цепочку типизированных шагов (pipe-модель)
2. Поддерживать сессионные и одноразовые вызовы агента
3. Интегрировать zod для валидации структурированных JSON-ответов
4. Обеспечивать полный type inference через всю цепочку

## Не-цели

- Weft НЕ занимается планированием или оркестрацией на уровне кластера — только локальные пайплайны
- CLI предоставляется в том же пакете (`weft run`, `weft list`, `weft install`, `weft init`) — отдельный проект не нужен

## Архитектура

### Слои

```
┌────────────────────────────────────────────────┐
│  Public API (weave, .prompt, .step, .when...)   │  ← то, что пишет разработчик
├────────────────────────────────────────────────┤
│  Step IR (внутреннее представление шагов)       │  ← граф шагов до .build()
├────────────────────────────────────────────────┤
│  Executor (рантайм выполнения)                  │  ← запуск агента, retry, timeout
├────────────────────────────────────────────────┤
│  Agent CLI (внешний процесс)                    │  ← --no-session / --session-id
└────────────────────────────────────────────────┘
```

### Pipe-модель

Каждый шаг получает **только** результат предыдущего шага. Тип течёт сквозь цепочку как в Unix pipe:

```
void → .prompt() → AgentResult → .step() → { count: number } → .prompt() → AgentResult
```

Это отличается от модели с накопительным контекстом (`ctx.build`, `ctx.test`, ...). Если шагу нужны данные из более ранних шагов — разработчик использует `.step()` чтобы явно упаковать их и передать дальше.

### Два режима результата `.prompt()`

| Режим | Тип результата | Когда |
|-------|---------------|-------|
| Без схемы | `AgentResult` | Свободный текст |
| Со схемой | `z.infer<typeof schema>` | Структурированный JSON |

При наличии `schema`:
1. Схема конвертируется в текстовое описание и добавляется в промт
2. `stdout` агента парсится как JSON
3. Результат валидируется через `schema.parse()`
4. При провале валидации — retry с сообщением об ошибке
5. Успешный результат становится новым pipe-значением

## Публичный API

### Точка входа

```ts
import { weave } from '@human-horizon/weft';
```

### `weave(name?: string): Workflow<void>`

Создаёт новый пайплайн. `name` — опциональное имя для логирования.

### `Workflow<Prev>`

Основной builder-интерфейс. Параметризован типом последнего выхода (`Prev`).

#### `.prompt(name, fn, opts): Workflow<AgentResult | z.infer<S>>`

Вызвать агента.

| Параметр | Тип | Описание |
|----------|-----|----------|
| `name` | `string` | Имя шага (логирование) |
| `fn` | `PromptFn<Prev, Args>` | Функция, возвращающая текст промта |
| `opts` | `PromptOpts<Args>` | Настройки вызова |

`PromptFn<Prev, Args>`:
```ts
type PromptFn<Prev, Args> = (prev: Prev, args: Args) => string;
```

`PromptOpts<Args>`:
```ts
interface PromptOpts<Args = undefined> extends StepOpts {
  args: Args;
  session?: string;         // ID сессии (для multi-turn)
  via?: "direct" | "tmux";  // режим запуска
  tmux?: string | boolean;  // имя tmux-сессии
  model?: string;           // уровень модели
  schema?: z.ZodType<any>;  // zod-схема для валидации ответа
}
```

**Возвращаемый тип:**
- Без `schema`: `Workflow<AgentResult>`
- С `schema`: `Workflow<z.infer<typeof schema>>`

#### `.step(name, fn, opts?): Workflow<Awaited<Out>>`

Выполнить чистую JS-функцию. Трансформирует pipe-значение.

```ts
step<Name extends string, Out>(
  name: Name,
  fn: (prev: Prev) => Out | Promise<Out>,
  opts?: StepOpts,
): Workflow<Awaited<Out>>;
```

#### `.clearSession(sessionId): Workflow<Prev>`

Удалить папку сессии. Pipe-значение проходит насквозь.

#### `.when(predicate): WhenBuilder<Prev>`

Условное ветвление.

```ts
when(predicate: (prev: Prev) => boolean): WhenBuilder<Prev>;
```

#### `.parallel(tasks, opts?): Workflow<{ [K in keyof Tasks]: LastOf<Tasks[K]> }>`

Параллельный запуск подпайплайнов. Каждый получает текущий `Prev`. Результаты объединяются в именованный record.

```ts
parallel<const Tasks extends Record<string, Workflow<Prev>>>(
  tasks: Tasks,
  opts?: { failFast?: boolean },
): Workflow<{ [K in keyof Tasks]: LastOf<Tasks[K]> }>;
```

#### `.use(pipeline): Workflow<InnerLast>`

Встроить готовый пайплайн. Его последний выход становится новым `Prev`.

#### `.build(): Pipeline<Prev>`

Скомпилировать пайплайн. Ничего не выполняется — только валидация графа.

```ts
interface Pipeline<Last> {
  run(opts?: RunOpts): Promise<Last>;
}
```

### Сборка пайплайна: `function` declaration и hoisting

Промт-функции рекомендуется объявлять через `function` (не `const`/arrow), чтобы использовать hoisting — пайплайн определяется до функций:

```ts
const pipeline = weave("ci")
  .prompt("analyze", analyzeCode, { args: { language: "ts" } })
  .prompt("suggest", suggestFix, { args: { max: 3 } })
  .build();

// Функции определены после — hoisting поднимает их
function analyzeCode(_: void, args: { language: string }): string {
  return `Analyze ${args.language} code.`;
}

function suggestFix(prev: AgentResult, args: { max: number }): string {
  return `Based on: ${prev.stdout}, suggest ${args.max} fixes.`;
}
```

## Zod-интеграция

### Мотивация

Агенты должны возвращать структурированные данные (JSON). Разработчик описывает ожидаемую схему через zod, и weft:
1. Добавляет описание схемы в промт
2. Парсит и валидирует ответ
3. При ошибке валидации — повторяет запрос с диагностикой
4. Передаёт валидированные данные дальше по pipe

### API

```ts
import { z } from 'zod';

const BugReportSchema = z.object({
  bugs: z.array(z.object({
    severity: z.enum(['low', 'medium', 'high']),
    description: z.string(),
    line: z.number(),
  })),
  summary: z.string(),
});

const pipeline = weave("audit")
  .prompt("find-bugs", findBugs, {
    args: { language: "typescript" },
    schema: BugReportSchema,
  })
  // Pipe-тип: { bugs: { severity, description, line }[], summary: string }
  .step("count-critical", (prev) => ({
    critical: prev.bugs.filter(b => b.severity === 'high').length,
    total: prev.bugs.length,
    summary: prev.summary,
  }))
  .build();
```

### Поведение при валидации

1. Агент возвращает текст
2. `JSON.parse(stdout)` — если не парсится → ошибка, retry
3. `schema.parse(parsed)` — если не валидно → retry с текстом ошибки zod в промте
4. Успех → результат передаётся как pipe-значение

### Генерация промта из схемы

Zod-схема преобразуется в текстовое описание через встроенный обход схемы. Добавляется к пользовательскому промту:

```
<пользовательский промт>

Respond in JSON matching this schema:
{
  "bugs": [{ "severity": "low|medium|high", "description": "string", "line": number }],
  "summary": "string"
}

Your response must be valid JSON only, no markdown fences.
```

## Внутреннее устройство

### Step IR (Intermediate Representation)

До вызова `.build()` все шаги накапливаются в массиве. При `.build()` массив проверяется на целостность и запекается в `Pipeline`.

```ts
type Step =
  | { kind: 'prompt'; name: string; fn: PromptFn<Prev, any>; opts: PromptOpts; }
  | { kind: 'step'; name: string; fn: (prev: Prev) => any; }
  | { kind: 'when'; predicate: (prev: Prev) => boolean; then: Step[]; else: Step[]; }
  | { kind: 'parallel'; tasks: Record<string, Step[]>; }
  | { kind: 'clearSession'; sessionId: string; }
  | { kind: 'use'; pipeline: Pipeline<any>; };
```

### Executor (рантайм)

`Pipeline.run()` последовательно выполняет шаги:

```
для каждого шага:
  1. Если step.retry > 0 — обернуть в retry-цикл
  2. Если step.timeout — обернуть в AbortController с таймаутом
  3. Выполнить шаг:
     - prompt → spawn agent CLI, дождаться результат
     - step → вызвать JS-функцию
     - when → выполнить then или else ветку
     - parallel → Promise.all по подпайплайнам
     - clearSession → fs.rmdir
  4. Если шаг упал и continueOnError — записать ошибку, продолжить
  5. Если шаг упал и failFast — выбросить исключение
  6. Передать результат как prev следующему шагу
```

### Agent CLI invoke

Внутренняя функция `invokeAgent(prompt, opts)`:

```ts
async function invokeAgent(prompt: string, opts: {
  session?: string;
  via: "direct" | "tmux";
  tmux?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<AgentResult>;
```

Под капотом:
- `--no-session -p "<prompt>"` — для one-shot
- `--session-id <id> -p "<prompt>"` — для сессионных

### Zod validation middleware

При наличии `schema` в `PromptOpts`:

```ts
async function invokeWithSchema<T>(
  prompt: string,
  schema: z.ZodType<T>,
  opts: PromptOpts,
): Promise<T> {
  let lastResult: AgentResult;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await invokeAgent(prompt, opts);
    
    try {
      const parsed = JSON.parse(lastResult.stdout);
      return schema.parse(parsed);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      prompt = `${prompt}\n\nPrevious response was invalid: ${err}\nPlease fix and retry.`;
    }
  }
}
```

## Что изменится (файлы)

1. `package.json` — добавить zod в dependencies
2. `tsconfig.json` — существует, менять не нужно
3. `src/index.ts` — публичный API
4. `src/types.ts` — типы: `AgentResult`, `StepOpts`, `PromptOpts`, `RunOpts`, `PromptFn`, `Workflow`, `Pipeline`
5. `src/ir.ts` — внутреннее представление шагов (Step IR)
6. `src/builder.ts` — реализация `Workflow` builder
7. `src/executor.ts` — рантайм: `Pipeline.run()`, запуск агента, retry, timeout
8. `src/agent.ts` — вызов CLI агента: spawn, tmux, парсинг результата
9. `src/zod-middleware.ts` — валидация ответов через zod, retry при ошибке
10. `src/schema-to-prompt.ts` — конвертация zod-схемы в текстовое описание для промта
11. `specs/weft-v1.spec.md` — эта спецификация

## Детали реализации

### 1. Типы (`src/types.ts`)

Вынести все интерфейсы и типы:
- `AgentResult`
- `StepOpts`
- `PromptOpts<Args>`
- `RunOpts`
- `PromptFn<Prev, Args>`
- `Workflow<Prev>`
- `Pipeline<Last>`
- `WhenBuilder<Prev>`, `WhenElseBuilder`, `WhenEndBuilder`

### 2. Builder (`src/builder.ts`)

Класс `WorkflowImpl<Prev>` реализует интерфейс `Workflow<Prev>`:

```ts
class WorkflowImpl<Prev> implements Workflow<Prev> {
  private steps: Step[] = [];
  
  prompt<Name extends string, Args>(
    name: Name,
    fn: PromptFn<Prev, Args>,
    opts: PromptOpts<Args> & { schema?: z.ZodType<any> },
  ): Workflow<AgentResult | z.infer<typeof opts.schema>> {
    this.steps.push({ kind: "prompt", name, fn, opts });
    return this as any;
  }
  
  // ... остальные методы
  
  build(): Pipeline<Prev> {
    return new PipelineImpl(this.steps);
  }
}
```

### 3. IR (`src/ir.ts`)

```ts
type Step =
  | { kind: 'prompt'; name: string; fn: PromptFn<any, any>; opts: PromptOpts; schema?: z.ZodType; }
  | { kind: 'step'; name: string; fn: (prev: any) => any; }
  | { kind: 'when'; predicate: (prev: any) => boolean; then: Step[]; else: Step[]; }
  | { kind: 'parallel'; tasks: Record<string, Step[]>; }
  | { kind: 'clearSession'; sessionId: string; }
  | { kind: 'use'; pipeline: Pipeline<any>; };
```

### 4. Executor (`src/executor.ts`)

```ts
class PipelineImpl<Last> implements Pipeline<Last> {
  constructor(private steps: Step[]) {}
  
  async run(opts?: RunOpts): Promise<Last> {
    let prev: any = undefined;
    const signal = opts?.signal;
    const failFast = opts?.failFast ?? true;
    
    for (const step of this.steps) {
      if (signal?.aborted) throw new Error('Aborted');
      
      try {
        prev = await this.executeStep(step, prev, signal);
      } catch (err) {
        if (step.kind !== 'prompt' && step.kind !== 'step') throw err;
        if (step.opts?.continueOnError) continue;
        if (failFast) throw err;
      }
    }
    
    return prev as Last;
  }
  
  private async executeStep(step: Step, prev: any, signal?: AbortSignal): Promise<any> {
    switch (step.kind) {
      case 'prompt': {
        const prompt = step.fn(prev, step.opts.args);
        if (step.schema) {
          return this.promptWithSchema(prompt, step.schema, step.opts, signal);
        }
        return this.invokeAgent(prompt, step.opts, signal);
      }
      case 'step':
        return step.fn(prev);
      case 'when': {
        const branch = step.predicate(prev) ? step.then : step.else;
        let result = prev;
        for (const s of branch) {
          result = await this.executeStep(s, result, signal);
        }
        return result;
      }
      case 'parallel': {
        const results = await Promise.all(
          Object.entries(step.tasks).map(async ([name, steps]) => {
            let p = prev;
            for (const s of steps) p = await this.executeStep(s, p, signal);
            return [name, p] as const;
          })
        );
        return Object.fromEntries(results);
      }
      case 'clearSession':
        await fs.rm(step.sessionId, { recursive: true, force: true });
        return prev;
      case 'use':
        return step.pipeline.run();
    }
  }
}
```

### 5. Agent CLI (`src/agent.ts`)

```ts
async function invokeAgent(prompt: string, opts: {
  session?: string;
  via: "direct" | "tmux";
  tmux?: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<AgentResult> {
  const args = buildCliArgs(prompt, opts);
  
  if (opts.via === 'tmux') {
    return invokeViaTmux(args, opts.tmux);
  }
  
  return invokeDirect(args, opts.signal);
}

function buildCliArgs(prompt: string, opts: {...}): string[] {
  const args: string[] = [];
  
  if (opts.session) {
    args.push(`--session-id`, opts.session);
  } else {
    args.push(`--no-session`);
  }
  
  if (opts.model) {
    args.push(`--model`, opts.model);
  }
  
  args.push(`-p`, prompt);
  return args;
}
```

### 6. Schema-to-prompt (`src/schema-to-prompt.ts`)

```ts
import { z } from 'zod';

function schemaToPrompt(schema: z.ZodType<any>): string {
  // Рекурсивно обходим схему и генерируем JSON-подобное описание
  // Используем z.description() если задано
  // Для простых типов — показываем пример значения
}
```

## Критерии приёмки

- [ ] `weave('ci').prompt('build', fn, { args: {} }).build()` компилируется без ошибок
- [ ] `.run()` возвращает результат последнего шага правильного типа
- [ ] `PromptFn<Prev, Args>` правильно выводит типы `prev` из предыдущего шага
- [ ] `.step()` трансформирует pipe-тип: `Workflow<AgentResult>` → `Workflow<{ count: number }>`
- [ ] `.prompt()` без schema: `Workflow<Prev>` → `Workflow<AgentResult>`
- [ ] `.prompt()` с schema: `Workflow<Prev>` → `Workflow<z.infer<typeof schema>>`
- [ ] `.when().then().else().end()` возвращает union типов обеих веток
- [ ] `.parallel({ a: w1, b: w2 })` возвращает `Workflow<{ a: LastA, b: LastB }>`
- [ ] `.clearSession()` не меняет pipe-тип
- [ ] `function` declaration с hoisting работает: пайплайн до, функции после
- [ ] Zod-валидация: при `schema` ответ парсится и валидируется
- [ ] Zod-валидация: при ошибке валидации — retry с диагностикой
- [ ] `continueOnError: true` — шаг падает, пайплайн продолжается
- [ ] `retry: 3` — шаг повторяется при ошибке
- [ ] `timeout: '30s'` — шаг прерывается по таймауту
- [ ] `failFast: false` на уровне `RunOpts` — пайплайн не останавливается на ошибке
- [ ] `signal: AbortSignal` — пайплайн прерывается по сигналу
- [ ] `dryRun: true` — пайплайн печатает шаги, но не выполняет

## Зависимости

| Пакет | Версия | Назначение |
|-------|--------|------------|
| `zod` | ^3.23 | Валидация структурированных ответов |
| `typescript` | ^5.7 | dev-зависимость |
| `@types/node` | ^22 | dev-зависимость |

## Порядок реализации

1. `src/types.ts` — все типы и интерфейсы
2. `src/ir.ts` — Step IR
3. `src/agent.ts` — вызов CLI агента (spawn, tmux)
4. `src/zod-middleware.ts` — валидация + retry
5. `src/schema-to-prompt.ts` — zod → текст
6. `src/builder.ts` — `WorkflowImpl`
7. `src/executor.ts` — `PipelineImpl`
8. `src/index.ts` — реэкспорт публичного API
9. Тесты