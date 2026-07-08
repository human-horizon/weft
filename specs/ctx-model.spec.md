# Контекстная модель в weft

## Контекст

Сейчас weft использует pipe-модель: каждый шаг получает **только** результат предыдущего. Это создаёт проблемы:

1. `.prompt('analyze')` → результат есть, `.prompt('fix')` → результат analyze пропал
2. `.when()` ветки не могут вернуть разные типы без union
3. Нет доступа к аргументам запуска внутри промт-функций
4. `.step()` не видит предыдущие шаги — только последний

Нужно: **пайплайн сам — контекст**. Всё накапливается в одном объекте.

## Цель

Заменить pipe-модель на контекстную. Пайплайн — это `Ctx`. Каждый шаг добавляет своё именованное поле. Аргументы запуска — изначальные поля в Ctx.

## Что изменится

1. `src/types.ts` — новый `Workflow<Ctx>`, `Pipeline<Ctx>`
2. `src/ir.ts` — Step IR: prompt и step добавляют поле
3. `src/builder.ts` — `WorkflowImpl` с контекстной моделью
4. `src/executor.ts` — `PipelineImpl` с накоплением ctx
5. `tests/weft.test.ts` — тесты под новую модель
6. `specs/weft-v1.spec.md` — обновить спецификацию
7. `README.md` — обновить документацию
8. `SKILL.md` — обновить скилл

## Детали реализации

### Контекст — это пайплайн

```typescript
// Pipeline<Ctx> — Ctx накапливается
// Ctx = начальные поля (args) + поля от шагов

const pipeline = weave('audit')
  .prompt('analyze', (ctx) => `Analyze ${ctx.lang} code`, { schema: BugSchema })
  .prompt('fix', (ctx) => `Fix ${JSON.stringify(ctx.analyze)}`, { session: 'fix-bot' })
  .build();

const result = await pipeline.run({ lang: 'ts' });
// result = {
//   lang: 'ts',                    ← начальное поле
//   analyze: { bugs: [...] },      ← от .prompt('analyze')
//   fix: { stdout: "...", ... },   ← от .prompt('fix')
// }
```

### Workflow

```typescript
interface Workflow<Ctx = {}> {
  prompt<Name extends string, S extends z.ZodType | undefined = undefined>(
    name: Name,
    fn: (ctx: Ctx, args: Ctx) => string,
    opts?: { schema?: S; session?: string; retry?: number; timeout?: string | number; continueOnError?: boolean }
  ): Workflow<Ctx & { [K in Name]: S extends z.ZodType ? z.infer<S> : AgentResult }>;

  step<Name extends string, Out>(
    name: Name,
    fn: (ctx: Ctx) => Out | Promise<Out>,
    opts?: { retry?: number; continueOnError?: boolean }
  ): Workflow<Ctx & { [K in Name]: Awaited<Out> }>;

  when(predicate: (ctx: Ctx) => boolean): WhenBuilder<Ctx>;

  clearSession(sessionId: string): Workflow<Ctx>;

  parallel<const Tasks extends Record<string, Workflow<Ctx>>>(
    tasks: Tasks,
    opts?: { failFast?: boolean },
  ): Workflow<Ctx & MergedStates<Tasks>>;

  use<InnerCtx>(pipeline: Pipeline<InnerCtx>): Workflow<Ctx & InnerCtx>;

  build(): Pipeline<Ctx>;
}

interface Pipeline<Ctx> {
  run(ctx: Ctx, opts?: RunOpts): Promise<Ctx>;
}
```

### Ключевые изменения

1. `Pipeline.run(ctx, opts?)` — принимает **начальный контекст** (аргументы), возвращает **итоговый контекст** (все накопленные поля)
2. `prompt()` и `step()` принимают `name` — по нему результат ложится в ctx
3. Промт-функции получают **весь ctx**: `(ctx: Ctx, args: Ctx) => string` — вторым параметром тоже ctx для удобства деструктуризации
4. `.step()` тоже получает весь ctx: `(ctx: Ctx) => Out`

### Пример

```typescript
const pipeline = weave('review')
  .prompt('analyze', (ctx) => `Analyze ${ctx.files}`, {
    schema: z.object({ bugs: z.array(z.string()) }),
  })
  .step('report', (ctx) => `Found ${ctx.analyze.bugs.length} bugs`)
  .prompt('fix', (ctx) => `Fix: ${ctx.report}`, { session: 'fixer' })
  .build();

const result = await pipeline.run({ files: ['main.ts'] });
// result.files         → ['main.ts']
// result.analyze.bugs  → [...]
// result.report        → "Found 3 bugs"
// result.fix           → AgentResult
```

### `.when()` и `.parallel()`

`.when()` — ветки добавляют поля, возвращается union типов обеих веток.

`.parallel()` — подпайплайны мержатся. Имена не должны конфликтовать.

### backward compatibility

Полная ломка API — ок, пакет 0.x.

## Критерии приёмки

- [ ] `pipeline.run({ lang: 'ts' })` — аргументы доступны в промт-функциях как `ctx.lang`
- [ ] `.prompt('analyze', fn)` — результат доступен как `ctx.analyze`
- [ ] `.step('report', fn)` — результат доступен как `ctx.report`
- [ ] `.when()` ветки добавляют поля в ctx
- [ ] `.parallel()` подпайплайны мержатся в ctx
- [ ] TypeScript выводит типы ctx через всю цепочку
- [ ] Все старые тесты переписаны под новую модель
- [ ] 19+ тестов проходят