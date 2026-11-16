// Карусели в стиле серии «Баннеры для PR и SMM» (Figma): разметка слайдов → картинки 1080×1080.
// Разметка простая, её пишет AI или редактор руками:
//   ===               новый слайд (первый — обложка)
//   # Заголовок       можно в две строки: две строки с «#» подряд
//   > Подзаголовок    приглушённый текст под заголовком
//   ## Акцент         оранжевый заголовок с засечками
//   Текст абзаца      строки подряд — один абзац с переносами; *слова* — оранжевым
//   - пункт           список с галочками
//   - [Метка] текст   пункт с оранжевой плашкой и разделителями
//   | текст           стеклянная карточка
//   ! текст           карточка-предупреждение с треугольником
//   + раз | два | три ряд из 2–4 плашек с галочками
//   @art: промпт      3D-иллюстрация справа снизу (на обложке — фон обложки)
(function () {
  'use strict';
  const S = 1080, M = 45, FW = 990, BG = '#1b1e23', ORANGE = '#FE6E36', LINE = '#686868';
  const SANS = '"ONY One Beta","Golos Text",Arial,sans-serif';
  const SERIF = '"Solar Serif","PT Serif",Georgia,serif';
  const WARN = new Path2D('M35.3654 6.16633C34.9757 5.48737 34.4137 4.92326 33.7361 4.53098C33.0586 4.1387 32.2896 3.93213 31.5067 3.93213C30.7238 3.93213 29.9548 4.1387 29.2773 4.53098C28.5997 4.92326 28.0377 5.48737 27.6479 6.16633L0.648513 52.1051C-1.15092 55.1685 1.00683 59.0627 4.50726 59.0627H58.5022C62.0026 59.0627 64.1643 55.1646 62.3609 52.1051L35.3654 6.16633ZM31.4988 19.6877C33.6054 19.6877 35.2552 21.5068 35.0426 23.6055L33.6644 37.4143C33.6181 37.9568 33.3699 38.4622 32.9689 38.8304C32.5679 39.1986 32.0433 39.403 31.4988 39.403C30.9544 39.403 30.4298 39.1986 30.0287 38.8304C29.6277 38.4622 29.3795 37.9568 29.3332 37.4143L27.9551 23.6055C27.9056 23.1103 27.9604 22.6102 28.1159 22.1375C28.2714 21.6647 28.5243 21.2298 28.8581 20.8607C29.192 20.4916 29.5994 20.1966 30.0542 19.9945C30.5091 19.7925 31.0012 19.688 31.4988 19.6877ZM31.5067 43.3127C32.551 43.3127 33.5525 43.7275 34.2909 44.466C35.0294 45.2044 35.4442 46.2059 35.4442 47.2502C35.4442 48.2945 35.0294 49.296 34.2909 50.0344C33.5525 50.7729 32.551 51.1877 31.5067 51.1877C30.4624 51.1877 29.4609 50.7729 28.7225 50.0344C27.984 49.296 27.5692 48.2945 27.5692 47.2502C27.5692 46.2059 27.984 45.2044 28.7225 44.466C29.4609 43.7275 30.4624 43.3127 31.5067 43.3127Z');

  // ------------------------------------------------------------------ разбор разметки
  function parse(src) {
    const parts = String(src || '').replace(/\r/g, '').split(/^[ \t]*={3,}[ \t]*$/m);
    const slides = parts.map(parseSlide).filter((s) => s.title || s.subtitle || s.blocks.length || s.hasArt);
    if (slides[0]) slides[0].cover = true;
    return slides;
  }

  function parseSlide(text) {
    const s = { title: '', subtitle: '', blocks: [], hasArt: false, art: '' };
    let cur = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) { cur = null; continue; }
      let m;
      if ((m = line.match(/^@(?:art|cover|image)\b\s*:?\s*(.*)$/i))) { s.hasArt = true; s.art = m[1].trim(); cur = null; continue; }
      if ((m = line.match(/^##\s*(.+)$/))) { s.blocks.push({ type: 'serif', text: m[1] }); cur = null; continue; }
      if ((m = line.match(/^#\s*(.+)$/))) { s.title += (s.title ? '\n' : '') + m[1]; cur = null; continue; }
      if ((m = line.match(/^>\s*(.*)$/))) { s.subtitle += (s.subtitle ? '\n' : '') + m[1]; cur = null; continue; }
      if ((m = line.match(/^[-–•]\s+(.+)$/))) {
        const pill = m[1].match(/^\[([^\]]+)\]\s*(.*)$/);
        const type = pill ? 'pills' : 'list';
        const item = pill ? { label: pill[1].trim(), text: pill[2] } : { text: m[1] };
        if (cur && cur.type === type) cur.items.push(item);
        else s.blocks.push((cur = { type, items: [item] }));
        continue;
      }
      if ((m = line.match(/^\+\s+(.+)$/))) {
        s.blocks.push({ type: 'chips', items: m[1].split('|').map((x) => x.trim()).filter(Boolean).slice(0, 4) });
        cur = null; continue;
      }
      const box = line.match(/^([|!])\s?(.*)$/);
      if (box) {
        const type = box[1] === '|' ? 'card' : 'warn';
        if (cur && cur.type === type) cur.text += '\n' + box[2];
        else s.blocks.push((cur = { type, text: box[2] }));
        continue;
      }
      // Строка с отступом продолжает предыдущий пункт списка
      if (cur && (cur.type === 'list' || cur.type === 'pills') && /^\s/.test(raw)) {
        const it = cur.items[cur.items.length - 1];
        it.text += '\n' + line;
        continue;
      }
      if (cur && cur.type === 'p') cur.text += '\n' + line;
      else s.blocks.push((cur = { type: 'p', text: line }));
    }
    return s;
  }

  // ------------------------------------------------------------------ типографика и перенос
  const SHORT = /(^|[\s(«"„])([аАвВиИкКоОсСуУяЯ]|на|На|не|Не|ни|Ни|по|По|до|До|из|Из|за|За|от|От|об|Об|во|Во|со|Со|ко|Ко|но|Но|для|Для|при|При|без|Без|что|Что|как|Как|или|Или) /g;
  function typo(s) {
    return String(s).replace(SHORT, '$1$2 ').replace(SHORT, '$1$2 ').replace(/ ([—–])/g, ' $1');
  }
  function runs(text) {
    const out = []; let o = false;
    for (const part of String(text).split('*')) { if (part) out.push({ t: part, o }); o = !o; }
    return out;
  }
  // Раскладывает текст с *оранжевыми* фрагментами на строки шириной maxW
  function wrapRich(c, text, font, maxW) {
    c.font = font;
    const space = c.measureText(' ').width, lines = [];
    for (const para of typo(text).split('\n')) {
      const toks = []; let pend = false;
      for (const r of runs(para)) {
        r.t.split(' ').forEach((p, i) => {
          if (i > 0) pend = true;
          if (!p) return;
          toks.push({ t: p, o: r.o, sp: pend && toks.length > 0, w: c.measureText(p).width });
          pend = false;
        });
      }
      let line = { segs: [], w: 0 };
      for (const tk of toks) {
        const add = (tk.sp ? space : 0) + tk.w;
        if (line.segs.length && line.w + add > maxW) {
          lines.push(line); line = { segs: [], w: 0 };
          line.segs.push({ t: tk.t, o: tk.o, x: 0 }); line.w = tk.w;
        } else {
          line.segs.push({ t: (tk.sp ? ' ' : '') + tk.t, o: tk.o, x: line.w }); line.w += add;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  // Базовая линия по правилам Figma: строка высотой lh, глифы по центру
  function baseline(c, font, lh) {
    c.font = font;
    const m = c.measureText('Hg');
    const a = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent, d = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent;
    return (lh - (a + d)) / 2 + a;
  }
  function drawLines(c, lines, font, x, y, lh, color, opt = {}) {
    c.font = font; c.textBaseline = 'alphabetic';
    const b = baseline(c, font, lh);
    c.save(); if (opt.alpha != null) c.globalAlpha = opt.alpha;
    lines.forEach((ln, i) => {
      const x0 = opt.center ? x + (opt.width - ln.w) / 2 : x;
      for (const sg of ln.segs) { c.fillStyle = sg.o ? ORANGE : color; c.fillText(sg.t, x0 + sg.x, y + i * lh + b); }
    });
    c.restore();
  }
  const sans = (px) => '400 ' + px.toFixed(1) + 'px ' + SANS;
  const serif = (px) => '400 ' + px.toFixed(1) + 'px ' + SERIF;

  // ------------------------------------------------------------------ элементы
  function check(c, cx, cy, r) {
    c.save(); c.fillStyle = ORANGE; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    const k = r / 21;
    c.strokeStyle = '#fff'; c.lineWidth = Math.max(2, 3.15 * k); c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(cx - 10.8 * k, cy - 0.5 * k); c.lineTo(cx - 3.3 * k, cy + 7 * k); c.lineTo(cx + 10.8 * k, cy - 7 * k); c.stroke();
    c.restore();
  }
  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  // Стеклянная подложка: размытый фон под ней + полупрозрачная заливка, как GLASS в Figma
  function glass(c, x, y, w, h, snap) {
    c.save(); rr(c, x, y, w, h, 9); c.clip();
    if (snap) { c.filter = 'blur(28px)'; c.drawImage(snap, 0, 0); c.filter = 'none'; }
    c.fillStyle = 'rgba(91,88,88,0.2)'; c.fillRect(x, y, w, h);
    const g = c.createLinearGradient(x + w, y, x + w * 0.55, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0.07)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(x, y, w, h);
    c.restore();
    c.save(); rr(c, x + 0.5, y + 0.5, w - 1, h - 1, 9); c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1; c.stroke(); c.restore();
  }

  // Каждый блок: measure(c, k, width) → высота и данные для отрисовки; draw(c, d, x, y)
  const BLOCKS = {
    p: {
      measure(c, b, k, w) { const lh = 38.5 * k, lines = wrapRich(c, b.text, sans(35 * k), w); return { h: lines.length * lh, lines, lh }; },
      draw(c, b, d, x, y, k) { drawLines(c, d.lines, sans(35 * k), x, y, d.lh, '#fff'); },
    },
    serif: {
      measure(c, b, k, w) { const lh = 55 * k, lines = wrapRich(c, b.text, serif(50 * k), w); return { h: lines.length * lh, lines, lh }; },
      draw(c, b, d, x, y, k) { drawLines(c, d.lines, serif(50 * k), x, y, d.lh, ORANGE); },
      after: 22,
    },
    list: {
      measure(c, b, k, w) {
        const lh = 38.5 * k, f = sans(35 * k);
        // Короткие пункты — маленькие галочки, длинные — крупные (как в макетах)
        const small = b.items.every((it) => wrapRich(c, it.text, f, w - 52 * k).length === 1);
        const indent = (small ? 52 : 67) * k, gap = (small ? 8.5 : 16) * k;
        const items = b.items.map((it) => wrapRich(c, it.text, f, w - indent));
        const h = items.reduce((a, l) => a + l.length * lh, 0) + gap * (items.length - 1);
        return { h, items, lh, small, indent, gap };
      },
      draw(c, b, d, x, y, k) {
        for (const lines of d.items) {
          const r = (d.small ? 13.34 : 21) * k;
          check(c, x + r, y + d.lh / 2, r);
          drawLines(c, lines, sans(35 * k), x + d.indent, y, d.lh, '#fff');
          y += lines.length * d.lh + d.gap;
        }
      },
    },
    pills: {
      measure(c, b, k, w) {
        const lh = 38.5 * k, f = sans(35 * k);
        const items = b.items.map((it) => ({ label: wrapRich(c, it.label, f, w)[0], lines: it.text.trim() ? wrapRich(c, it.text, f, w - 76 * k) : [] }));
        const h = items.reduce((a, it) => a + 1 + 42 * k + 42 * k + (it.lines.length ? 15 * k + it.lines.length * lh : 0) + 37 * k, 0) + 1;
        return { h, items, lh, w };
      },
      draw(c, b, d, x, y, k) {
        const f = sans(35 * k);
        const rule = (yy) => { c.fillStyle = LINE; c.fillRect(x, Math.round(yy), d.w, 1); };
        for (const it of d.items) {
          rule(y); y += 1 + 42 * k;
          check(c, x + 21 * k, y + 21 * k, 21 * k);
          const pw = (it.label ? it.label.w : 0) + 100 * k;
          c.fillStyle = ORANGE; rr(c, x + 76 * k, y, pw, 42 * k, 21 * k); c.fill();
          if (it.label) drawLines(c, [{ segs: it.label.segs.map((s) => ({ ...s, o: false })), w: it.label.w }], f, x + 126 * k, y + 1.5 * k, 42 * k, '#fff');
          y += 42 * k;
          if (it.lines.length) { y += 15 * k; drawLines(c, it.lines, f, x + 76 * k, y, d.lh, '#fff'); y += it.lines.length * d.lh; }
          y += 37 * k;
        }
        rule(y);
      },
    },
    card: {
      measure(c, b, k, w) { const lh = 38.5 * k, lines = wrapRich(c, b.text, sans(35 * k), w - 66 * k); return { h: lines.length * lh + 50 * k, lines, lh, w }; },
      draw(c, b, d, x, y, k, snap) { glass(c, x, y, d.w, d.h, snap); drawLines(c, d.lines, sans(35 * k), x + 33 * k, y + 25 * k, d.lh, '#fff'); },
      around: 12,
    },
    warn: {
      measure(c, b, k) { const w = 430 * k, lh = 35.2 * k, lines = wrapRich(c, b.text, sans(32 * k), w - 36 * k); return { h: 112 * k + lines.length * lh + 30 * k, lines, lh, w }; },
      draw(c, b, d, x, y, k, snap) {
        glass(c, x, y, d.w, d.h, snap);
        const s = 63 * k; c.save(); c.translate(x + (d.w - s) / 2, y + 31 * k); c.scale(k, k);
        c.fillStyle = '#fff'; c.fillRect(26, 18, 15, 37); c.fillStyle = ORANGE; c.fill(WARN); c.restore();
        drawLines(c, d.lines, sans(32 * k), x + 18 * k, y + 112 * k, d.lh, '#fff', { center: true, width: d.w - 36 * k });
      },
    },
    chips: {
      measure(c, b, k, w) {
        const n = b.items.length, gap = 31 * k, cw = (w - gap * (n - 1)) / n, lh = 38.5 * k;
        const items = b.items.map((t) => wrapRich(c, t, sans(35 * k), cw - 30 * k));
        const rows = Math.max(1, ...items.map((l) => l.length));
        return { h: 60 * k + rows * lh + 17 * k, items, lh, cw, gap };
      },
      draw(c, b, d, x, y, k, snap) {
        d.items.forEach((lines, i) => {
          const cx = x + i * (d.cw + d.gap);
          glass(c, cx, y, d.cw, d.h, snap);
          check(c, cx + d.cw / 2, y + 29.5 * k, 13.34 * k);
          drawLines(c, lines, sans(35 * k), cx + 15 * k, y + 60 * k, d.lh, '#fff', { center: true, width: d.cw - 30 * k });
        });
      },
    },
  };
  const NARROW = { p: 1, list: 1, serif: 1 };

  // ------------------------------------------------------------------ вёрстка слайда
  const ART = { x: 300, y: 440, w: 880, h: 680 };

  function layout(c, s, k) {
    const tf = sans(60 * k), tl = 66 * k;
    const title = s.title ? wrapRich(c, s.cover ? s.title.toUpperCase() : s.title, tf, FW) : [];
    let y = M + title.length * tl;
    let sub = [];
    if (s.subtitle) { sub = wrapRich(c, s.subtitle, sans(35 * k), FW - 66); y += (title.length ? 23 * k : 0) + sub.length * 38.5 * k; }
    const head = { title, sub, tf, tl, bottom: y };

    const art = s.hasArt && !s.cover;
    const measureAll = (narrowFrom) => s.blocks.map((b, i) => {
      const narrow = art && NARROW[b.type] && i >= narrowFrom;
      return { b, narrow, ...BLOCKS[b.type].measure(c, b, k, narrow ? 600 : FW) };
    });
    const place = (items) => {
      let cy = head.bottom + 60 * k, prev = null;
      return items.map((it) => {
        if (prev) cy += (BLOCKS[prev.b.type].after ?? 40) * k + ((BLOCKS[prev.b.type].around || 0) + (BLOCKS[it.b.type].around || 0)) * k;
        const top = cy; cy += it.h; prev = it; return { ...it, y: top };
      });
    };
    // Если есть иллюстрация, блоки, которые заходят на неё, верстаем уже — текст обтекает картинку
    let items = place(measureAll(Infinity));
    if (art) {
      const first = items.findIndex((it) => NARROW[it.b.type] && it.y >= ART.y - 60);
      if (first >= 0) items = place(measureAll(first));
    }
    const last = items.length ? items[items.length - 1].y + items[items.length - 1].h : head.bottom;
    const free = S - 60 - last;
    // Свободное место делим между отступом после шапки и промежутками, как в макетах
    if (free > 0 && items.length && !s.cover) {
      let shift = 0;
      if (art) {
        // С иллюстрацией текст держим наверху, а карточку-предупреждение опускаем к картинке
        items.forEach((it) => { if (it.b.type === 'warn') shift += Math.min(free, 150 * k); it.y += shift; });
      } else {
        // Без иллюстрации: больше воздуха после шапки и между смысловыми группами (не сразу после «## …»)
        const addHead = Math.min(free * 0.5, 90 * k);
        const open = items.filter((it, i) => i > 0 && items[i - 1].b.type !== 'serif').length;
        const addGap = open ? Math.min((free - addHead) * 0.5 / open, 40 * k) : 0;
        shift = addHead;
        items.forEach((it, i) => { if (i > 0 && items[i - 1].b.type !== 'serif') shift += addGap; it.y += shift; });
      }
    }
    return { head, items, free, k };
  }

  function fit(c, s) {
    let L;
    for (const k of [1, 0.94, 0.88, 0.82, 0.77, 0.72, 0.68]) { L = layout(c, s, k); if (L.free >= 0) return L; }
    return L;
  }

  // ------------------------------------------------------------------ картинки
  function drawCoverImage(c, img) {
    if (img && img.width) {
      const sc = Math.max(S / img.width, S / img.height), w = img.width * sc, h = img.height * sc;
      c.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
      c.save(); c.globalCompositeOperation = 'screen'; c.globalAlpha = 0.6; c.fillStyle = BG; c.fillRect(0, 0, S, S); c.restore();
    } else {
      const g = c.createRadialGradient(700, 760, 20, 700, 760, 520);
      g.addColorStop(0, 'rgba(254,110,54,.35)'); g.addColorStop(1, 'rgba(254,110,54,0)');
      c.fillStyle = g; c.fillRect(0, 0, S, S);
    }
    const g = c.createLinearGradient(0, 0, 0, 372);
    g.addColorStop(0, BG); g.addColorStop(1, 'rgba(27,30,35,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, 372);
  }
  // Иллюстрация справа снизу: прозрачный PNG ставим как есть, сгенерированную картинку растворяем по краям в фон
  function drawArt(c, img, top) {
    if (!img || !img.width) return;
    const y0 = Math.max(ART.y, top);
    if (img.transparent) {
      const box = { x: 400, y: y0 + 10, w: 680, h: Math.min(540, S - 40 - y0) };
      const sc = Math.min(box.w / img.width, box.h / img.height), w = img.width * sc, h = img.height * sc;
      c.drawImage(img, box.x + box.w - w, box.y + (box.h - h) / 2, w, h);
      return;
    }
    const size = Math.min(720, S + 60 - y0), x = S - size + 50, y = S - size + 40;
    const off = document.createElement('canvas'); off.width = off.height = Math.ceil(size);
    const o = off.getContext('2d');
    const sc = Math.max(size / img.width, size / img.height);
    o.drawImage(img, (size - img.width * sc) / 2, (size - img.height * sc) / 2, img.width * sc, img.height * sc);
    o.globalCompositeOperation = 'destination-in';
    const g = o.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.6, 'rgba(0,0,0,.85)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.fillRect(0, 0, size, size);
    c.drawImage(off, x, y);
  }

  // Обрезает прозрачные поля у PNG-рендера, чтобы его было удобно вписывать в зону иллюстрации
  function trim(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
    const a = x.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) if (a[(y * w + i) * 4 + 3] > 12) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return img;
    const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(cv, -x0, -y0); out.transparent = true;
    return out;
  }

  // ------------------------------------------------------------------ отрисовка
  function render(canvas, s, opt = {}) {
    canvas.width = S; canvas.height = S;
    const c = canvas.getContext('2d');
    c.fillStyle = BG; c.fillRect(0, 0, S, S);
    if (!s) return;
    const L = fit(c, s), k = L.k;
    if (s.cover) drawCoverImage(c, opt.image);
    else if (s.hasArt) {
      const wideBottom = L.items.filter((it) => !it.narrow && it.b.type !== 'warn').reduce((a, it) => Math.max(a, it.y + it.h), 0);
      drawArt(c, opt.image, wideBottom - 40);
    }
    let snap = null;
    if (opt.image && s.hasArt) { snap = document.createElement('canvas'); snap.width = snap.height = S; snap.getContext('2d').drawImage(canvas, 0, 0); }

    const { head } = L;
    drawLines(c, head.title, head.tf, M, M, head.tl, '#fff');
    if (head.sub.length) drawLines(c, head.sub, sans(35 * k), M, head.bottom - head.sub.length * 38.5 * k, 38.5 * k, '#fff', { alpha: 0.7 });

    if (s.cover) {
      // Обложка: под шапкой — лид, первая строка обычно оранжевая
      const text = s.blocks.filter((b) => b.text).map((b) => b.text).join('\n');
      if (text) { const lh = 42 * k, lines = wrapRich(c, text, sans(35 * k), 640); drawLines(c, lines, sans(35 * k), M, head.bottom + 60 * k, lh, '#fff'); }
    } else {
      for (const it of L.items) BLOCKS[it.b.type].draw(c, it.b, it, M, it.y, k, snap);
    }
    if (opt.busy || opt.error) badge(c, opt.error || opt.busy, !!opt.error);
  }
  function badge(c, text, err) {
    c.save(); c.font = '500 26px ' + SANS;
    const w = Math.min(S - 90, c.measureText(text).width + 48), x = S - M - w, y = S - M - 56;
    c.fillStyle = 'rgba(14,14,16,.82)'; rr(c, x, y, w, 56, 28); c.fill();
    c.fillStyle = err ? '#f3b4b4' : '#fff'; c.textBaseline = 'middle'; c.fillText(text, x + 24, y + 29, w - 48);
    c.restore();
  }

  function fontsReady() {
    return Promise.all([
      document.fonts.load('400 60px "ONY One Beta"'), document.fonts.load('400 35px "Golos Text"'),
      document.fonts.load('400 50px "Solar Serif"'), document.fonts.load('400 50px "PT Serif"'),
    ]).catch(() => {});
  }

  const DEMO = `# Solar AI Firewall
> Нейросети — под контролем
*Защита данных и контроль работы*
с внешними и внутренними ИИ-сервисами
@art: a single glowing orange translucent glass keyboard key rising from a row of matte black keys, warm light inside, macro shot

===
# Единые правила работы с ИИ
> Задавайте правила для сотрудников, подразделений и приложений.

## Например:
- [Финансистам] Работа с внешними моделями
  только с маскированием персональных данных.
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

*Подозрительные материалы* можно задержать
в карантине до решения специалиста ИБ.

===
# «Игнорируй предыдущие инструкции»
> Такая команда может быть попыткой обойти ограничения модели.

*Solar AI Firewall выявляет* попытки подмены инструкций и обхода ограничений, в том числе в передаваемых документах и результатах инструментов.

! При блокирующей политике останавливает обнаруженную атаку
@art: a stack of floating translucent dark glass document sheets with faint text lines, one sheet glowing warm orange

===
# Доступ к файлам —
# не разрешение на любые действия

## Solar AI Firewall
- проверяет запросы и материалы, передаваемые модели
- при подключении MCP-прокси на пути вызова инструментов позволяет ограничивать действия ИИ-агентов

## Например:
| отклонять запрещённый политикой вызов инструмента для удаления файлов до его выполнения. Контроль действует для вызовов, проходящих через подключённую точку проверки.

===
# Контроль использования ИИ
## Устанавливайте лимиты
+ на запросы | на токены | на бюджет

Решения системы и сработавшие правила *фиксируются в журнале.*

При настроенной интеграции события и инциденты *можно передавать в SIEM и SOAR.*
@art: a big orange translucent glass checkmark next to a small dark glass cube with a glowing orange core`;

  window.Carousel = { parse, render, fontsReady, trim, DEMO, SIZE: S };
})();
