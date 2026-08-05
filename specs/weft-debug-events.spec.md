# weft: диагностический режим JSON-событий (round 4 / 0.4.3)

## Контекст

После 0.4.2 в sofia появилась новая проблема: `agent stdout (0 chars)` (модель не возвращает текст). Нужно понять — модель реально молчит, или `parseEvent` что-то теряет. Без видимости в event-stream любой фикс будет вслепую.

## Цель

Дать оператору возможность увидеть **полный JSON-event stream**, который `pi-coding-agent --mode json` шлёт в stdout — каждое событие целиком, в том числе `message.role`, `assistantMessageEvent.type` и т.п.

## Что меняется

1. `src/agent.ts` — в начале `parseEvent` добавить условное логирование:

```ts
export function parseEvent(state: StreamState, event: JsonEvent): void {
    // Diagnostic: dump every event to stderr when WEFT_DEBUG_EVENTS is set.
    // Disabled by default. Activated by: WEFT_DEBUG_EVENTS=1 weft run ...
    if (process.env.WEFT_DEBUG_EVENTS) {
        process.stderr.write(`[weft-evt] ${JSON.stringify(event)}\n`)
    }
    // ...
}
```

Никакого другого поведения не меняется. Тесты остаются зелёными.

2. `tests/agent.test.ts` — добавить тест: при `WEFT_DEBUG_EVENTS`=on вызов `parseEvent` пишет в stderr; при off — не пишет.

3. `README.md` (или отдельный короткий блок) — пример запуска:
   ```
   WEFT_DEBUG_EVENTS=1 pnpm start
   ```

## Детали реализации

### Env-переменная

`WEFT_DEBUG_EVENTS` — любое non-empty значение включает логирование. Удобно: `=1`, `=true`, `=yes`. Отсутствие или пустая строка — выключено.

### Как и куда пишем

В `process.stderr.write(...)` с префиксом `[weft-evt] `. Это отделит наш лог от `thinking_delta`, который тоже идёт в stderr (но без префикса, с ANSI-форматированием).

### Размер

Один event — JSON.stringify может быть большим (особенно с content arrays). Но это диагностический режим для разового использования, размер не критичен.

## Критерии приёмки

- [ ] `pnpm check` — clean.
- [ ] `pnpm test` — все 37 старых + 2 новых теста проходят.
- [ ] Новые тесты:
  - `parseEvent` без `WEFT_DEBUG_EVENTS` не пишет ничего в stderr.
  - `parseEvent` с `WEFT_DEBUG_EVENTS=1` пишет JSON event в stderr с префиксом `[weft-evt] `.
- [ ] Bump 0.4.2 → 0.4.3.

## Файлы

- `src/agent.ts` — тривиальная правка
- `tests/agent.test.ts` — 2 новых теста
- `specs/weft-debug-events.spec.md` — этот файл
- `package.json` — version bump
