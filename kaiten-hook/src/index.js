// Kaiten → GitHub: принимает внешний вебхук Kaiten и, если карточка попала в колонку «Очередь»,
// будит робота в GitHub Actions через repository_dispatch. Сам ничего не генерирует.
//
// Секреты Worker: HOOK_SECRET — часть адреса (/kaiten/<секрет>), HOOK_GH_TOKEN — токен GitHub
// с правом Contents: write на репозиторий робота.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// Сравнение секрета без утечки по времени
function same(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Достаёт id колонки из значения: число, строка или {old/new}
function columnOf(v) {
  if (v == null) return null;
  if (typeof v === "object") return columnOf(v.new ?? v.to ?? v.value ?? v.id);
  return String(v);
}

// Решаем, будить ли робота
function decide(event, data, env) {
  const queue = String(env.QUEUE_COLUMN_ID);
  if (event === "card:add") {
    const col = columnOf(data.column_id ?? data.column?.id ?? data.card?.column_id);
    // Колонку не нашли — будим на всякий случай: робот сам дёшево проверит очередь
    if (col === null) return { wake: true, reason: "card:add, колонка неизвестна" };
    return col === queue ? { wake: true, reason: "новая карточка в очереди" } : { wake: false, reason: "новая карточка не в очереди" };
  }
  if (event === "card:update") {
    const ch = data.changes || {};
    if (!("column_id" in ch) && !ch.column) return { wake: false, reason: "карточку изменили, но не перемещали" };
    const col = columnOf(ch.column_id ?? ch.column?.id ?? ch.column);
    return col === queue ? { wake: true, reason: "карточку перенесли в очередь" } : { wake: false, reason: "карточку перенесли не в очередь" };
  }
  return { wake: false, reason: "событие не про карточку" };
}

async function dispatch(env, payload) {
  const r = await fetch(`${env.GITHUB_API || "https://api.github.com"}/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.HOOK_GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kaiten-hook",
      "content-type": "application/json",
    },
    body: JSON.stringify({ event_type: env.DISPATCH_TYPE || "kaiten", client_payload: payload }),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ status: "ok", service: "kaiten-hook" });

    const m = url.pathname.match(/^\/kaiten\/([^/]+)\/?$/);
    if (!m || !same(m[1], env.HOOK_SECRET)) return json({ error: "not found" }, 404);
    if (request.method === "GET") return json({ ok: true, hint: "Адрес верный: Kaiten шлёт сюда POST" });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "ожидался JSON" }, 400);
    }
    const event = String(body.event || "");
    const data = body.data && typeof body.data === "object" ? body.data : {};
    const card = data.id ?? data.card_id ?? data.old?.id ?? null;
    const verdict = decide(event, data, env);

    // В логах Cloudflare видно каждое событие и решение (Workers → kaiten-hook → Logs)
    console.log(JSON.stringify({
      webhook: request.headers.get("webhook-id"),
      event,
      card,
      ...verdict,
      changes: data.changes ? Object.keys(data.changes) : undefined,
    }));

    if (!verdict.wake) return json({ ok: true, wake: false, reason: verdict.reason });
    try {
      await dispatch(env, { event, card_id: card, webhook_id: request.headers.get("webhook-id") });
    } catch (e) {
      console.error("dispatch failed", e.message);
      // 502 — Kaiten повторит доставку позже
      return json({ ok: false, error: "не удалось разбудить робота" }, 502);
    }
    return json({ ok: true, wake: true, reason: verdict.reason });
  },
};
