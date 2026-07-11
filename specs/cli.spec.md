# Weft CLI — запуск TypeScript-пайплайнов

## Мотивация

Пользователи пишут пайплайны на TypeScript (top-level await, импорт `@human-horizon/weft`).
Нужен CLI, который:
- Находит подходящий рантайм (bun, tsx, node + tsx)
- Запускает файл с переданными аргументами
- Показывает список доступных пайплайнов
- Создаёт шаблон нового пайплайна
- Настраивает проект (`.lore/weft/`)
- Поддерживает интерактивный выбор и streaming вывода модели

## Команды

### `weft run <file> [args...]`

Запустить TypeScript-файл пайплайна.

- `<file>` — путь к `.ts` файлу (абсолютный или относительный)
- `[args...]` — аргументы, передаются в `main(args)` пайплайна
- Если файл не найден относительно текущей директории — ищет в `WEFT_PIPELINES_DIR`
- `WEFT_PIPELINES_DIR` по умолчанию равен `.lore/weft/pipelines/`

**Поиск рантайма:**
1. Если файл в `.lore/` — `tsx` (bun не дружит с pnpm symlinks)
2. `bun` — если установлен
3. `tsx` — если установлен
4. `npx tsx` — fallback (требует Node >= 20)

**Перед запуском показывает дерево вызовов:**

```
⚡ Pipeline plan:
├── ◆ fibonacci
│   model: free → home-pc/qwen-3.5-9b thinking: high [fibbonachi]
└── ⚡ summary (step)
```

**Флаги:**
- `--dry-run` — только показать что будет запущено
- `--help` — справка по команде

### `weft list [dir]`

Показать все `.ts` файлы (с `export async function main()`) рекурсивно.

- `[dir]` — путь к директории (по умолчанию `WEFT_PIPELINES_DIR` или `.lore/weft/pipelines/`)
- Фильтрует файлы: показывает только те, где есть `export async function main`
- Подпапки показываются как `[subdir]`
- Описание извлекается из `export const meta`

### `weft init <name>`

Создать шаблон нового пайплайна.

- `<name>` — имя файла (без `.ts`)
- Создаёт `<name>.ts` в `WEFT_PIPELINES_DIR` или `.lore/weft/pipelines/`
- Шаблон включает `export const meta` для интерактивного режима

### `weft install`

Настроить проект для работы с weft.

- Выполняется из корня проекта
- Создаёт `.lore/weft/package.json` и `.lore/weft/pipelines/`
- Обновляет `@human-horizon/weft` в существующем `package.json` до последней опубликованной версии
- Не создаёт `.gitignore` и `pnpm-workspace.yaml`
- Запускает `pnpm install --ignore-scripts --config.minimum-release-age=0` в `.lore/weft/`, чтобы pnpm не создавал workspace-конфигурацию автоматически
- Используется для первоначальной настройки и обновления проекта

**Использование:**
```bash
mkdir my-project && cd my-project && weft install
weft  # интерактивный выбор пайплайна
```

### `weft` (без аргументов) / `weft interactive`

Интерактивный режим — показывает список пайплайнов и запускает выбранный.

1. Рекурсивно сканирует `WEFT_PIPELINES_DIR` или `.lore/weft/pipelines/` (фильтрует по `main()`)
2. Извлекает `export const meta` для отображения описания
3. Запрашивает номер пайплайна
4. Если есть `meta.args` — запрашивает значения с подсказками
5. Запускает с введёнными аргументами

**Meta — описание пайплайна:**

```typescript
export const meta = {
    description: "Вычисляет числа Фибоначчи",
    args: [
        { name: "n", type: "number", description: "Количество чисел", default: 10 },
    ],
};
```

### `weft help [command]`

Показать справку.

## Структура проекта

Weft-проект хранит конфигурацию в `.lore/weft/`:

```
project/
├── .lore/
│   └── weft/                          # отдельный package.json + node_modules
│       ├── package.json               # зависит от последней версии @human-horizon/weft
│       ├── pnpm-lock.yaml             # создаётся pnpm
│       ├── node_modules/              # создаётся pnpm
│       └── pipelines/                 # .ts файлы пайплайнов
├── src/                               # код проекта
└── package.json                       # основной проект
```

## Переменные окружения

| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `WEFT_PIPELINES_DIR` | Директория с пайплайнами | `.lore/weft/pipelines/` |
| `WEFT_PI_HOME` | Pi-окружение | `~/.ai/weft/pi/` |
| `WEFT_PI_PATH` | Путь к pi CLI | автоопределение |

## Поведение

- Все команды возвращают exit code 0 при успехе, 1 при ошибке
- Ошибки пишутся в stderr
- Цветной вывод (если терминал поддерживает)
- Модели читаются из `~/.ai/settings.json` (modelMapping)
- Неизвестный тег модели → ошибка (не молчаливый выбор)
- Сессии pi автоматически очищаются после пайплайна