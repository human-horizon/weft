# Исправление глобальной установки weft

## Контекст

Глобальная установка опубликованной `@human-horizon/weft` падает:

```
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @aws-sdk/token-providers@3.1100.0
```

Это происходит из-за битого дерева транзитивных зависимостей AWS SDK в пакетах `@earendil-works/pi-*`. Локальная установка с `pnpm-lock.yaml` работает, но при публикации lock-файл не передаётся, и установщик пытается разрешить зависимости заново.

## Цель

Обновить зависимости `@earendil-works/pi-*` до версии, у которой нет битого дерева AWS SDK, и подготовить пакет к публикации.

## Что изменится

1. `package.json` — версии `dependencies`:
   - `@earendil-works/pi-agent-core`
   - `@earendil-works/pi-ai`
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-tui`
   будут обновлены до `0.83.0` (последняя общая версия).
2. `pnpm-lock.yaml` — обновится после `pnpm install`.
3. `dist/` — пересоберётся через `pnpm build`.
4. Новая/обновлённая спека: `specs/fix-global-install-dependency.spec.md`.

## Детали реализации

### 1. Обновление зависимостей

В `package.json` заменить:

```json
"@earendil-works/pi-agent-core": "0.80.3",
"@earendil-works/pi-ai": "0.80.3",
"@earendil-works/pi-coding-agent": "0.80.3",
"@earendil-works/pi-tui": "0.80.3",
```

на:

```json
"@earendil-works/pi-agent-core": "0.83.0",
"@earendil-works/pi-ai": "0.83.0",
"@earendil-works/pi-coding-agent": "0.83.0",
"@earendil-works/pi-tui": "0.83.0",
```

### 2. Проверка локальной установки

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

### 3. Проверка глобальной установки

Собрать tarball:

```bash
pnpm pack
```

Попробовать установить tarball глобально:

```bash
pnpm add -g ./human-horizon-weft-*.tgz
```

Если установка пройдёт, проверить `weft --version`.

### 4. Публикация (выполняет пользователь)

Если проверки прошли, публикация делается вручную:

```bash
pnpm version patch
pnpm build
pnpm publish --access public
```

## Критерии приёмки

- [ ] `pnpm install` проходит без ошибок.
- [ ] `pnpm check` и `pnpm test` проходят.
- [ ] `pnpm pack` создаёт tarball.
- [ ] `pnpm add -g ./human-horizon-weft-*.tgz` устанавливается без ошибки `@aws-sdk/token-providers@3.1100.0`.
- [ ] `weft --version` работает после глобальной установки tarball.
- [ ] Пользователь получает точные команды для публикации.
