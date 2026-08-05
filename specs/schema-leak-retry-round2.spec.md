# Итерация 2: фикс retry-цикла при schema-echo

## Контекст

После публикации `0.4.0` выяснилось (логи из `sofia` → `НапишиСтатью.ts`), что детектор и красивая ошибка работают (в стеке видно `WeftSchemaValidationError` и `looksLikeSchemaEcho: true`). Но проблема **не решена**: модель продолжает возвращать schema-echo на retry, и в `extractedResponse` попадает **весь retry-промпт с нашими инструкциями и примерами** вместо чистого JSON.

Анализ лога показал **два бага**:

1. **`extractJson` слишком жадный.** Regex `\{[\s\S]*\}` матчит от первой `{` до последней `}` в тексте, захватывая retry-инструкции, BAD/GOOD-примеры, всё подряд. Тест на это — `expect(err.extractedResponse).not.toContain('Do NOT echo')`.

2. **BAD-пример в retry вредит.** На retry модель получила наш BAD `{ title: string, content: string, keywords: [string, ...] }` и вернула **почти то же**: `{"title": string, "content": string, "keywords": [string]}` — без `...` и с кавычками вокруг имён полей. То есть модель берёт самую яркую часть retry-промпта и кладёт её в свой ответ. Классический инструкция-эхо.

## Цель

- **Фикс 1**: `extractJson` использует баланс скобок (учёт строк и escape) — возвращает только **первый полный** JSON-объект/массив.
- **Фикс 2**: `buildRetryHint` без конкретного BAD-примера, вместо него — набор жёстких правил формата вывода.
- **Фикс 3**: усиление основной инструкции в `schemaToPrompt` — добавить «преамбулу запрещено, начинай с `{`».
- **Фикс 4 (отложен)**: `maxRetries` 1 → 2 — обсуждается отдельно, риск сломать стабильное поведение существующих пайплайнов клиентов.

## Что изменится

1. `src/zod-middleware.ts`:
   - `extractJson` — переписать через функцию `findBalancedJson` (стек скобок, учёт строк в кавычках и escape-символов).
   - `buildRetryHint` — убрать конкретный BAD-пример. Заменить на список правил формата вывода (1–7).
2. `src/schema-to-prompt.ts`:
   - Добавить в начало промпта строку «Start your response directly with `{`. No preamble, no commentary, no schema repetition.»

## Детали реализации

### 1. `extractJson` — баланс скобок

```ts
function findBalancedJson(
    text: string,
    openChar: '{' | '[',
    closeChar: '}' | ']',
): { start: number; end: number } | null {
    let depth = 0
    let inString = false
    let escape = false
    let start = -1

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        if (escape) {
            escape = false
            continue
        }
        if (ch === '\\' && inString) {
            escape = true
            continue
        }
        if (ch === '"') {
            inString = !inString
            continue
        }
        if (inString) continue

        if (ch === openChar) {
            if (depth === 0) start = i
            depth++
        } else if (ch === closeChar && depth > 0) {
            depth--
            if (depth === 0 && start >= 0) return { start, end: i + 1 }
        }
    }
    return null
}

function extractJson(text: string): string {
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
    if (blockMatch?.[1]) return blockMatch[1].trim()

    const obj = findBalancedJson(text, '{', '}')
    if (obj) return text.slice(obj.start, obj.end).trim()
    const arr = findBalancedJson(text, '[', ']')
    if (arr) return text.slice(arr.start, arr.end).trim()

    return text.trim()
}
```

Экспортировать `extractJson` для тестов.

### 2. `buildRetryHint` — без BAD-примера

```ts
function buildRetryHint(err: unknown, extractedJson: string): string {
    const base = `Previous response was invalid: ${String(err)}\nPlease fix and retry.`
    if (!looksLikeSchemaEcho(extractedJson)) return base

    return [
        base,
        "",
        "⚠ Your previous response was a schema description, not data.",
        "",
        "Strict format rules for this retry:",
        "1. Output ONLY a JSON object with real data values.",
        "2. Strings are wrapped in DOUBLE QUOTES. Example: \"hello\"",
        "3. Numbers are plain digits without quotes. Example: 42",
        "4. Arrays use square brackets with comma-separated values.",
        "5. Booleans are true or false without quotes.",
        "6. NEVER use the words `string`, `number`, `boolean`, `null` as values — they are types, not data.",
        "7. Begin your response with the character `{` and end with `}`. No preamble, no commentary.",
    ].join("\n")
}
```

### 3. `schemaToPrompt` — усиление преамбулы

Первая строка теперь дополнительно содержит «Start your response directly with `{`. No preamble, no commentary, no schema repetition.»

## Критерии приёмки

- [x] `pnpm check` — clean.
- [x] `pnpm test` — все старые + новые тесты проходят. **30/30 тестов** (было 26, +4 на `extractJson`).
- [x] Новые тесты:
  - `extractJson` — из текста с несколькими `{...}` берёт только первую полную пару ✓
  - `extractJson` — корректно обрабатывает экранированные кавычки внутри строк ✓
  - `extractJson` — возвращает первый balanced array, если объекта нет ✓
  - `extractJson` — не захватывает текст после закрывающей `}` ✓
  - Интеграционный retry-тест — проверяет `Strict format rules`, отсутствие `BAD (schema echo` ✓
- [x] Не сломана обратная совместимость: 2 теста на Zod-валидацию и retry без schema-echo проходят как раньше.
- [x] Существующие интеграционные тесты schema-echo — обновлены под новый текст retry-hint.

## Фикс 4 (отложено)

`maxRetries` 1 → 2 — не сделано в этом раунде. Причины:
- существующие тесты используют `mockResolvedValueOnce(...)` ровно на 2 ответа — изменение поведения потребует пересмотра всех;
- реальные пользовательские пайплайны могут начать чаще сжигать токены без гарантии успеха;
- нужен общий анализ стоимости vs. эффекта.

Предлагаю вынести в отдельную задачу **weft-retry-budget** и обсудить.
