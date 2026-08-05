# weft: фильтр role=assistant в JSON-событиях агента (round 3)

## Контекст

В `sofia` (`НапишиСтатью.ts`) каждый запуск заканчивался с `WeftSchemaValidationError` и `rawResponse`, дословно совпадающим с нашим промптом. Сначала казалось, что модель делает prompt-echo, но **Аня подтвердила: модель нормальная и так не делает**.

Реальная причина найдена в `src/agent.ts`: при парсинге JSON-событий от `pi-coding-agent --mode json` обработчик `message_end` **не фильтрует по `event.message.role`** и берёт `content` от любого сообщения. Когда в стрим приходит `message_end` для **user-role** (нашего промпта), обработчик перезаписывает `finalText` этим промптом, и `result.stdout` становится **самим промптом**, а не ответом модели.

Цепочка симптомов в sofia:
1. Модель нормально отвечает JSON-объектом (или schema-echo — неважно).
2. `message_end` для user-role прилетает и перезаписывает `finalText` → `result.stdout = наш промпт`.
3. `extractJson` берёт из промпта первый balanced-блок (`[string]` из `keywords: [string]`).
4. JSON.parse падает → retry → цикл повторяется.
5. В финальной ошибке `rawResponse` == наш промпт, что и смутило Аню.

## Цель

Отфильтровать user-сообщения в парсинге JSON-событий агента, чтобы `result.stdout` содержал **только ответ ассистента**, а не наш промпт.

## Что изменится

1. `src/agent.ts`:
   - Рефакторинг: вынести `processEvent` из `invokeJsonMode` в экспортируемую чистую функцию `parseEvent(state, event)`, чтобы её можно было юнит-тестировать без spawn.
   - В `parseEvent` для `message_end` и `text_end` добавить проверку `event.message?.role === "assistant"` (или эквивалентное условие).
2. `tests/agent.test.ts` (новый):
   - Тест 1: событие `message_end` с `role: "user"` НЕ должно менять `state.finalText`.
   - Тест 2: событие `message_end` с `role: "assistant"` обновляет `state.finalText` корректно.
   - Тест 3: чередование user/assistant message_end → `finalText` равен последнему assistant.
   - Тест 4 (бонус): событие `text_end` также корректно реагирует на role.

## Детали реализации

### Рефакторинг agent.ts

Заменить вложенную `function processEvent(line)` внутри `invokeJsonMode` на модуль-уровневую экспортируемую чистую функцию:

```ts
export interface StreamState {
    finalText: string
    streamedText: string
    streamedThinking: string
    stderr: string[]
}

export function parseEvent(state: StreamState, event: JsonEvent): void {
    // Thinking
    if (event.assistantMessageEvent?.type === "thinking_delta") {
        const delta = event.assistantMessageEvent.delta
        if (delta) {
            process.stderr.write(`\x1b[2m${delta}\x1b[0m`)
            state.streamedThinking += delta
        }
        return
    }
    if (event.assistantMessageEvent?.type === "thinking_start") {
        state.streamedThinking = ""
        return
    }
    if (event.assistantMessageEvent?.type === "thinking_end") {
        process.stderr.write("\n")
        return
    }

    // Text deltas (assistantMessageEvent implies assistant)
    if (event.assistantMessageEvent?.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta
        if (delta) {
            process.stdout.write(delta)
            state.streamedText += delta
        }
        return
    }
    if (event.assistantMessageEvent?.type === "text_start") return
    if (event.assistantMessageEvent?.type === "text_end") {
        // text_end в assistantMessageEvent — это всегда ассистент,
        // но проверяем role для надёжности
        if (event.message?.role !== "user") {
            const content = event.assistantMessageEvent.content
            if (content) state.finalText = content
        }
        return
    }

    // message_end — критическая ветка, обязательно фильтруем role
    if (event.type === "message_end" && event.message?.role === "assistant") {
        const content = event.message.content
        if (Array.isArray(content)) {
            const textParts = content
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
            if (textParts.length > 0) {
                state.finalText = textParts.join("")
            }
        }
    }
}
```

Внутри `invokeJsonMode` создаём `const state: StreamState = { ... }` и в цикле `for (const line of lines) { parseEvent(state, JSON.parse(line)) }`.

После `child.on("close")` resolve возвращает `{ stdout: state.finalText || state.streamedText, ... }`.

### Тесты

`tests/agent.test.ts` — новый файл. Использует `vi.mock("node:child_process", ...)` если нужно, но основной happy-path — чистые unit-тесты на `parseEvent`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest"
import { parseEvent, type StreamState } from "../src/agent.js"

function makeState(): StreamState {
    return { finalText: "", streamedText: "", streamedThinking: "", stderr: [] }
}

function message_end(role: "user" | "assistant", text: string) {
    return {
        type: "message_end",
        message: {
            role,
            content: [{ type: "text", text }],
        },
    }
}

describe("parseEvent — message_end role filter", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
        vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    })

    it("does NOT update finalText on user-role message_end", () => {
        const state = makeState()
        parseEvent(state, message_end("user", "Our prompt text here"))
        expect(state.finalText).toBe("")
    })

    it("updates finalText on assistant-role message_end", () => {
        const state = makeState()
        parseEvent(state, message_end("assistant", '{"ok": true}'))
        expect(state.finalText).toBe('{"ok": true}')
    })

    it("uses last assistant message_end, ignoring user messages in between", () => {
        const state = makeState()
        parseEvent(state, message_end("user", "first prompt"))
        parseEvent(state, message_end("assistant", '{"a":1}'))
        parseEvent(state, message_end("user", "second prompt"))
        parseEvent(state, message_end("assistant", '{"a":2}'))
        expect(state.finalText).toBe('{"a":2}')
    })
})
```

## Критерии приёмки

- [x] Спецификация написана и согласована.
- [x] `pnpm check` — clean.
- [x] `pnpm test` — все старые (30) + новые (7) проходят. **37/37**.
- [x] `tests/agent.test.ts` экспортирует 7 кейсов на `parseEvent` (4 на message_end, 2 на text_end, 1 на text_delta).
- [x] `src/agent.ts` экспортирует `parseEvent` и `StreamState`.
- [x] В `invokeJsonMode` вместо вложенной `processEvent` используется модульная `parseEvent`.
- [x] Гипотеза проверена: тест "does NOT update finalText on user-role message_end" подтверждает, что finalText остаётся пустым.
- [x] Bump версии `0.4.1 → 0.4.2`.

## Файлы для коммита

- `src/agent.ts` — рефакторинг + role-фильтр
- `tests/agent.test.ts` — новый файл
- `specs/weft-agent-role-filter.spec.md` — этот файл
- `package.json` — version bump
