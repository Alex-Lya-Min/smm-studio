// SMM Studio API — Cloudflare Worker.
// Хранит ключи Claude и Krea, проверяет ключ доступа сотрудника, считает дневной лимит генераций
// и проксирует запросы. Тяжёлой работы здесь нет: вёрстка текста делается в браузере.

import { DurableObject } from "cloudflare:workers";

const ASPECT = { square: "1:1", wide: "16:9", story: "9:16", portrait: "4:5" };
const NO_TEXT = "no text, no letters, no logos, no watermarks";

// ----------------------------------------------------------------------------- учёт лимитов

/** Один экземпляр на сотрудника (и один общий «__team__»): счётчики за день и его задачи Krea. */
export class Usage extends DurableObject {
  async consume(counter, day, limit) {
    const key = `${counter}:${day}`;
    const used = (await this.ctx.storage.get(key)) || 0;
    if (used >= limit) return { ok: false, used, limit };
    await this.ctx.storage.put(key, used + 1);
    return { ok: true, used: used + 1, limit };
  }

  async refund(counter, day) {
    const key = `${counter}:${day}`;
    const used = (await this.ctx.storage.get(key)) || 0;
    if (used > 0) await this.ctx.storage.put(key, used - 1);
  }

  async used(counter, day) {
    return (await this.ctx.storage.get(`${counter}:${day}`)) || 0;
  }

  async addJob(id) {
    const jobs = (await this.ctx.storage.get("jobs")) || [];
    jobs.push(id);
    await this.ctx.storage.put("jobs", jobs.slice(-200));
  }

  async hasJob(id) {
    const jobs = (await this.ctx.storage.get("jobs")) || [];
    return jobs.includes(id);
  }
}

// ----------------------------------------------------------------------------- вспомогательное

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function today(env) {
  // День сбрасывается в полночь по часовому поясу команды (по умолчанию Сингапур, UTC+8)
  const offset = Number(env.TZ_OFFSET_HOURS ?? 8);
  return new Date(Date.now() + offset * 3600_000).toISOString().slice(0, 10);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let accessCache;
function accessList(env) {
  if (!accessCache) {
    try {
      accessCache = JSON.parse(env.ACCESS_KEYS || "{}");
    } catch {
      accessCache = {};
    }
  }
  return accessCache;
}

async function authenticate(request, env) {
  const key = (request.headers.get("X-Access-Key") || "").trim();
  if (key.length < 16) throw new HttpError(401, "Нужен ключ доступа");
  const user = accessList(env)[await sha256(key)];
  if (!user || user.disabled) throw new HttpError(401, "Ключ не подходит или отключён");
  return { name: String(user.name), limit: Number(user.limit) || 15 };
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const local = env.ALLOW_LOCALHOST === "true" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.includes(origin) || local) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

async function readJson(request, maxBytes = 20_000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "Слишком большой запрос");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HttpError(400, "Ожидался JSON");
  }
}

function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function usageStub(env, name) {
  return env.USAGE.get(env.USAGE.idFromName(name));
}

// ----------------------------------------------------------------------------- Claude

const PLAN_SYSTEM = `You are the art director of the dark social media style of Solar, a cybersecurity company.
The brand look: near-black background (#0E0E0E), cinematic 3D renders of abstract technology objects (cubes, chips,
server blocks, boxes, shields, data streams, globes) made of matte graphite and warm orange materials, glowing orange
#FE6E36 light accents, soft volumetric light, subtle film grain, lots of empty black space. Isometric or 3/4 view.
You get a post brief, the headline that will be typeset on the image, the layout and the format.
Write prompts for an image model that will generate ONLY the BACKGROUND render. Text is added later by code.
Return ONLY a JSON object: {"prompts": ["...", ...], "caption": "..."}.
- "prompts": exactly N distinct prompts in English, 40–80 words each: one clear hero object or small group that is
  a visual metaphor of the brief, materials, light, camera angle. Make the variants different metaphors.
  Respect the empty zone required by the layout:
    "cover" — headline sits in the TOP 40% of the frame: keep the top 40% pure black and empty, objects in the lower part;
    "caps"  — headline sits in the BOTTOM 30%: keep the bottom 30% dark and empty, objects in the upper and middle part;
    "card"  — text blocks fill the TOP-LEFT half: keep the top half dark and calm, objects in the lower right.
  Every prompt MUST end with: "${NO_TEXT}, no screens with readable UI, no people".
- "caption": a short social media caption (1–3 sentences) in the same language as the brief, based ONLY on the brief.
  Do not invent facts, numbers, names or dates.`;

async function claudePlan(env, input) {
  const user = [
    `N: ${input.count}`,
    `Format: ${input.format}`,
    `Composition type: ${input.template}`,
    `Headline on the image: ${input.headline || "(none)"}`,
    `Brief:\n${input.brief || "(empty)"}`,
  ].join("\n");
  const r = await fetch(`${env.ANTHROPIC_API_BASE || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: 1500,
      system: PLAN_SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new HttpError(502, `Claude ответил ошибкой ${r.status}`);
  const data = await r.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new HttpError(502, "Claude вернул неожиданный ответ");
  const plan = JSON.parse(m[0]);
  const prompts = (Array.isArray(plan.prompts) ? plan.prompts : []).map((p) => clip(p, 1200)).filter(Boolean);
  if (!prompts.length) throw new HttpError(502, "Claude не составил промпты");
  while (prompts.length < input.count) prompts.push(prompts[prompts.length % prompts.length]);
  return { prompts: prompts.slice(0, input.count), caption: clip(plan.caption, 1000), usage: data.usage };
}

// ----------------------------------------------------------------------------- Krea

function kreaBase(env) {
  return env.KREA_API_BASE || "https://api.krea.ai";
}

// Референсы стиля (рендеры из Figma), через запятую в переменной STYLE_REFS
function styleRefs(env) {
  return (env.STYLE_REFS || "").split(",").map((s) => s.trim()).filter((s) => /^https:\/\//.test(s)).slice(0, 4);
}

async function kreaStart(env, prompt, format) {
  const refs = styleRefs(env);
  const body = { prompt, aspect_ratio: ASPECT[format] || "1:1", resolution: env.KREA_RESOLUTION || "1K" };
  if (refs.length) {
    body.image_urls = refs;
    body.prompt =
      "Use the reference images ONLY as a style guide: the same rendering quality, matte graphite and warm orange " +
      "materials, glowing orange accents, near-black background, soft cinematic light and grain. " +
      "Do NOT copy their objects or composition — create a new scene: " + prompt;
  }
  const r = await fetch(`${kreaBase(env)}/generate/image/${env.KREA_MODEL || "google/nano-banana-pro"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.KREA_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 402) throw new HttpError(402, "На балансе Krea API закончились средства");
  if (!r.ok) throw new HttpError(502, `Krea ответила ошибкой ${r.status}`);
  const job = await r.json();
  if (!job.job_id) throw new HttpError(502, "Krea не вернула номер задачи");
  return job.job_id;
}

async function kreaJob(env, id) {
  const r = await fetch(`${kreaBase(env)}/jobs/${id}`, {
    headers: { Authorization: `Bearer ${env.KREA_API_TOKEN}` },
  });
  if (r.status === 404) throw new HttpError(404, "Задача не найдена");
  if (!r.ok) throw new HttpError(502, `Krea ответила ошибкой ${r.status}`);
  return r.json();
}

// ----------------------------------------------------------------------------- маршруты

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/health" && request.method === "GET") {
    return json({ status: "ok", service: "SMM Studio API" });
  }

  const user = await authenticate(request, env);
  const day = today(env);
  const me = usageStub(env, user.name);
  const team = usageStub(env, "__team__");
  const teamLimit = Number(env.TEAM_DAILY_LIMIT) || 60;

  if (path === "/api/me" && request.method === "GET") {
    const used = await me.used("gen", day);
    return json({ name: user.name, limit: user.limit, used, remaining: Math.max(0, user.limit - used), day });
  }

  if (path === "/api/plan" && request.method === "POST") {
    const body = await readJson(request);
    // План дешёвый, но тоже ограничен — не больше трёх планов на одну доступную генерацию
    const quota = await me.consume("plan", day, user.limit * 3);
    if (!quota.ok) throw new HttpError(429, "На сегодня лимит запросов исчерпан");
    const input = {
      count: Math.min(5, Math.max(1, Number(body.count) || 1)),
      format: ASPECT[body.format] ? body.format : "square",
      template: ["cover", "caps", "card"].includes(body.template) ? body.template : "cover",
      headline: clip(body.headline, 120),
      brief: clip(body.brief, 2000),
    };
    const plan = await claudePlan(env, input);
    return json({ prompts: plan.prompts, caption: plan.caption });
  }

  if (path === "/api/background" && request.method === "POST") {
    const body = await readJson(request);
    let prompt = clip(body.prompt, 1500);
    if (prompt.length < 10) throw new HttpError(400, "Пустой промпт");
    if (!prompt.toLowerCase().includes("no text")) prompt += `, ${NO_TEXT}`;
    const format = ASPECT[body.format] ? body.format : "square";

    const teamQuota = await team.consume("gen", day, teamLimit);
    if (!teamQuota.ok) throw new HttpError(429, "Общий дневной лимит команды исчерпан");
    const quota = await me.consume("gen", day, user.limit);
    if (!quota.ok) {
      await team.refund("gen", day);
      throw new HttpError(429, `Лимит ${user.limit} генераций на сегодня исчерпан`);
    }
    try {
      const jobId = await kreaStart(env, prompt, format);
      await me.addJob(jobId);
      return json({ job_id: jobId, used: quota.used, remaining: user.limit - quota.used });
    } catch (err) {
      // Генерация не началась — возвращаем попытку
      await me.refund("gen", day);
      await team.refund("gen", day);
      throw err;
    }
  }

  const status = path.match(/^\/api\/status\/([^/]+)$/);
  if (status && request.method === "GET") {
    const id = status[1];
    if (!UUID.test(id) || !(await me.hasJob(id))) throw new HttpError(404, "Задача не найдена");
    const job = await kreaJob(env, id);
    if (job.status === "completed") return json({ status: "completed" });
    if (job.status === "failed" || job.status === "cancelled") {
      return json({ status: "failed", error: "Генерация не удалась — попробуйте другой фон" });
    }
    return json({ status: "pending" });
  }

  const image = path.match(/^\/api\/image\/([^/]+)$/);
  if (image && request.method === "GET") {
    const id = image[1];
    if (!UUID.test(id) || !(await me.hasJob(id))) throw new HttpError(404, "Картинка не найдена");
    const job = await kreaJob(env, id);
    const src = job.status === "completed" && job.result?.urls?.[0];
    if (!src) throw new HttpError(409, "Картинка ещё не готова");
    const img = await fetch(src);
    if (!img.ok) throw new HttpError(502, "Не удалось скачать картинку");
    return new Response(img.body, {
      headers: {
        "Content-Type": img.headers.get("Content-Type") || "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  throw new HttpError(404, "Нет такого адреса");
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!(err instanceof HttpError)) console.error(err);
      response = json({ error: err instanceof HttpError ? err.message : "Внутренняя ошибка" }, status);
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
};
