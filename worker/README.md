# SMM Studio API (Cloudflare Worker)

Бэкенд для `index.html`: хранит ключи Claude и Krea, проверяет персональные ключи доступа и считает дневной лимит.
Вёрстка текста делается в браузере, Worker только передаёт запросы.

Адрес: `https://api.smm-studio-api-workers-dev.workers.dev`

| Запрос | Что делает |
|---|---|
| `GET /api/health` | проверка, без ключа |
| `GET /api/me` | имя, лимит и сколько осталось сегодня |
| `POST /api/plan` | Claude придумывает промпты фонов и подпись к посту |
| `POST /api/background` | запуск генерации фона в Krea (−1 из дневного лимита) |
| `GET /api/status/:id` | готов ли фон |
| `GET /api/image/:id` | картинка фона |

Ключ передаётся в заголовке `X-Access-Key`.

## Деплой
Автоматически из GitHub Actions при изменении папки `worker/` (или вручную: Actions → Deploy API → Run workflow).

GitHub Secrets (Settings → Secrets and variables → Actions):
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — для деплоя;
- `ANTHROPIC_API_KEY`, `KREA_API_TOKEN` — ключи сервисов;
- `ACCESS_KEYS` — список доступов (см. ниже).

## Доступы
В `ACCESS_KEYS` хранятся не сами ключи, а их SHA-256 — даже в настройках Cloudflare ключ не увидеть:

```json
{
  "<sha256 ключа>": { "name": "kate", "limit": 15 },
  "<sha256 ключа>": { "name": "wei", "limit": 15, "disabled": true }
}
```

- Добавить человека — новая строка; отключить — `"disabled": true` или удалить строку.
- После правки секрета запустите Actions → Deploy API → Run workflow.
- Человек получает ссылку `https://alex-lya-min.github.io/smm-studio/#key=<ключ>`: страница запомнит ключ и уберёт его из адреса.

## Лимиты
- `limit` — генераций фона в день на человека (сброс в полночь по Сингапуру, `TZ_OFFSET_HOURS`).
- `TEAM_DAILY_LIMIT` в `wrangler.jsonc` — общий потолок на команду.
- Запросов к Claude — не больше `limit × 3` в день.
