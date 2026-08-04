# Флаг --version для CLI weft

## Контекст

Сейчас `weft` не умеет показывать свою версию. Пользователи и разработчики должны вручную смотреть `package.json` или `pnpm list`. Это неудобно для отладки и поддержки.

## Цель

Добавить поддержку флагов `--version` и `-v` в CLI, которые выводят версию пакета `@human-horizon/weft` из `package.json`.

## Что изменится

1. `src/cli.ts` — обработка флагов `--version` и `-v` перед разбором команд.
2. `specs/cli.spec.md` — дополнение раздела справки.
3. `tests/weft.test.ts` — не затрагивается напрямую, но при необходимости можно добавить тест CLI (пока ограничиваемся ручной проверкой).

## Детали реализации

### Поведение

```bash
weft --version
# 0.3.2

weft -v
# 0.3.2
```

Флаг должен работать из любой директории, даже если нет `.lore/weft/`.

### Реализация в `src/cli.ts`

В функции `main()` перед `switch(command)` добавить:

```typescript
const args = argv.slice(2);

if (args[0] === "--version" || args[0] === "-v") {
    const pkgPath = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    console.log(pkg.version);
    return;
}
```

`readFileSync` уже импортирован из `node:fs`.

### Обработка ошибок

Если `package.json` не удаётся прочитать, выводится:

```
❌ Failed to read package version: <error message>
```

и exit code 1.

## Критерии приёмки

- [x] `weft --version` выводит версию из `package.json`.
- [x] `weft -v` выводит ту же версию.
- [x] Флаг работает вне зависимости от наличия `.lore/weft/`.
- [x] `pnpm check` и `pnpm test` проходят.
- [x] Спека `specs/cli.spec.md` обновлена.
