# Спецификация `src/index.ts`

## Обзор

Модуль `src/index.ts` является точкой входа в библиотеку **weft** — систему для создания и выполнения рабочих процессов (workflows) на основе цепочки шагов с участием AI-агента.

Экспортирует типы, функции-фабрики и утилитарные функции для построения и запуска пайплайнов.

---

## Публичный API

### Экспортируемые типы

| Тип | Описание |
|-----|----------|
| `AgentResult` | Результат вызова агента: `stdout`, `stderr`, `exitCode`, `duration`, `ok` |
| `StepOpts` | Опции для шага: `retry`, `retryDelay`, `retryBackoff`, `timeout`, `continueOnError` |
| `PromptOpts` | Опции для промпта: `session`, `model`, `thinking`, `schema` + `StepOpts` |
| `RunOpts` | Опции выполнения: `timeout`, `failFast`, `dryRun`, `signal` |
| `Pipeline` | Компилированный пайплайн: `run(ctx: InitialCtx, opts?): Promise<FinalCtx>` |
| `Workflow` | Конструктор рабочих процессов с методами `prompt`, `step`, `when`, `parallel`, `use`, `build` |
| `WhenBuilder` | Билдер ветвления `then(...)` |
| `WhenElseBuilder` | Билдер ветвления `else(...)` и `end()` |
| `WhenEndBuilder` | Завершитель билдера ветвления `end()` |

### Экспортируемые функции

| Функция | Описание |
|---------|----------|
| `weave()` | Фабрика `Workflow`: возвращает новый экземпляр для построения пайплайна |
| `setAgentPath(path: string)` | Устанавливает путь к исполняемому файлу агента (по умолчанию ищет в `@earendil-works/pi-coding-agent`) |
| `clearSessions()` | Очищает файлы сессий агента (в `{agentDir}/sessions/...`) |
| `resolveModel(tag: string): string` | Преобразует тег модели в полное имя, читая маппинг из `~/.ai/settings.json` |
| `invokeAgent(prompt: string, opts)`: `Promise<AgentResult>` | Утилитарная функция для прямого вызова агента (не публичная часть API) |

---

## Внутренний интерфейс (IR)

После компиляции `Workflow` превращается в `Pipeline` через коллекцию шагов (IR — Internal Representation):

```typescript
type Step =
  | PromptStep
  | StepStep
  | WhenStep
  | ParallelStep
  | UseStep
```

### Типы шагов

| Тип | Поля | Описание |
|-----|------|----------|
| `PromptStep` | `kind: "prompt"`, `name`, `fn`, `opts` | Вызов агента с промптом |
| `StepStep` | `kind: "step"`, `name`, `fn`, `opts` | Вызов JS-функции |
| `WhenStep` | `kind: "when"`, `predicate`, `then`, `else` | Условная ветка |
| `ParallelStep` | `kind: "parallel"`, `tasks` | Параллельное выполнение подпайплайнов |
| `UseStep` | `kind: "use"`, `pipeline` | Встроенный пайплайн |

---

## Поведение

### `weave()`

Создаёт новый `Workflow` для последовательного описания шагов пайплайна.

```typescript
const wf = weave();
const pipeline = wf
  .prompt("analyze", ctx => "Анализ...", { model: "high" })
  .step("summarize", ctx => ctx.analyze.slice(0, 100))
  .build();
```

### `.prompt(name, fn, opts)`

Добавляет шаг вызова агента.

- `name` — ключ результата в контексте
- `fn` — функция, генерирующая промпт на основе текущего контекста
- `opts` — опции:
  - `model` — тег модели (`"simple" | "medium" | "high" | "expert"` или полное имя `provider/model`)
  - `thinking` — уровень размышлений (`"off" | "minimal" | "low" | "medium" | "high"`)
  - `session` — ID сессии
  - `schema` — Zod-схема для валидации ответа агента (если указано, ответ парсится и валидируется)

### `.step(name, fn, opts)`

Добавляет шаг чистого JavaScript.

- Результат функции добавляется в контекст под ключом `name`
- Поддерживает `async/await`

### `.when(predicate)`

Начинает построение условной ветки.

- `predicate(ctx)` — функция-предикат, возвращающая `boolean`
- `.then(branch)` — добавляет шаги для ветки `true`
- `.else(branch)` — добавляет шаги для ветки `false`
- `.end()` — завершает ветвление

Пример:

```typescript
wf
  .when(ctx => ctx.hasError)
    .then(w => w.step("fix", ctx => "Исправление..."))
    .else(w => w.step("continue", ctx => "Продолжение..."))
    .end()
  .build();
```

### `.parallel(tasks)`

Запускает несколько подпайплайнов параллельно.

- `tasks` — объект `{ name: Workflow<...> }`
- Все подпайплайны выполняются одновременно
- Результаты сливаются в контекст

### `.use(pipeline)`

Встраивает готовый `Pipeline` (результат `.build()` другого `Workflow`) как шаг.

### `.build()`

Компилирует `Workflow` в `Pipeline`. После компиляции шаги накапливаются во внутреннем массиве `_steps`.

### `Pipeline.run(ctx, opts)`

Запускает пайплайн.

- `ctx` — начальный контекст
- `opts`:
  - `timeout` — таймаут выполнения (строка `"1m"` или число миллисекунд)
  - `failFast` — бросать ошибку при первом шаге-ошибке (по умолчанию `true`)
  - `dryRun` — показать дерево шагов без выполнения
  - `signal` — `AbortSignal` для отмены

---

## Обработка ошибок и устойчивость

### Повторные попытки

- `StepOpts.retry` — макс. количество попыток
- `StepOpts.retryDelay` — задержка между попытками (мс)
- `StepOpts.retryBackoff` — стратегия: `"constant" | "linear" | "exponential"`
- При `continueOnError: true` шаг не бросает, а продолжает выполнение

### Таймауты

- `RunOpts.timeout` — общий таймаут выполнения пайплайна
- `StepOpts.timeout` — таймаут отдельного шага
- Поддерживает строки `"1s"`, `"2m"` и числа в миллисекундах

### Отмена

- `RunOpts.signal` — `AbortSignal`, который передается в процесс агента
- При `abort` выбрасывается `Error("Aborted")`

### Очистка сессий

- `clearSessions()` вызывается после завершения `Pipeline.run()`
- Удаляет файлы сессий агента в `{WEFT_PI_HOME}/sessions/...`

---

## Маппинг моделей

Функция `resolveModel(tag)` читает маппинг из `~/.ai/settings.json`:

```json
{
  "modelMapping": {
    "cheap": "ollama/llama3.2:1b",
    "fast": "ollama/gemma2:2b"
  }
}
```

Если тег содержит `/` — считается полным именем (пропускает маппинг).

Валидные теги: `"free" | "cheap" | "fastest" | "fast" | "simple" | "medium" | "high" | "xhigh" | "expert" | "ultra"`.

---

## Внутренние утилиты

| Функция | Описание |
|---------|----------|
| `schemaToPrompt(schema)` | Конвертирует Zod-схему в текстовое описание для промпта агента |
| `extractJson(text)` | Извлекает JSON из ответа агента (markdown-блок или первое `{...}`/`[...]`) |
| `invokeWithSchema()` | Вызов агента с валидацией по схеме (до 1 ретра) |
| `invokeWithoutSchema()` | Прямой вызов агента (возвращает `AgentResult`) |

---

## Цветовая кодировка в консоли

- Если `TERM` не `dumb` или `FORCE_COLOR` установлен — цвета включены
- `bold`, `dim`, `cyan`, `green`, `yellow` — ANSI-коды цветов

---

## Экспортируемые сущности

Файл `src/index.ts` экспортирует только следующие имена:

```typescript
export { AgentResult, StepOpts, PromptOpts, RunOpts, Pipeline,
          Workflow, WhenBuilder, WhenElseBuilder, WhenEndBuilder } from "./types.js";
export { weave } from "./builder.js";
export { setAgentPath, clearSessions, resolveModel } from "./agent.js";
```

---

## Архитектура

```
src/
├── index.ts          # точка входа, перенаправление экспортов
├── types.ts          # типы и интерфейсы
├── builder.ts        # реализация Workflow, WhenBuilder*
├── executor.ts       # реализация PipelineImpl, запуск шагов
├── ir.ts             # типы шагов (IR)
├── agent.ts          # вызов агента, моделирование, сессии
├── zod-middleware.ts # валидация по схеме
└── schema-to-prompt.ts # описания схем
```

---

## Пример использования

```typescript
import { weave } from "./index.js";

const wf = weave();

const pipeline = wf
  .prompt("analyze", ctx => "Проанализируй файл...", { model: "high" })
  .step("extract", ctx => ctx.analyze.match(/(\d+)/g))
  .when(ctx => ctx.extract?.length > 2)
    .then(w => w.step("group", ctx => ctx.extract.reduce(...)))
    .else(w => w.step("simple", ctx => ctx.extract))
    .end()
  .build();

const result = await pipeline.run({}, { timeout: "5m" });
console.log(result);
```
