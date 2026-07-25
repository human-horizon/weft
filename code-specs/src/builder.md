# Specification: builder.ts

## Обзор

Файл `builder.ts` содержит реализацию фабричного API для создания рабочих процессов (workflows) в библиотеке Human Horizon. Этот модуль предоставляет функционал для построения последовательностей шагов, условной логики, параллельных задач и композиции рабочих процессов.

## Общественный API

### Функция `weave`

Экспортная фабрика для создания нового рабочего процесса.

**Подпись:**
```typescript
export function weave<InitialCtx = Record<string, never>>(): Workflow<InitialCtx, InitialCtx>
```

**Возвращаемое значение:**
- `Workflow<InitialCtx, InitialCtx>` — новый экземпляр рабочего процесса с начальным контекстом

**Поведение:**
- Создаёт новый экземпляр `WorkflowImpl`
- Возвращает его как типизированный интерфейс `Workflow`

---

### Класс `WorkflowImpl`

Основная реализация рабочего процесса.

**Конструктор:**
```typescript
class WorkflowImpl<CurrentCtx = Record<string, never>, InitialCtx = CurrentCtx>
```

**Свойство `steps`:**
- Тип: `readonly Step[]`
- Возвращает массив шагов рабочего процесса
- Метод `get`, возвращает приватное поле `_steps`

**Метод `prompt`:**
```typescript
prompt<Name extends string>(
  name: Name,
  fn: (ctx: CurrentCtx) => string,
  opts?: Omit<PromptOpts, "schema">,
): Workflow<any>
```

**Параметры:**
- `name` — уникальное имя промпта
- `fn` — функция, возвращающая строку промпта
- `opts` — опциональные параметры промпта

**Поведение:**
- Добавляет шаг типа `"prompt"` в список шагов
- Возвращает рабочий процесс для цепочки вызовов

**Метод `step`:**
```typescript
step<Name extends string, Out>(
  name: Name,
  fn: (ctx: CurrentCtx) => Out | Promise<Out>,
  opts?: StepOpts,
): Workflow<any>
```

**Параметры:**
- `name` — уникальное имя шага
- `fn` — функция выполнения шага (может возвращать `Promise`)
- `opts` — опциональные параметры шага

**Поведение:**
- Добавляет шаг типа `"step"` в список шагов
- Возвращает рабочий процесс для цепочки вызовов

**Метод `when`:**
```typescript
when(predicate: (ctx: CurrentCtx) => boolean): WhenBuilder<CurrentCtx>
```

**Параметры:**
- `predicate` — функция-предикат для условия ветвления

**Поведение:**
- Создаёт новый `WhenBuilderImpl` с указанным предикатом
- Позволяет определить условные ветки выполнения

**Метод `parallel`:**
```typescript
parallel<const Tasks extends Record<string, Workflow<CurrentCtx>>>(
  tasks: Tasks,
  _opts?: { failFast?: boolean },
): Workflow<any>
```

**Параметры:**
- `tasks` — объект, где ключи — имена параллельных задач, значения — рабочие процессы
- `_opts.failFast` — опционально, если `true`, завершает все задачи при ошибке одной

**Поведение:**
- Создаёт шаг типа `"parallel"` с объектом задач
- Каждая задача извлекается из `WorkflowImpl` через доступ `_steps`
- Возвращает рабочий процесс для цепочки вызовов

**Метод `use`:**
```typescript
use<InnerCtx>(
  pipeline: Pipeline<InnerCtx>,
): Workflow<CurrentCtx & InnerCtx, InitialCtx>
```

**Параметры:**
- `pipeline` — встраиваемый `Pipeline` с внутренним контекстом

**Поведение:**
- Добавляет шаг типа `"use"` с указанным `Pipeline`
- Расширяет контекст на `CurrentCtx & InnerCtx`
- Возвращает рабочий процесс с объединённым контекстом

**Метод `build`:**
```typescript
build(): Pipeline<CurrentCtx, InitialCtx>
```

**Поведение:**
- Компилирует рабочие процесс в `PipelineImpl`
- Возвращает готовый к исполнению `Pipeline`

---

### Класс `WhenBuilderImpl`

Имplements интерфейс `WhenBuilder<Ctx>`.

**Конструктор:**
```typescript
constructor(
  private parent: WorkflowImpl<Ctx, Init>,
  private predicate: (ctx: Ctx) => boolean,
)
```

**Метод `then`:**
```typescript
then(
  branch: (w: Workflow<Ctx>) => Workflow<any>,
): WhenElseBuilder<Ctx, any>
```

**Параметры:**
- `branch` — функция, возвращающая рабочий процесс для "then" ветки

**Поведение:**
- Создаёт новый `WorkflowImpl` для "then" ветки
- Вызывает `branch(wf)` для заполнения шагов
- Создаёт пустой массив `elseBranch` для "else" ветки
- Добавляет шаг типа `"when"` в `parent._steps`
- Возвращает новый `WhenElseBuilderImpl` с `elseBranch`

---

### Класс `WhenElseBuilderImpl`

Реализует интерфейс `WhenElseBuilder<Ctx, ThenCtx>`.

**Конструктор:**
```typescript
constructor(
  private parent: WorkflowImpl<Ctx, Init>,
  private elseBranch: Step[],
)
```

**Метод `else`:**
```typescript
else(
  branch: (w: Workflow<Ctx>) => Workflow<any>,
): WhenEndBuilder<Ctx, ThenCtx, any>
```

**Параметры:**
- `branch` — функция, возвращающая рабочий процесс для "else" ветки

**Поведение:**
- Создаёт новый `WorkflowImpl` для "else" ветки
- Вызывает `branch(wf)` для заполнения шагов
- Добавляет шаги "else" в `this.elseBranch`
- Возвращает новый `WhenEndBuilderImpl`

**Метод `end`:**
```typescript
end(): Workflow<Ctx & ThenCtx>
```

**Поведение:**
- Возвращает `parent` как `Workflow<Ctx & ThenCtx>`

---

### Класс `WhenEndBuilderImpl`

Реализует интерфейс `WhenEndBuilder<Ctx, ThenCtx, ElseCtx>`.

**Конструктор:**
```typescript
constructor(private parent: WorkflowImpl<Ctx, Init>)
```

**Метод `end`:**
```typescript
end(): Workflow<Ctx & ThenCtx & ElseCtx>
```

**Поведение:**
- Возвращает `parent` как типизированный `Workflow<Ctx & ThenCtx & ElseCtx>`

---

## Типы

### Импорт

Файл импортирует следующие типы из `./types.js`:
- `Workflow<CurrentCtx, InitialCtx>`
- `PromptOpts`
- `StepOpts`
- `Pipeline`
- `RunOpts`
- `WhenBuilder<Ctx>`
- `WhenElseBuilder<Ctx, ThenCtx>`
- `WhenEndBuilder<Ctx, ThenCtx, ElseCtx>`

Из `./ir.js`:
- `Step`

Из `./executor.js`:
- `PipelineImpl`

---

## Реализация

### Архитектура

Модуль следует паттерну Builder для декларативного описания рабочих процессов. Рабочий процесс состоит из последовательности шагов (`Step[]`), которые компилируются в `PipelineImpl`.

### Приватные поля

- `WorkflowImpl` имеет приватное поле `_steps: Step[]`
- Доступ к `_steps` осуществляется через геттер `steps`

### Типизация контекста

- `CurrentCtx` — текущий контекст, накапливаемый через цепочку вызовов
- `InitialCtx` — начальный контекст

### Условные ветки

- `WhenBuilderImpl` обрабатывает условие через предикат
- `then()` создаёт "then" ветку
- `else()` создаёт "else" ветку
- `end()` завершает ветвление и возвращает объединённый тип контекста

### Параллельные задачи

- `parallel()` добавляет шаг типа `"parallel"` с объектом задач
- Каждая задача хранится в массиве `Step[]`

### Встраивание пайплайнов

- `use()` добавляет шаг типа `"use"` с `Pipeline`
- Контекст расширяется через пересечение типов

---

## Важные детали реализации

1. **TypeScript type casting:**
   - Возвращаемые значения часто кастятся через `as unknown as Workflow<any>`
   - Это необходимо из-за отсутствия явных интерфейсов в реализации

2. **Приватные поля:**
   - `_steps` и `_steps` доступны внутри класса и через геттер
   - Доступ извне ограничен публичным API

3. **Создание шагов:**
   - Каждый метод добавляет новый `Step` в `_steps`
   - Шаг содержит `kind`, `name`, `fn`, `opts` и другие поля в зависимости от типа

4. **Условные ветки:**
   - "then" ветка создаётся новым `WorkflowImpl`
   - "else" ветка хранится в `elseBranch`
   - Обе ветки добавляются как шаг `"when"` в родительский `WorkflowImpl`

5. **Параллельные задачи:**
   - Задачи извлекаются через доступ к приватному полю `steps`
   - Результат преобразуется в `Record<string, Step[]>`

6. **Композиция:**
   - `use()` позволяет встраивать другие `Pipeline`
   - Контекст объединяется через пересечение типов

---

## Примеры использования

```typescript
const workflow = weave()
  .prompt("greeting", (ctx) => "Hello")
  .step("process", (ctx) => {
    // обработка
  })
  .when(ctx => ctx.age > 18)
    .then(w => w.step("adult", () => {}))
    .else(w => w.step("minor", () => {}))
    .end()
  .build()
```

---

## Ссылки

- [`types.ts`](./types.ts) — определение типов `Workflow`, `Step`, `PromptOpts` и др.
- [`ir.ts`](./ir.ts) — определение типа `Step`
- [`executor.ts`](./executor.ts) — реализация `PipelineImpl`
