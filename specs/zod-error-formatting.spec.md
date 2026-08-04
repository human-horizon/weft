# Красивое сообщение об ошибке валидации Zod

## Контекст

Сейчас, если в `.prompt()` передана Zod-схема и модель возвращает ответ, который не проходит валидацию, `src/zod-middleware.ts` бросает сырой `ZodError` или `SyntaxError` от `JSON.parse`. В сообщении непонятно, что именно ответило модель, и почему ответ не подошёл. Это мешает отладке.

## Цель

После исчерпания попыток retry выбрасывать структурированную, красиво оформленную ошибку, которая содержит:
- сам "бажный" ответ модели (сырой `stdout`);
- извлечённый из него JSON, который пытались распарсить/валидировать;
- конкретные ошибки валидации с путями;
- ожидаемую схему.

## Что изменится

1. `src/zod-middleware.ts` — добавится класс `WeftSchemaValidationError` и форматирование ошибок.
2. `tests/weft.test.ts` — добавится тест на финальную ошибку валидации с проверкой содержимого.

## Детали реализации

### 1. Новый класс ошибки

В `src/zod-middleware.ts` создать:

```typescript
class WeftSchemaValidationError extends Error {
  rawResponse: string
  extractedResponse: string
  validationIssues: Array<{ path: string; message: string }>
  schemaDescription: string

  constructor(opts: {
    rawResponse: string
    extractedResponse: string
    validationIssues: Array<{ path: string; message: string }>
    schemaDescription: string
  }) {
    super(formatSchemaError(opts))
    this.name = "WeftSchemaValidationError"
    this.rawResponse = opts.rawResponse
    this.extractedResponse = opts.extractedResponse
    this.validationIssues = opts.validationIssues
    this.schemaDescription = opts.schemaDescription
  }
}
```

### 2. Форматирование Zod-ошибок

```typescript
function formatValidationIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }))
}
```

Если ошибка произошла на этапе `JSON.parse`, то `validationIssues` будет `[{ path: "(root)", message: "Failed to parse JSON: <текст ошибки>" }]`.

### 3. Формат итогового сообщения

```
Schema validation failed after 2 attempts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Raw model response
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<raw stdout>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Extracted JSON
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<extracted JSON text>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Validation errors
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- (root): Failed to parse JSON: ...
- bugs.0.severity: Invalid enum value

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Expected schema
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<schema description from schemaToPrompt>
```

### 4. Изменение в `invokeWithSchema`

Внутри цикла retry при `attempt === maxRetries` вместо `throw err` собирать данные и выбрасывать `WeftSchemaValidationError`:

- `rawResponse = result.stdout`
- `extractedResponse = extractJson(result.stdout)`
- если `err instanceof z.ZodError` → `validationIssues = formatValidationIssues(err)`
- иначе → `validationIssues = [{ path: "(root)", message: "Failed to parse JSON: ${err}" }]`
- `schemaDescription = schemaToPrompt(schema)`

### 5. Тест

Добавить в `tests/weft.test.ts`:

```typescript
it("should throw a pretty error on final schema validation failure", async () => {
  mockInvokeAgent.mockResolvedValue(makeResult({ stdout: "not valid json" }));

  const pipeline = weave("test")
    .prompt("audit", () => "audit", { schema: AnalyzeSchema })
    .build();

  await expect(pipeline.run({})).rejects.toThrow(WeftSchemaValidationError);
  await expect(pipeline.run({})).rejects.toMatchObject({
    rawResponse: "not valid json",
    extractedResponse: "not valid json",
  });
});
```

Для этого `WeftSchemaValidationError` должен быть экспортирован из `src/zod-middleware.ts`.

## Критерии приёмки

- [x] При финальной ошибке валидации бросается `WeftSchemaValidationError`, а не сырой `ZodError`/`SyntaxError`.
- [x] Сообщение ошибки содержит сырой ответ модели, извлечённый JSON, список ошибок валидации и ожидаемую схему.
- [x] `WeftSchemaValidationError` доступен из тестов.
- [x] Все существующие тесты проходят.
- [x] `pnpm check` проходит без ошибок.
