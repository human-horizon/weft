# Защита weft от JSON.parse-падений и "эхо схемы" модели

## Контекст

В продакшне (проект `sofia`, пайплайн `НапишиСтатью`) всплыло падение:

```
[weft]   extracted JSON (203 chars): {
  title: string,
  content: string,
  keywords: [string, ...]
}
Your response must be VALID JSON matching this schema exactly.
Previous response was invalid: SyntaxError: Expected property name or '}'
```

**Что произошло:**

1. Модель получила от weft промпт, в который `schemaToPrompt()` дописал JSON-shape описания схемы.
2. Вместо JSON-данных модель **скопировала этот shape в свой ответ** (TypeScript-подобный синтаксис: `title: string`, `[string, ...]`).
3. `extractJson` вытащил `{ ... }` блок → `JSON.parse` упал с `SyntaxError`.
4. Retry случился, но промпт-retry не содержал отдельного указания "верни данные, а не схему" — модель снова провалилась.
5. На опубликованной `weft@0.3.0` нет `WeftSchemaValidationError` — пользователь видит голый стек.

**В нашем текущем weft `0.3.6` уже есть `WeftSchemaValidationError`** для финального падения (включая JSON.parse-фейл — он попадает в `collectValidationIssuesFromError`), но он **не помогает агенту** понять ошибку на retry. Также нет детекта конкретного кейса "модель вернула описание схемы".

## Цель

Сделать weft устойчивым к ситуации "модель эхо-ит схему вместо данных":

- Retry-промпт явно указывает агенту: верни JSON-объект с данными, **не копируй** описание схемы.
- В финальной ошибке (`WeftSchemaValidationError`) появляется конкретная подсказка, если ответ похож на описание схемы.

## Что изменится

1. `src/schema-to-prompt.ts` — усилить итоговую инструкцию явным запретом "не повторяй схему".
2. `src/zod-middleware.ts`:
   - Добавить детектор schema-echo (`looksLikeSchemaEcho`).
   - На retry при обнаружении schema-echo — добавить в retry-промпт отдельный блок с пояснением и примером.
   - На финальной ошибке — добавить в `WeftSchemaValidationError` поле `looksLikeSchemaEcho: boolean` и включить подсказку в форматированное сообщение.
3. `tests/weft.test.ts` — добавить 3 теста:
   - а) модель вернула TS-shape → поймали детектор, retry получил усиленный промпт;
   - б) модель 2 раза вернула TS-shape → финальный `WeftSchemaValidationError`, `looksLikeSchemaEcho=true`, текст ошибки содержит подсказку;
   - в) модель вернула невалидный JSON (не схема, а просто битый) — `looksLikeSchemaEcho=false`, старая логика.

## Детали реализации

### 1. `src/schema-to-prompt.ts`

Финальная инструкция (последняя строка сообщения):

```ts
return [
    "Respond in valid JSON only. No markdown fences, no commentary.",
    "Expected format:",
    shape,
    "",
    "Your response must be a JSON object containing the actual data for the fields above.",
    "Do NOT echo or repeat the schema description.",
    "Do NOT use TypeScript syntax — values like `string`, `number`, `boolean` are not valid JSON values.",
    "Example of correct answer:",
    example,
].join("\n")
```

`example` — короткий JSON-объект, сгенерированный по shape: для каждого строкового поля — `""`, для enum — первый вариант, для массива — `[]`, для вложенного объекта — минимальный пример.

### 2. `src/zod-middleware.ts`

- Хелпер:

```ts
function looksLikeSchemaEcho(text: string): boolean {
    // Heuristics: TS-shape signatures or [string, ...] tuples
    return /:\s*(string|number|boolean|unknown|null|undefined)\b/.test(text)
        || /\[\s*(string|number|boolean|\w+,\s*\.\.\.)\s*\]/.test(text)
        || /\btype\s+\w+\s*=\s*\{/.test(text)
}
```

- В retry-цикле: если `looksLikeSchemaEcho(extractedJson)`, добавить к retry-промпту блок:

```
⚠ Your previous response looked like a schema description, not data.

BAD (schema echo):
{ title: string, content: string, ... }

GOOD (actual data):
{ "title": "...", "content": "...", ... }

Return the GOOD form: a JSON object with real values (strings in quotes, numbers without quotes, arrays as [...]).
```

- `WeftSchemaValidationError`: добавить опциональное поле `looksLikeSchemaEcho: boolean`. Если `true` — в `formatSchemaValidationError` добавить отдельную секцию "Possible cause: the model repeated the schema description instead of returning data".

### 3. Тесты — `tests/weft.test.ts`

Использовать существующий паттерн моков `mockInvokeAgent`. На каждый тест — мок последовательности ответов.

## Критерии приёмки

- [x] `pnpm check` (tsc --noEmit) — без ошибок.
- [x] `pnpm test` — все тесты (включая новые) проходят. 26/26 тестов (было 19, добавлено 7: 4 на детектор + 3 на schema-echo handling).
- [x] `pnpm build` — успешно (dist собран).
- [x] В `dist/zod-middleware.js` присутствует экспорт `WeftSchemaValidationError` с обновлённой сигнатурой (поле `looksLikeSchemaEcho: boolean`).
- [x] Модель `stdout: "{ title: string, ... }"` на второй попытке получает промпт с блоком про "BAD/GOOD example".
- [x] Финальный `WeftSchemaValidationError.looksLikeSchemaEcho === true`, и в сообщении есть секция `Possible cause:`.
- [x] Невалидный JSON, не являющийся схемой (напр. `{ broken`), по-прежнему выбрасывает `WeftSchemaValidationError`, но `looksLikeSchemaEcho === false`.
