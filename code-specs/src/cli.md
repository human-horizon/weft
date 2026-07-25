# Спецификация `cli.ts`

## Обзор

`cli.ts` — это входная точка и основной CLI-интерфейс для `@human-horizon/weft`, TypeScript-нативного движка рабочих процессов для AI-агентов.

Файл реализует командную строку с поддержкой следующих команд:
- `run` — запуск pipeline-файла
- `list` / `ls` — перечисление доступных pipeline-файлов
- `init` — создание нового pipeline из шаблона
- `install` — настройка проекта (создание `.lore/weft/`, установка зависимостей)
- `interactive` — интерактивный выбор и запуск pipeline
- `help` / `--help` — справочная информация

---

## Публичный API

### Команды

#### `weft run <file> [args...]`

Запускает TypeScript pipeline-файл.

**Параметры:**
- `<file>` — путь к файлу `.ts`. Ищется:
  1. В текущей директории (CWD)
  2. В директории `WEFT_PIPELINES_DIR` (по умолчанию `.lore/weft/pipelines`)
  3. С добавлением расширения `.ts`, если его нет
- `[args...]` — аргументы, передаваемые pipeline

**Флаги:**
- `--dry-run` — показать, что было бы выполнено, без реального запуска

**Ожидания:**
- Файл должен экспортировать `async function main()`
- Требуется установленный runtime: `bun`, `tsx`, `ts-node` или `npx tsx`

#### `weft list [dir]`

Перечисляет pipeline-файлы в директории.

**Параметры:**
- `[dir]` — директория для сканирования. По умолчанию `WEFT_PIPELINES_DIR` или `.lore/weft/pipelines`

**Поведение:**
- Рекурсивно ищет файлы `.ts`, экспортирующие `main()`
- Для каждого файла отображает имя (без `.ts`), описание (если есть из `meta`) и поддиректорию (если файл не в корне)
- Показывает общее количество найденных pipeline

#### `weft init <name>`

Создаёт новый pipeline-файл из шаблона.

**Параметры:**
- `<name>` — имя pipeline без расширения `.ts`

**Поведение:**
- Создаёт файл в `WEFT_PIPELINES_DIR`
- Создаёт базовый шаблон с:
  - импортом `weave` из `@human-horizon/weft`
  - импортом `zod`
  - определением `meta` с описанием и аргументами
  - схемой `ResultSchema`
  - pipeline через `weave()`
  - entry point `main()` для запуска

**Ограничения:**
- Если файл уже существует — выводит ошибку и завершает с кодом 1

#### `weft install`

Настраивает weft в текущем проекте.

**Поведение:**
1. Создаёт `.lore/weft/pipelines/` (если нет)
2. Создаёт/обновляет `.lore/weft/package.json` с зависимостью `@human-horizon/weft`
3. Запускает `pnpm install` в `.lore/weft/`

**Ожидания:**
- Если `.lore/weft/package.json` уже существует — обновляется версия weft
- При отсутствии сети возвращается `latest`

#### `weft` (без аргументов)

Интерактивный режим: выводит меню всех pipeline и запрашивает выбор.

**Поведение:**
1. Показывает список pipeline с нумерацией
2. Запрашивает номер выбора
3. При наличии `meta.args` запрашивает значения аргументов
4. Запускает выбранный pipeline с аргументами

**Обработка ошибок:**
- Если директория не найдена — предупреждение и запрос запустить `weft install`
- Если pipeline не выбран корректно — ошибка и завершение

#### `weft help [command]`

Показывает справочную информацию.

**Параметры:**
- `[command]` — опциональная тема: `run`, `list`, `init`, `install`

---

## Типы

### `ArgMeta`

```typescript
interface ArgMeta {
    name: string;
    type?: string;
    description?: string;
    default?: unknown;
}
```

Описание аргумента pipeline.

### `PipelineMeta`

```typescript
interface PipelineMeta {
    description?: string;
    args?: ArgMeta[];
}
```

Метаданные pipeline, извлекаемое из `export const meta = { ... }`.

---

## Внутренние типы

### `ColorFn`

Функция для окраски текста:

```typescript
type ColorFn = (code: string, text: string) => string;
```

### `ColorStyles`

Функции для разных цветов:

- `green(text: string)` — зелёный
- `red(text: string)` — красный
- `yellow(text: string)` — жёлтый
- `dim(text: string)` — тусклый
- `bold(text: string)` — жирный
- `cyan(text: string)` — голубой

### `detectRuntime`

Возвращает runtime или `null`:

```typescript
function detectRuntime(filePath?: string): string | null
```

**Порядок проверки:**
1. Если файл в `.lore/` — `tsx` → `npx tsx`
2. `bun`
3. `tsx`
4. `npx tsx`

---

## Настройки и окружение

### Переменные окружения

| Переменная | Значение по умолчанию | Описание |
|------------|----------------------|----------|
| `WEFT_PIPELINES_DIR` | `.lore/weft/pipelines` | Директория для pipeline-файлов |
| `WEFT_PI_HOME` | `$HOME/.ai/weft/pi` | Путь к pi CLI |
| `FORCE_COLOR` | `false` | Принудительно включить цвета |
| `TERM` | — | Если не `dumb` — цвета включены |

### Константы

```typescript
const PIPELINES_DIR = env.WEFT_PIPELINES_DIR || ".lore/weft/pipelines";
const WEFT_PI_HOME = env.WEFT_PI_HOME || join(homedir(), ".ai", "weft", "pi");
```

### Путь к pi

```typescript
let piPath: string;
try {
    piPath = require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
} catch {
    piPath = "pi";
}
```

---

## Утилиты

### `findTsFilesRecursive(dir: string): string[]`

Находит все `.ts` файлы в директории (рекурсивно).

**Фильтрация:**
- Только файлы, экспортирующие `async function main()`
- Возвращает относительные пути от `dir`

### `extractMeta(filePath: string): PipelineMeta | null`

Извлекает `meta` из файла.

**Парсинг:**
1. Ищет `export const meta = { ... }`
2. Парсит содержимое фигурных скобок, учитывая строки и экранирование
3. Преобразует к JSON-схожему формату
4. Парсит через `JSON.parse`

**Обработка ошибок:**
- Возвращает `null` при ошибке парсинга

### `c(code: string, text: string)`

Форматирует текст с кодом цвета.

**Логика:**
- Если `env.FORCE_COLOR` или `env.TERM !== "dumb"` — возвращает ANSI-коды
- Иначе — возвращает текст без кодов

---

## Обработка ошибок

### Статусные коды

- `0` — успех
- `1` — ошибка (неизвестная команда, ошибка запуска, некорректный выбор)

### Типичные ошибки

| Ситуация | Вывод | Код |
|----------|-------|-----|
| Неизвестная команда | `❌ Unknown command: <cmd>` | 1 |
| Файл не найден | `❌ File not found: <file>` | 1 |
| Runtime не найден | `❌ No TypeScript runtime found` | 1 |
| Аргумент не выбран | `❌ Usage: weft init <name>` | 1 |
| Файл уже существует | `❌ File already exists: <path>` | 1 |
| Неверный выбор | `❌ Invalid selection: <input>` | 1 |
| pnpm install провалился | `❌ pnpm install failed` | 1 |

---

## Dry-run режим

При запуске с `--dry-run`:
- Отображается команда и runtime
- Не запускается процесс
- Вывод: `(dry run — not executing)`

---

## Интерактивный режим

При запуске без аргументов (`weft`):
1. Проверяет наличие `WEFT_PIPELINES_DIR`
2. Ищет `.ts` файлы с `main()`
3. Показывает меню
4. Запрашивает выбор
5. При наличии `meta.args` запрашивает значения
6. Запускает выбранный pipeline

---

## Установка runtime

`detectRuntime` проверяет в следующем порядке:
1. `tsx` (приоритет для `.lore/`)
2. `npx tsx`
3. `bun`
4. `tsx` (глобальный)
5. `npx tsx`

При отсутствии runtime — выводит ошибку и завершает с кодом 1.

---

## Структура создаваемого проекта (install)

```
.project/
├── .lore/
│   ├── weft/
│   │   ├── package.json
│   │   └── pipelines/
│   │       └── <name>.ts
│   └── package.json
```

`.lore/weft/package.json`:
```json
{
  "name": "<project>-weft",
  "private": true,
  "type": "module",
  "dependencies": {
    "@human-horizon/weft": "^<version>"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

---

## Шаблоны

### `weft init <name>` создаёт:

```typescript
import { weave } from "@human-horizon/weft";
import { z } from "zod";

// ── Meta ────────────────────────────────────────────────────────────────────

export const meta = {
    description: "Describe what this pipeline does",
    args: [
        { name: "input", type: "string", description: "Input text to process", default: "" },
    ],
};

// ── Schema ─────────────────────────────────────────────────────────────────

const ResultSchema = z.object({
    result: z.string(),
});

// ── Pipeline ────────────────────────────────────────────────────────────────

const pipeline = weave<{ input: string }>()
    .prompt(
        "result",
        (ctx) => `Process: ${ctx.input}`,
        { schema: ResultSchema, model: "medium" },
    )
    .build();

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(args: string[]) {
    const input = args[0] || "";
    if (!input) {
        console.error("❌ Usage: weft run ${name}.ts <input>");
        process.exit(1);
    }

    const output = await pipeline.run({ input });
    console.log(JSON.stringify(output, null, 2));
}

await main(process.argv.slice(2));
```

---

## Важные примечания

1. **Все функции используют `Result<T, E>` вместо выбрасывания** — ошибки обрабатываются явно
2. **Цвета** — включаются автоматически, кроме dumb-терминала, или принудительно через `FORCE_COLOR`
3. **Спавн процессов** — используется `spawn` с `stdio: "inherit"` для передачи ошибок
4. **Асинхронность** — все пользовательские функции, работающие с UI, асинхронны; `main` запускает асинхронную работу
5. **Изоляция окружения** — при спавне передаётся `WEFT_PI_PATH` и `PI_CODING_AGENT_DIR`
6. **Изоляция runtime** — каждый pipeline запускается отдельно через спавн с чистым окружением
