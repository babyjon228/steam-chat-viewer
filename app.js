"use strict";
const $ = s => document.querySelector(s);

// ---------- state ----------
let messages = [];      // {from, to, date: Date|null, raw, text, idx}
let people = [];        // participant names sorted by frequency
let me = null;
let chats = new Map();  // other -> [messages]
let current = null;

// ---------- date parsing ----------
const MONTHS = {
  jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
  янв:0, фев:1, мар:2, апр:3, мая:4, май:4, июн:5, июл:6, авг:7, сен:8, окт:9, ноя:10, дек:11
};
function parseDate(s) {
  if (!s) return null;
  s = s.replace(/ /g, " ").trim();
  if (/^\d{9,10}$/.test(s)) return new Date(+s * 1000);
  const iso = Date.parse(s);
  if (!isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(s)) return new Date(iso);

  const low = s.toLowerCase();
  let month = -1;
  for (const [k, v] of Object.entries(MONTHS)) {
    if (new RegExp("(^|[^a-zа-яё])" + k).test(low)) { month = v; break; }
  }
  const time = low.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/);
  let h = 0, mi = 0, se = 0;
  if (time) {
    h = +time[1]; mi = +time[2]; se = +(time[3] || 0);
    if (time[4] === "pm" && h < 12) h += 12;
    if (time[4] === "am" && h === 12) h = 0;
  }
  const rest = time ? low.replace(time[0], " ") : low;
  const nums = (rest.match(/\d+/g) || []).map(Number);
  const year = nums.find(n => n > 1999);
  if (month >= 0) {
    const day = nums.find(n => n >= 1 && n <= 31);
    if (day) return new Date(year || new Date().getFullYear(), month, day, h, mi, se);
  }
  // dd.mm.yyyy or mm/dd/yyyy
  let m = rest.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    const dot = rest.includes(".");
    const d = dot ? +m[1] : +m[2], mo = (dot ? +m[2] : +m[1]) - 1;
    return new Date(y, mo, d, h, mi, se);
  }
  if (!isNaN(iso)) return new Date(iso);
  return null;
}

// ---------- column detection ----------
const HEAD = {
  from: /sender|from|отправ|автор|author/i,
  to:   /recip|receiver|to\b|получ|кому|партн|partner/i,
  date: /time|date|врем|дата|timestamp/i,
  text: /message|text|сообщ|текст|content|body/i
};
function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    for (const [k, re] of Object.entries(HEAD)) {
      if (map[k] === undefined && re.test(h)) { map[k] = i; break; }
    }
  });
  return map;
}
function guessColumns(rows) {
  const n = Math.max(...rows.map(r => r.length));
  const sample = rows.slice(0, 200);
  const dateScore = [], lenScore = [], uniq = [];
  for (let c = 0; c < n; c++) {
    const vals = sample.map(r => r[c] || "");
    dateScore[c] = vals.filter(v => /\d/.test(v) && parseDate(v)).length;
    lenScore[c] = vals.reduce((a, v) => a + v.length, 0);
    uniq[c] = new Set(vals).size;
  }
  const map = {};
  map.date = dateScore.indexOf(Math.max(...dateScore));
  const others = [...Array(n).keys()].filter(c => c !== map.date);
  // message = column with most distinct values / longest text
  others.sort((a, b) => (uniq[b] + lenScore[b] / 50) - (uniq[a] + lenScore[a] / 50));
  map.text = others[0];
  const names = others.slice(1).sort((a, b) => a - b);
  map.from = names[0]; map.to = names[1];
  return map;
}

// ---------- parsing input ----------
function cellText(td) {
  // Steam emoticons/stickers sometimes render as <img alt=":name:">
  td.querySelectorAll("img[alt]").forEach(img => img.replaceWith(img.alt));
  td.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
  return td.textContent.replace(/[ \t ]+/g, " ").replace(/\n\s*/g, "\n").trim();
}

function rowsFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out = [];
  for (const table of doc.querySelectorAll("table")) {
    const trs = [...table.querySelectorAll("tr")];
    if (trs.length < 2) continue;
    let headers = null;
    const body = [];
    for (const tr of trs) {
      const ths = tr.querySelectorAll("th");
      if (ths.length && !headers) { headers = [...ths].map(cellText); continue; }
      const tds = [...tr.querySelectorAll("td")].map(cellText);
      if (tds.length >= 3) body.push(tds);
    }
    if (body.length) out.push({ headers, body });
  }
  return out;
}

function rowsFromText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.includes("\t"));
  if (!lines.length) return [];
  let rows = lines.map(l => l.split("\t").map(s => s.trim()));
  let headers = null;
  if (Object.keys(mapHeaders(rows[0])).length >= 3) headers = rows.shift();
  rows = rows.filter(r => r.length >= 3);
  return rows.length ? [{ headers, body: rows }] : [];
}

function decodeMhtml(text) {
  // "Save as single file" in Chrome produces quoted-printable HTML
  if (!/^MIME-Version:/im.test(text.slice(0, 2000))) return text;
  const part = text.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  const bytes = part.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  try { return decodeURIComponent(escape(bytes)); } catch { return bytes; }
}

function extract(sources) {
  const result = [];
  for (const src of sources) {
    const text = decodeMhtml(src);
    const tables = /<t[dr][\s>]/i.test(text) ? rowsFromHtml(text) : rowsFromText(text);
    for (const { headers, body } of tables) {
      let map = headers ? mapHeaders(headers) : {};
      if (["from", "to", "date", "text"].some(k => map[k] === undefined)) map = { ...guessColumns(body), ...map };
      for (const r of body) {
        const raw = r[map.date] || "";
        result.push({ from: r[map.from] || "?", to: r[map.to] || "?", raw, date: parseDate(raw), text: r[map.text] || "" });
      }
    }
  }
  return result;
}

// ---------- model ----------
function build(list) {
  // dedupe (several overlapping files) and sort chronologically
  const seen = new Set();
  messages = [];
  list.forEach((m, i) => {
    const key = m.from + "\u0001" + m.to + "\u0001" + m.raw + "\u0001" + m.text;
    if (seen.has(key)) return;
    seen.add(key);
    m.idx = i;
    messages.push(m);
  });
  const allDated = messages.every(m => m.date);
  if (allDated) messages.sort((a, b) => a.date - b.date || b.idx - a.idx);
  else messages.reverse(); // Steam lists newest first

  const freq = new Map();
  for (const m of messages) for (const p of [m.from, m.to]) freq.set(p, (freq.get(p) || 0) + 1);
  people = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  setMe(people[0]);
}

function setMe(name) {
  me = name;
  chats = new Map();
  for (const m of messages) {
    const other = m.from === me ? m.to : m.to === me ? m.from : m.to;
    if (!chats.has(other)) chats.set(other, []);
    chats.get(other).push(m);
  }
  $("#meName").textContent = me;
  current = null;
  renderContacts();
  renderEmpty();
}

// ---------- rendering ----------
const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const colors = ["#c0392b", "#8e44ad", "#2980b9", "#16a085", "#d35400", "#27ae60", "#7f8c8d", "#b8860b"];
const colorOf = s => colors[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
const fmtDay = d => d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const fmtTime = d => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const fmtShort = d => d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });

function rich(text, q) {
  // Steam BBCode → readable markup
  let s = esc(text);
  s = s.replace(/\[emoticon\](.*?)\[\/emoticon\]/gi, '<span class="emo">:$1:</span>');
  s = s.replace(/\[sticker type=&quot;?([^\]&]*?)&quot;?[^\]]*\](?:\[\/sticker\])?/gi, '<span class="sticker">[стикер: $1]</span>');
  s = s.replace(/\[url=([^\]]+)\](.*?)\[\/url\]/gi, (_, u, t) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\[img\](.*?)\[\/img\]/gi, '<a href="$1" target="_blank" rel="noopener noreferrer">[картинка]</a>');
  s = s.replace(/\[\/?(b|i|u|spoiler|quote[^\]]*|code|lobbyinvite[^\]]*|gameinvite[^\]]*|tradeoffer[^\]]*)\]/gi, "");
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  if (q) {
    const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?![^<]*>)", "gi");
    s = s.replace(re, "<mark>$1</mark>");
  }
  return s;
}

const plain = text => text
  .replace(/\[emoticon\](.*?)\[\/emoticon\]/gi, ":$1:")
  .replace(/\[sticker type="?([^\]"]*)"?[^\]]*\](?:\[\/sticker\])?/gi, "[стикер]")
  .replace(/\[img\].*?\[\/img\]/gi, "[картинка]")
  .replace(/\[\/?[a-z]+(=[^\]]*)?[^\]]*\]/gi, "");

function renderContacts() {
  const q = $("#contactSearch").value.trim().toLowerCase();
  const list = [...chats.entries()]
    .filter(([n]) => !q || n.toLowerCase().includes(q))
    .sort((a, b) => {
      const la = a[1][a[1].length - 1], lb = b[1][b[1].length - 1];
      return (lb.date && la.date) ? lb.date - la.date : b[1].length - a[1].length;
    });
  $("#contacts").innerHTML = list.map(([name, ms]) => {
    const last = ms[ms.length - 1];
    return `<div class="contact ${name === current ? "active" : ""}" data-name="${esc(name)}">
      <div class="ava" style="background:${colorOf(name)}">${esc([...name][0] || "?").toUpperCase()}</div>
      <div style="min-width:0"><div class="name">${esc(name)}</div>
        <div class="preview">${last.from === me ? "Вы: " : ""}${esc(plain(last.text).slice(0, 80))}</div></div>
      <div class="meta">${last.date ? fmtShort(last.date) : ""}<br><span class="badge">${ms.length}</span></div>
    </div>`;
  }).join("") || '<div class="empty" style="margin-top:20px">Никого не найдено</div>';
}

function renderEmpty() {
  $("#chatName").textContent = "Выберите чат";
  $("#chatInfo").textContent = `${messages.length} сообщений · ${chats.size} собеседников`;
  $("#messages").innerHTML = '<div class="empty">Выберите собеседника слева</div>';
  $("#viewer").classList.remove("chat-open");
}

function openChat(name, focusMsg) {
  current = name;
  $("#viewer").classList.add("chat-open");
  renderContacts();
  renderChat(focusMsg);
}

function renderChat(focusMsg) {
  const ms = chats.get(current) || [];
  const q = $("#chatSearch").value.trim();
  const shown = q ? ms.filter(m => m.text.toLowerCase().includes(q.toLowerCase())) : ms;
  const first = ms.find(m => m.date), last = [...ms].reverse().find(m => m.date);
  $("#chatName").textContent = current;
  $("#chatInfo").textContent = `${ms.length} сообщений` +
    (first ? ` · ${fmtDay(first.date)} — ${fmtDay(last.date)}` : "") +
    (q ? ` · найдено: ${shown.length}` : "");

  const parts = [];
  let day = null;
  for (const m of shown) {
    const d = m.date ? m.date.toDateString() : null;
    if (d && d !== day) { day = d; parts.push(`<div class="day"><span>${fmtDay(m.date)}</span></div>`); }
    const mine = m.from === me;
    const who = !mine && m.from !== current ? `<div class="who">${esc(m.from)}</div>` : "";
    parts.push(`<div class="msg ${mine ? "mine" : ""}" data-i="${messages.indexOf(m)}"><div class="bubble">${who}${rich(m.text, q)}<time>${m.date ? fmtTime(m.date) : esc(m.raw)}</time></div></div>`);
  }
  const box = $("#messages");
  box.innerHTML = parts.join("") || '<div class="empty">Ничего не найдено</div>';
  if (focusMsg) {
    const el = box.querySelector(`[data-i="${messages.indexOf(focusMsg)}"]`);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); }
  } else box.scrollTop = box.scrollHeight;
}

function renderGlobalResults(q) {
  const ql = q.toLowerCase();
  const hits = messages.filter(m => m.text.toLowerCase().includes(ql)).slice(-500).reverse();
  $("#contacts").innerHTML = `<div class="result r-head" style="cursor:default">Найдено: ${hits.length}${hits.length === 500 ? "+" : ""}</div>` +
    hits.map(m => {
      const other = m.from === me ? m.to : m.from;
      return `<div class="result" data-i="${messages.indexOf(m)}">
        <div class="r-head">${esc(other)} · ${m.date ? fmtShort(m.date) + " " + fmtTime(m.date) : esc(m.raw)}</div>
        <div>${m.from === me ? "Вы: " : ""}${rich(m.text.slice(0, 200), q)}</div></div>`;
    }).join("");
}

// ---------- bookmarklet ----------
// Runs on the Steam account-data page: presses "Load more" until the whole
// history is loaded, then downloads only the tables (no page scripts or session data).
function steamChatExport() {
  if (window.__steamChatExport) return;
  window.__steamChatExport = true;
  const MORE = /загрузить ещё|загрузить еще|показать ещё|показать еще|load more|show more/i;
  const rowCount = () => document.querySelectorAll("table tr").length;
  const moreButton = () => [...document.querySelectorAll("a, button, input[type=button], [onclick], [role=button]")]
    .find(el => el.offsetParent !== null && MORE.test(el.value || el.textContent || ""));

  if (!document.querySelector("table")) {
    alert("Таблица сообщений не найдена. Откройте страницу «Журнал сообщений» на help.steampowered.com и войдите в аккаунт.");
    window.__steamChatExport = false;
    return;
  }
  const status = document.createElement("div");
  status.style.cssText = "position:fixed;top:12px;right:12px;z-index:99999;background:#1b2838;color:#fff;padding:12px 16px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 16px #0008";
  document.body.appendChild(status);

  let lastCount = -1, idle = 0;
  const finish = note => {
    const tables = [...document.querySelectorAll("table")].map(t => t.outerHTML).join("\n");
    const html = `<!doctype html><meta charset="utf-8"><title>Steam chat export</title>\n${tables}`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    a.download = `steam-chat-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    status.textContent = `Готово: ${rowCount()} строк сохранено.` + (note ? " " + note : "");
    setTimeout(() => status.remove(), 8000);
    window.__steamChatExport = false;
  };
  const tick = () => {
    const n = rowCount();
    if (n !== lastCount) { lastCount = n; idle = 0; } else idle++;
    const btn = moreButton();
    status.textContent = `Загружаю историю… строк: ${n}`;
    if (!btn) return idle >= 3 ? finish() : setTimeout(tick, 700);
    if (idle === 0 || idle % 15 === 0) btn.click();   // click once per new page, retry if stuck
    if (idle > 60) return finish("(Steam перестал отвечать — история может быть неполной, попробуйте ещё раз позже.)");
    setTimeout(tick, 700);
  };
  tick();
}
$("#bookmarklet").href = "javascript:(" + encodeURIComponent(steamChatExport.toString()) + ")()";
$("#bookmarklet").onclick = e => { e.preventDefault(); alert("Перетащите эту кнопку на панель закладок, а нажимайте её на странице Steam."); };

// ---------- events ----------
async function load(sources) {
  const list = extract(sources);
  if (!list.length) {
    $("#importMsg").textContent = "Не нашёл сообщений. Убедитесь, что сохранили именно страницу «Журнал сообщений» (Ctrl+S → «только HTML»).";
    return;
  }
  build(list);
  $("#import").style.display = "none";
  $("#viewer").classList.add("on");
}

async function readFiles(files) {
  const texts = await Promise.all([...files].map(f => f.text()));
  load(texts);
}

$("#pick").onclick = () => $("#file").click();
$("#file").onchange = e => readFiles(e.target.files);
const drop = $("#drop");
["dragenter", "dragover"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
document.addEventListener("drop", e => { if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
$("#pasteGo").onclick = () => load([$("#paste").value]);
document.addEventListener("paste", e => {
  if ($("#import").style.display === "none" || e.target === $("#paste")) return;
  const html = e.clipboardData.getData("text/html") || e.clipboardData.getData("text/plain");
  if (html) load([html]);
});

$("#contacts").onclick = e => {
  const c = e.target.closest(".contact");
  if (c) return openChat(c.dataset.name);
  const r = e.target.closest(".result");
  if (r) {
    const m = messages[+r.dataset.i];
    const other = m.from === me ? m.to : m.from;
    $("#chatSearch").value = "";
    current = other;
    $("#viewer").classList.add("chat-open");
    renderChat(m);
  }
};
$("#contactSearch").oninput = () => { $("#globalSearch").value = ""; renderContacts(); };
$("#globalSearch").oninput = e => { const q = e.target.value.trim(); q.length >= 2 ? renderGlobalResults(q) : renderContacts(); };
$("#chatSearch").oninput = () => current && renderChat();
$("#back").onclick = () => { current = null; renderContacts(); renderEmpty(); };
$("#reload").onclick = () => location.reload();
$("#swapMe").onclick = () => {
  const i = people.indexOf(me);
  const options = people.slice(0, 15).map((p, k) => `${k + 1}. ${p}`).join("\n");
  const ans = prompt("Кто из участников — вы? Введите номер:\n\n" + options, String(i + 1));
  const n = parseInt(ans, 10);
  if (n >= 1 && n <= people.length) setMe(people[n - 1]);
};
$("#exportTxt").onclick = () => {
  if (!current) return;
  const lines = chats.get(current).map(m => `[${m.date ? m.date.toLocaleString("ru-RU") : m.raw}] ${m.from}: ${m.text}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
  a.download = `steam-chat-${current.replace(/[\\/:*?"<>|]/g, "_")}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
};
