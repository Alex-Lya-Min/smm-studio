// SMM Studio API — Cloudflare Worker.
// Хранит ключи Claude, Kimi и Krea, проверяет ключ доступа сотрудника, считает дневной лимит генераций
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

// Короткая причина ошибки от внешнего сервиса — чтобы в интерфейсе было видно, что именно не так
async function upstreamReason(r) {
  let text = "";
  try {
    text = await r.text();
    const j = JSON.parse(text);
    text = j.error?.message || j.error || j.message || j.detail || text;
    if (typeof text !== "string") text = JSON.stringify(text);
  } catch {}
  return String(text).replace(/\s+/g, " ").slice(0, 180);
}

// ----------------------------------------------------------------------------- Claude

const PLAN_SYSTEM = `You are the art director of the dark social media style of Solar, a cybersecurity company.
The look: dark charcoal background (#1b1e23), cinematic 3D renders made of translucent glowing orange glass and matte
black graphite, warm orange light, calm and premium. Text is typeset later by code, the image model makes only the picture.
You get a post brief, the headline, the layout and the format.
Return ONLY a JSON object: {"prompts": ["...", ...], "caption": "..."}.
- "prompts": exactly N distinct prompts in English, 30-60 words each, each a different visual metaphor of the brief.
  Layout "cover": a close-up cinematic scene, the hero object in the lower half of the frame, slightly right of center;
    the whole upper half of the frame is empty dark background for the headline.
  Layouts "art" and "card": ONE isolated hero object or a small group, centered with generous empty margins
    on a plain flat dark charcoal background, no floor, no other elements.
  Every prompt MUST end with: "${NO_TEXT}, no screens with readable UI, no people".
- "caption": a short social media caption (1-3 sentences) in the same language as the brief, based ONLY on the brief.
  Do not invent facts, numbers, names or dates.`;

// ----------------------------------------------------------------------------- выбор нейросети
// Текст и промпты может писать Claude или Kimi (Moonshot). Kimi включается, когда задан секрет MOONSHOT_API_KEY.
const AI_NAMES = { claude: "Claude", kimi: "Kimi" };
function providers(env) {
  return ["claude", ...(env.MOONSHOT_API_KEY ? ["kimi"] : [])];
}
function pickAi(env, value) {
  return providers(env).includes(value) ? value : "claude";
}
async function llm(env, ai, system, user, maxTokens) {
  return ai === "kimi" ? kimi(env, system, user, maxTokens) : claude(env, system, user, maxTokens);
}

// Kimi думает долго, поэтому его ответ отдаём в браузер потоком как есть (SSE): студия видит прогресс,
// а Worker почти не тратит процессорное время. Ошибки до начала потока возвращаем обычным JSON.
async function kimiStream(env, system, user, maxTokens) {
  const r = await fetch(`${env.KIMI_API_BASE || "https://api.moonshot.ai"}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.MOONSHOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.KIMI_MODEL || "kimi-k3.1-pro",
      reasoning_effort: env.KIMI_REASONING || "low",
      max_completion_tokens: maxTokens * 4,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok || !r.body) {
    const why = await upstreamReason(r);
    console.error("kimi", r.status, why);
    throw new HttpError(502, `Kimi ответил ошибкой ${r.status}: ${why}`);
  }
  return new Response(r.body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-ai-stream": "kimi" },
  });
}

// Kimi: OpenAI-совместимый Chat Completions на api.moonshot.ai
async function kimi(env, system, user, maxTokens) {
  const r = await fetch(`${env.KIMI_API_BASE || "https://api.moonshot.ai"}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.MOONSHOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.KIMI_MODEL || "kimi-k3.1-pro",
      reasoning_effort: env.KIMI_REASONING || "low",
      // Модели K3 сначала «думают», и эти токены тоже идут в лимит ответа — даём запас
      max_completion_tokens: maxTokens * 4,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) {
    const why = await upstreamReason(r);
    console.error("kimi", r.status, why);
    throw new HttpError(502, `Kimi ответил ошибкой ${r.status}: ${why}`);
  }
  const data = await r.json();
  const text = ((data.choices || [])[0] || {}).message?.content || "";
  return String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function claude(env, system, user, maxTokens) {
  const r = await fetch(`${env.ANTHROPIC_API_BASE || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const why = await upstreamReason(r);
    console.error("claude", r.status, why);
    throw new HttpError(502, `Claude ответил ошибкой ${r.status}: ${why}`);
  }
  const data = await r.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function planUser(input) {
  return [
    `N: ${input.count}`,
    `Format: ${input.format}`,
    `Composition type: ${input.template}`,
    `Headline on the image: ${input.headline || "(none)"}`,
    `Brief:\n${input.brief || "(empty)"}`,
  ].join("\n");
}

async function claudePlan(env, input) {
  const name = AI_NAMES[input.ai];
  const text = await llm(env, input.ai, PLAN_SYSTEM, planUser(input), 1500);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new HttpError(502, `${name} вернул неожиданный ответ — попробуйте ещё раз`);
  const plan = JSON.parse(m[0]);
  const prompts = (Array.isArray(plan.prompts) ? plan.prompts : []).map((p) => clip(p, 1200)).filter(Boolean);
  if (!prompts.length) throw new HttpError(502, `${name} не составил промпты`);
  while (prompts.length < input.count) prompts.push(prompts[prompts.length % prompts.length]);
  return { prompts: prompts.slice(0, input.count), caption: clip(plan.caption, 1000) };
}

// ----------------------------------------------------------------------------- карусели

const CAROUSEL_EXAMPLE = `# Solar AI Firewall
> Нейросети — под контролем
*Защита данных и контроль работы*
с внешними и внутренними ИИ-сервисами
@art: a single glowing orange translucent glass keyboard key rising from a row of matte black keys, warm light inside, macro shot, the object in the lower half of the frame, the upper half empty dark background
===
# Единые правила работы с ИИ
> Задавайте правила для сотрудников, подразделений и приложений.

## Например:
- [Финансистам] Работа с внешними моделями только с маскированием персональных данных.
- [Разработчикам] Запрет на передачу ключей доступа.
===
# Договор — в нейросеть
> А персональные данные?

*Solar AI Firewall выявляет*
чувствительные данные в запросах и ответах:
- персональные данные
- реквизиты
- ключи доступа

| По заданным правилам система маскирует данные или блокирует передачу.

*Подозрительные материалы* можно задержать в карантине до решения специалиста ИБ.
===
# «Игнорируй предыдущие инструкции»
> Такая команда может быть попыткой обойти ограничения модели.

*Solar AI Firewall выявляет* попытки подмены инструкций и обхода ограничений, в том числе в передаваемых документах и результатах инструментов.

! При блокирующей политике останавливает обнаруженную атаку
@art: a stack of floating translucent dark glass document sheets with faint lines, one sheet glowing warm orange
===
# Результат
По итогам пилота «Инфосистемы Джет» рекомендовала Solar SIEM для использования в клиентских проектах.

" «В Solar SIEM мы увидели возможность предложить единый подход к мониторингу событий и автоматизации реагирования. Результаты пилотирования подтвердили целесообразность использования решения в проектах клиентов».
— Александр Мещеряков | директор департамента внедрения систем мониторинга ИБ «Инфосистемы Джет»
===
# Контроль использования ИИ
## Устанавливайте лимиты
+ на запросы | на токены | на бюджет

Решения системы и сработавшие правила *фиксируются в журнале.*

При настроенной интеграции события и инциденты *можно передавать в SIEM и SOAR.*
@art: a big orange translucent glass checkmark next to a small dark glass cube with a glowing orange core`;

const SLIDES_SYSTEM = `You write social media carousels for Solar, a cybersecurity company, in a fixed dark design system.
Code turns your slide markup into 1080x1080 slides, so follow the markup exactly.

MARKUP (one element per line, a blank line separates blocks):
===               starts the next slide; slide 1 is the cover
# text            slide title, up to ~45 characters; two consecutive # lines = manual line break
> text            muted subtitle under the title (optional, up to ~90 characters)
## text           orange serif accent heading, 1-4 words (for example "Например:" or a product name)
plain lines       a paragraph; consecutive lines form one paragraph. Wrap 1-5 key words in *asterisks* to color them orange,
                  at most one orange fragment per paragraph
- text            checklist item (1-4 words, or one sentence); 2-4 items
- [Label] text    item with an orange label pill, for "who or what -> rule" pairs; 2-3 items
| text            glass card for an example, a conclusion or an important note (1-2 sentences)
! text            warning card with a triangle icon (one short sentence); only on a slide that also has @art
+ a | b | c       a row of 2-4 chips, 1-3 words each
" text            a quote with big orange quote marks (keep the quote verbatim, with its «»); consecutive " lines = one quote
— Name | role     the quote's author, on the line right after the quote (name, then | , then position and company)
@art: prompt      a 3D illustration in the lower right of the slide; on the cover it is the full background image

DESIGN RULES
- Cover: "# product or topic" (it is typeset in capitals), "> short tagline", then a lead paragraph of 1-3 lines
  whose first line is wrapped in *asterisks*, then "@art: ...". The cover always has @art.
- Every other slide: one idea, a title and at most ~55 words. Mix 2-3 element types per slide and vary the structure
  from slide to slide (cards, lists, chips, label pills, accent headings).
- Use @art on at most 2 slides after the cover; keep text on those slides short, because the image takes the lower right.
- The last slide sums up or gives a call to action.
- The brief is often a document from a colleague, sometimes already split into cards or slides
  ("Карточка 1", "Слайд 2", numbered sections). Then follow that split and order, and keep the wording:
  move the approved text into the markup almost verbatim, only shorten where it would not fit a slide.
  Ignore service notes in the brief (deadlines, comments to the designer, links), but if it describes a picture
  for a slide, use that for the slide's @art prompt.
- When the brief has a quote of a person, put it on its own slide with the " and — elements, verbatim.
- Write in the language of the brief. Use ONLY facts from the brief: never invent numbers, features, customer names,
  certifications, prices or dates. If the brief is thin, make fewer slides instead of padding.
- No emoji and no hashtags on slides.

@art PROMPTS (English, 25-50 words): one hero object or a small group that is a visual metaphor of the slide, cinematic 3D
render, translucent orange glass and matte black graphite materials, warm glowing orange light, isolated on a plain flat
dark background, no text. For the cover: a close-up scene, the hero object in the lower half of the frame, slightly right
of center; the whole upper half of the frame is empty dark background, because the title and lead are set there.

OUTPUT: the markup, then a line with exactly ---CAPTION--- , then a caption for the whole carousel
(2-4 sentences and up to 3 hashtags, same language, only facts from the brief). No code fences, nothing else.

EXAMPLE OF A GOOD CAROUSEL (style and rhythm reference, do not copy its content):
${CAROUSEL_EXAMPLE}
---CAPTION---
Solar AI Firewall помогает компаниям безопасно работать с нейросетями: правила для сотрудников, маскирование данных и защита от подмены инструкций. #ИИ #кибербезопасность`;

function slidesUser(input) {
  return input.instruction
    ? [
        "Here is the current carousel markup. Change it according to the editor's request and keep everything else",
        "exactly as it is (same slides, wording and @art prompts unless the request is about them).",
        `Editor's request: ${input.instruction}`,
        `Current markup:\n${input.markup}`,
        `Original brief (for facts only):\n${input.brief || "(none)"}`,
      ].join("\n")
    : [
        input.slides
          ? `Slides: exactly ${input.slides}, including the cover`
          : "Slides: if the brief is already split into cards or slides, as many as it has (max 10); otherwise 5-7 including the cover, fewer if the brief is short",
        input.title ? `Product or topic for the cover: ${input.title}` : "",
        `Brief:\n${input.brief}`,
      ].filter(Boolean).join("\n");
}

async function claudeSlides(env, input) {
  const text = (await llm(env, input.ai, SLIDES_SYSTEM, slidesUser(input), 4500)).replace(/^\s*```[a-z]*\s*|\s*```\s*$/g, "");
  const [markup, caption = ""] = text.split(/^\s*-{3}CAPTION-{3}\s*$/m);
  if (!/^#\s*\S/m.test(markup || "")) throw new HttpError(502, `${AI_NAMES[input.ai]} вернул неожиданный ответ — попробуйте ещё раз`);
  return { markup: clip(markup, 15000), caption: clip(caption, 1500) };
}

// ----------------------------------------------------------------------------- Krea

function kreaBase(env) {
  return env.KREA_API_BASE || "https://api.krea.ai";
}

// Референсы стиля (рендеры из Figma), через запятую: CAROUSEL_COVER_REFS — обложки, CAROUSEL_ART_REFS — 3D-иллюстрации
function refList(value) {
  return (value || "").split(",").map((s) => s.trim()).filter((s) => /^https:\/\//.test(s)).slice(0, 4);
}

// look — описание стиля; с референсами оно идёт как «повтори стиль, но не объекты», без них — просто как стиль
const STYLES = {
  cover: {
    refs: (env) => refList(env.CAROUSEL_COVER_REFS),
    look:
      "cinematic close-up 3D render, matte black and translucent glowing orange glass, dark charcoal background (#1b1e23), " +
      "shallow depth of field. Composition: the hero object sits in the LOWER half of the frame, slightly right of center; " +
      "the whole upper half of the frame is empty dark background with nothing in it (text goes there).",
  },
  art: {
    refs: (env) => refList(env.CAROUSEL_ART_REFS),
    look:
      "3D render of translucent orange glass and dark graphite objects. The object is isolated in the center with generous " +
      "empty margins on a plain flat dark charcoal background (#1b1e23), no floor, no other elements.",
  },
};

async function kreaStart(env, prompt, format, style = "art") {
  const st = STYLES[style] || STYLES.art;
  const refs = st.refs(env);
  const body = { prompt, aspect_ratio: ASPECT[format] || "1:1", resolution: env.KREA_RESOLUTION || "1K" };
  if (refs.length) {
    body.image_urls = refs;
    body.prompt =
      "Use the reference images ONLY as a style guide: the same rendering quality, " + st.look +
      " Do NOT copy their objects or composition — create a new scene: " + prompt;
  } else {
    body.prompt = "Style: " + st.look + " Scene: " + prompt;
  }
  const send = (b) =>
    fetch(`${kreaBase(env)}/generate/image/${env.KREA_MODEL || "google/nano-banana-pro"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KREA_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
  let r = await send(body);
  // Если Krea не приняла референсы — пробуем ещё раз без них, чтобы пост всё равно собрался
  if (!r.ok && refs.length && r.status !== 401 && r.status !== 402) {
    console.error("krea with refs", r.status, await upstreamReason(r));
    r = await send({ prompt, aspect_ratio: body.aspect_ratio, resolution: body.resolution });
  }
  if (r.status === 402) throw new HttpError(402, "На балансе Krea API закончились средства");
  if (!r.ok) {
    const why = await upstreamReason(r);
    console.error("krea", r.status, why);
    throw new HttpError(502, `Krea ответила ошибкой ${r.status}: ${why}`);
  }
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
    return json({ name: user.name, limit: user.limit, used, remaining: Math.max(0, user.limit - used), day, ai: providers(env) });
  }

  if (path === "/api/plan" && request.method === "POST") {
    const body = await readJson(request);
    // План дешёвый, но тоже ограничен — не больше трёх планов на одну доступную генерацию
    const quota = await me.consume("plan", day, user.limit * 3);
    if (!quota.ok) throw new HttpError(429, "На сегодня лимит запросов исчерпан");
    const input = {
      count: Math.min(5, Math.max(1, Number(body.count) || 1)),
      format: ASPECT[body.format] ? body.format : "square",
      template: ["cover", "art", "card"].includes(body.template) ? body.template : "cover",
      headline: clip(body.headline, 120),
      brief: clip(body.brief, 2000),
      ai: pickAi(env, body.ai),
    };
    if (input.ai === "kimi") return kimiStream(env, PLAN_SYSTEM, planUser(input), 1500);
    const plan = await claudePlan(env, input);
    return json({ prompts: plan.prompts, caption: plan.caption });
  }

  if (path === "/api/slides" && request.method === "POST") {
    const body = await readJson(request);
    const brief = clip(body.brief, 15000);
    const instruction = clip(body.instruction, 1000);
    const markup = clip(body.markup, 15000);
    if (instruction && markup.length < 10) throw new HttpError(400, "Сначала соберите карусель, потом её можно поправить");
    if (!instruction && brief.length < 20) throw new HttpError(400, "Вставьте бриф — хотя бы пару предложений");
    const quota = await me.consume("plan", day, user.limit * 3);
    if (!quota.ok) throw new HttpError(429, "На сегодня лимит запросов исчерпан");
    const n = Number(body.slides) || 0;
    const input = {
      brief,
      title: clip(body.title, 120),
      slides: n ? Math.min(10, Math.max(3, n)) : 0,
      instruction,
      markup,
      ai: pickAi(env, body.ai),
    };
    if (input.ai === "kimi") return kimiStream(env, SLIDES_SYSTEM, slidesUser(input), 4500);
    return json(await claudeSlides(env, input));
  }

  if (path === "/api/background" && request.method === "POST") {
    const body = await readJson(request);
    const style = STYLES[body.style] ? body.style : "art";
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
      const jobId = await kreaStart(env, prompt, format, style);
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
