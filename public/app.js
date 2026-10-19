const $ = id => document.getElementById(id);
const PREFS_KEY = "ist-free-rooms:prefs";
const KIND_ORDER = ["class", "study", "other"];
const KIND_NOTE = { study: "Study room", other: "Lab or other room, often locked" };
const EVENT_NAME = { LESSON: "class", TEST: "test", GENERIC: "booking" };

const pad = n => String(n).padStart(2, "0");
const toTime = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function length(m) {
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r}<small>min</small>`;
  return `${h}<small>h</small>${r ? pad(r) : ""}`;
}
const lengthText = m => (m < 60 ? `${m} minutes` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim());

function lisbonNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Math.floor((+p.hour * 60 + +p.minute) / 5) * 5 };
}
function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const asDate = iso => new Date(iso + "T12:00:00Z");
const isWeekend = iso => [0, 6].includes(asDate(iso).getUTCDay());
const fmtDay = (iso, opts) => asDate(iso).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; }
}
function savePrefs() {
  const { until, sort, building, minCap, kinds } = state;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ until: toTime(until), sort, building, minCap, kinds: [...kinds] })); } catch {}
}

const prefs = loadPrefs();
const state = {
  date: "", from: 0,
  until: /^\d\d:\d\d$/.test(prefs.until) ? toMin(prefs.until) : 20 * 60,
  sort: prefs.sort === "longest" ? "longest" : "now",
  building: prefs.building || "",
  minCap: Number(prefs.minCap) || 0,
  kinds: new Set(prefs.kinds || ["class", "study"]),
  q: "",
  followNow: false,
  open: new Set(),
};

const weeks = new Map();
let data = null;
let loadError = null;

const mondayOf = iso => addDays(iso, -((asDate(iso).getUTCDay() + 6) % 7));

async function load(date, force) {
  const monday = mondayOf(date);
  if (force || !weeks.has(monday)) {
    const res = await fetch(`/data/${monday}.json`, { cache: "no-cache" });
    if (res.status === 404) throw new Error("There are no schedules for that week yet. Only this week and next week are available.");
    if (!res.ok) throw new Error(`Loading the schedules failed (error ${res.status}). Try again in a minute.`);
    weeks.set(monday, await res.json());
  }
  return { rooms: weeks.get(monday).rooms.map(r => ({ ...r, events: r.events.filter(e => e.date === date) })) };
}

function teachingDays() {
  const now = lisbonNow();
  let d = now.date;
  if (isWeekend(d) || now.min >= state.until) d = addDays(d, 1);
  const days = [];
  for (; days.length < 5; d = addDays(d, 1)) if (!isWeekend(d)) days.push(d);
  return days;
}
function dayLabel(iso) {
  const today = lisbonNow().date;
  if (iso === today) return "Today";
  if (iso === addDays(today, 1)) return "Tomorrow";
  return fmtDay(iso, { weekday: "short", day: "numeric" });
}

function analyze(room, from, until) {
  const busy = room.events
    .map(e => [Math.max(e.s, from), Math.min(e.e, until)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const gaps = [];
  let cursor = from;
  for (const [a, b] of busy) {
    if (a > cursor) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (until > cursor) gaps.push([cursor, until]);
  return {
    nowGap: gaps[0]?.[0] === from ? gaps[0] : null,
    best: gaps.reduce((m, g) => (!m || g[1] - g[0] > m[1] - m[0] ? g : m), null),
  };
}

function range() {
  const start = Math.min(8 * 60, Math.floor(state.from / 60) * 60);
  const end = Math.max(20 * 60, Math.ceil(state.until / 60) * 60);
  return [start, end];
}

function bar(room, gap, nowMin) {
  const [start, end] = range();
  const pos = m => ((Math.min(Math.max(m, start), end) - start) / (end - start)) * 100;
  const seg = (a, b) => `left:${pos(a)}%;width:${pos(b) - pos(a)}%`;
  const busy = room.events.filter(e => e.e > start && e.s < end)
    .map(e => `<i class="busy" style="${seg(e.s, e.e)}"></i>`).join("");
  const now = nowMin != null && nowMin > start && nowMin < end ? `<i class="now" style="left:${pos(nowMin)}%"></i>` : "";
  return `<span class="bar"><i class="free" style="${seg(gap[0], gap[1])}"></i>${busy}${now}</span>`;
}

function axis() {
  const [start, end] = range();
  const marks = [];
  for (let h = Math.ceil(start / 60); h * 60 <= end; h += 2) {
    const left = ((h * 60 - start) / (end - start)) * 100;
    marks.push(`<span style="left:${left}%">${h}</span>`);
  }
  $("axis").innerHTML = marks.join("");
}

function eventLine(e) {
  return `<li><time>${toTime(e.s)}–${toTime(e.e)}</time><b>${e.type === "LESSON" ? esc(e.tag) : esc(EVENT_NAME[e.type] ?? "Booking")}</b><span>${esc(e.title)}</span></li>`;
}

function nextNote(room, gap) {
  const next = room.events.filter(e => e.s >= gap[1]).sort((a, b) => a.s - b.s)[0];
  if (!next) return "Nothing else is booked today.";
  const what = next.type === "LESSON" ? `${next.tag || "A"} class` : `A ${EVENT_NAME[next.type] ?? "booking"}`;
  return `${what} starts at ${toTime(next.s)}.`;
}

function renderControls() {
  const days = teachingDays();
  if (state.date && !days.includes(state.date)) days.push(state.date);
  $("days").innerHTML = days.map(d =>
    `<button type="button" data-date="${d}" aria-pressed="${d === state.date}">${dayLabel(d)}</button>`).join("") +
    `<label class="pick" title="Pick another date"><span>Other</span><input type="date" id="date" value="${state.date}" min="${mondayOf(lisbonNow().date)}" max="${addDays(mondayOf(lisbonNow().date), 13)}"></label>`;
  $("from").value = toTime(state.from);
  $("until").value = toTime(state.until);
  for (const b of $("sort").children) b.setAttribute("aria-pressed", b.dataset.value === state.sort);
  for (const b of $("seats").children) b.setAttribute("aria-pressed", Number(b.dataset.value) === state.minCap);
  for (const k of KIND_ORDER) $(`kind-${k}`).checked = state.kinds.has(k);
  const changed = (state.minCap ? 1 : 0) + (state.until !== 20 * 60 ? 1 : 0) +
    (state.kinds.size !== 2 || !state.kinds.has("class") || !state.kinds.has("study") ? 1 : 0);
  $("filterCount").textContent = changed ? `(${changed} on)` : "";
  const now = lisbonNow();
  $("now").hidden = isWeekend(now.date) || now.min >= state.until;
  $("now").setAttribute("aria-pressed", state.followNow);
  $("earlier").disabled = state.from <= 0;
  $("later").disabled = state.from >= 23 * 60 + 30;
}

function renderBuildings(counts, total) {
  const names = [...new Set(data.rooms.map(r => r.building))].sort((a, b) => a.localeCompare(b, "pt"));
  if (state.building && !names.includes(state.building)) state.building = "";
  const option = (value, label, n) => `<button type="button" role="option" data-building="${esc(value)}"
      aria-selected="${state.building === value}"${n ? "" : ' class="none"'}>
      <span>${esc(label)}</span><span class="n">${n ? `${n} free` : "none free"}</span></button>`;
  if (!$("buildingList").matches(":popover-open")) {
    $("buildingOptions").innerHTML = option("", "All buildings", total) +
      names.map(n => option(n, n, counts.get(n) ?? 0)).join("");
  }
  $("buildingName").textContent = state.building || "All buildings";
  const shown = state.building ? counts.get(state.building) ?? 0 : total;
  $("buildingCount").textContent = `${shown} free`;
  $("sheetHint").textContent = state.sort === "now" ? `rooms free at ${toTime(state.from)}` : "rooms with free time";
}

function showEmpty(html) {
  $("empty").innerHTML = html;
  $("empty").hidden = !html;
}

function render() {
  renderControls();
  axis();
  const relative = dayLabel(state.date);
  const fullDay = fmtDay(state.date, { weekday: "long", day: "numeric", month: "long" });
  const dayText = ["Today", "Tomorrow"].includes(relative) ? `${relative}, ${fullDay}` : fullDay;

  if (loadError) {
    $("headline").textContent = "Couldn't load schedules";
    $("sub").textContent = loadError;
    $("rooms").innerHTML = "";
    showEmpty(`<button type="button" class="primary" data-action="retry">Try again</button>`);
    return;
  }
  if (!data) {
    $("headline").textContent = "Loading schedules…";
    $("sub").textContent = dayText;
    $("rooms").innerHTML = "";
    showEmpty("");
    return;
  }
  if (state.until <= state.from) {
    $("headline").textContent = "Nothing to show";
    $("sub").textContent = `Your start time is after ${toTime(state.until)}, the time free stretches are counted until. Change either one.`;
    $("rooms").innerHTML = "";
    showEmpty(`<button type="button" class="primary" data-action="open-filters">Change end time</button>`);
    return;
  }

  const q = state.q.trim().toLowerCase();
  const today = lisbonNow();
  const nowMin = state.date === today.date ? today.min : null;
  const pool = data.rooms.filter(r =>
    r.capacity >= state.minCap &&
    (!q || `${r.name} ${r.building}`.toLowerCase().includes(q)));

  let busy = 0, total = 0;
  const counts = new Map();
  const kindCounts = { class: 0, study: 0, other: 0 };
  const ranked = [];
  for (const room of pool) {
    const { nowGap, best } = analyze(room, state.from, state.until);
    const gap = state.sort === "now" ? nowGap : best;
    if (gap && (!state.building || room.building === state.building)) kindCounts[room.kind]++;
    if (!state.kinds.has(room.kind)) continue;
    if (gap) {
      total++;
      counts.set(room.building, (counts.get(room.building) ?? 0) + 1);
    }
    if (state.building && room.building !== state.building) continue;
    if (!nowGap) busy++;
    if (gap) ranked.push({ room, gap, len: gap[1] - gap[0] });
  }
  renderBuildings(counts, total);
  for (const k of KIND_ORDER) $(`n-${k}`).textContent = `${kindCounts[k]} free`;
  ranked.sort((a, b) =>
    b.len - a.len || a.gap[0] - b.gap[0] ||
    KIND_ORDER.indexOf(a.room.kind) - KIND_ORDER.indexOf(b.room.kind) ||
    b.room.capacity - a.room.capacity || a.room.name.localeCompare(b.room.name));

  const n = ranked.length;
  const rooms = `${n} room${n === 1 ? "" : "s"}`;
  const at = state.followNow ? "right now" : `at ${toTime(state.from)}`;
  $("headline").textContent = state.sort === "now"
    ? (n ? `${rooms} free ${at}` : `No rooms free ${at}`)
    : (n ? `${rooms} with free time` : "No free time left");
  let sub = state.sort === "longest" ? `${dayText}, between ${toTime(state.from)} and ${toTime(state.until)}.` : `${dayText}.`;
  if (state.sort === "now" && busy && n) sub += ` ${busy} more room${busy === 1 ? " is" : "s are"} busy ${at}.`;
  $("sub").textContent = sub;

  $("rooms").innerHTML = ranked.map(({ room, gap, len }) => {
    const open = state.open.has(room.id);
    const span = gap[0] > state.from ? `${toTime(gap[0])} to ${toTime(gap[1])}` : `until ${toTime(gap[1])}`;
    const floor = room.floor.split(" / ")[0];
    const where = floor ? `${room.building}, floor ${floor}` : room.building;
    const facts = [room.capacity ? `${room.capacity} seats.` : "", KIND_NOTE[room.kind] ? `${KIND_NOTE[room.kind]}.` : "",
      room.events.length ? nextNote(room, gap) : "Nothing is booked here all day."].filter(Boolean).join(" ");
    const schedule = room.events.length
      ? `<ul class="schedule">${room.events.slice().sort((a, b) => a.s - b.s).map(eventLine).join("")}</ul>`
      : "";
    return `<li class="room${room.name.length > 9 ? " long" : ""}">
      <button type="button" class="row" data-id="${room.id}" aria-expanded="${open}" aria-controls="d-${room.id}"
        aria-label="${esc(room.name)}, ${esc(where)}. Free for ${lengthText(len)}, ${span}.">
        <span class="code">${esc(room.name)}</span>
        <span class="len">${length(len)}</span>
        <span class="where">${esc(where)}</span>
        <span class="span">${span}</span>
        ${bar(room, gap, nowMin)}
      </button>
      <div class="detail" id="d-${room.id}"${open ? "" : " hidden"}>
        <p class="facts">${esc(facts)}</p>
        ${schedule}
      </div>
    </li>`;
  }).join("");

  const filtered = state.building || state.minCap || q || state.kinds.size < 2;
  if (n) showEmpty("");
  else if (state.sort === "now" && busy) showEmpty(`<p>Every matching room has something booked ${at}.</p><button type="button" class="primary" data-action="longest">Show rooms that free up later</button>`);
  else if (filtered) showEmpty(`<p>No rooms match these filters.</p><button type="button" class="primary" data-action="clear">Clear filters</button>`);
  else showEmpty(`<p>Every room is booked until ${toTime(state.until)}.</p><button type="button" class="primary" data-action="open-filters">Count later than ${toTime(state.until)}</button>`);
}

async function show(date, force = false) {
  if (state.date !== date) data = null;
  state.date = date;
  loadError = null;
  render();
  try {
    data = await load(date, force);
  } catch (err) {
    if (!data) loadError = err.message;
  }
  if (state.date === date) render();
}

function useNow() {
  const now = lisbonNow();
  const afterHours = isWeekend(now.date) || now.min >= state.until;
  state.followNow = !afterHours;
  state.from = afterHours ? 8 * 60 : now.min;
  return afterHours ? teachingDays()[0] : now.date;
}

function wire() {
  $("controls").addEventListener("submit", e => e.preventDefault());

  $("days").addEventListener("click", e => {
    const b = e.target.closest("button[data-date]");
    if (!b) return;
    pickDate(b.dataset.date);
  });
  $("days").addEventListener("change", e => {
    if (e.target.id === "date" && e.target.value) pickDate(e.target.value);
  });

  $("from").addEventListener("input", e => {
    if (!e.target.value) return;
    state.from = toMin(e.target.value);
    state.followNow = false;
    render();
  });
  $("now").addEventListener("click", () => { const d = useNow(); d === state.date ? render() : show(d); });
  const step = dir => {
    const snapped = Math.floor(state.from / 30) * 30;
    const next = dir < 0 ? (snapped < state.from ? snapped : snapped - 30) : snapped + 30;
    state.from = Math.min(Math.max(next, 0), 23 * 60 + 30);
    state.followNow = false;
    render();
  };
  $("earlier").addEventListener("click", () => step(-1));
  $("later").addEventListener("click", () => step(1));

  const sheet = $("buildingList");
  const wide = matchMedia("(min-width: 920px)");
  sheet.addEventListener("beforetoggle", e => {
    if (e.newState !== "open") return;
    if (wide.matches) {
      const r = $("buildingBtn").getBoundingClientRect();
      const below = innerHeight - r.bottom - 16;
      const above = r.top - 16;
      const down = below >= 280 || below >= above;
      sheet.removeAttribute("style");
      Object.assign(sheet.style, {
        left: `${r.left}px`,
        width: `${Math.max(r.width, 300)}px`,
        maxHeight: `${Math.min(460, down ? below : above)}px`,
        ...(down ? { top: `${r.bottom + 6}px` } : { bottom: `${innerHeight - r.top + 6}px` }),
      });
    } else {
      sheet.removeAttribute("style");
    }
  });
  sheet.addEventListener("toggle", e => {
    if (e.newState === "open") sheet.querySelector('[aria-selected="true"]')?.focus();
  });
  $("buildingOptions").addEventListener("click", e => {
    const opt = e.target.closest("[role=option]"); if (!opt) return;
    state.building = opt.dataset.building;
    savePrefs();
    sheet.hidePopover();
    $("buildingBtn").focus();
    render();
  });
  $("buildingOptions").addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const opts = [...$("buildingOptions").children];
    const i = opts.indexOf(document.activeElement);
    opts[Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), opts.length - 1)].focus();
  });
  addEventListener("resize", () => sheet.matches(":popover-open") && sheet.hidePopover());

  $("until").addEventListener("input", e => {
    if (!e.target.value) return;
    state.until = toMin(e.target.value);
    savePrefs(); render();
  });
  $("sort").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    state.sort = b.dataset.value; savePrefs(); render();
  });
  $("seats").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    state.minCap = Number(b.dataset.value); savePrefs(); render();
  });
  for (const k of KIND_ORDER) {
    $(`kind-${k}`).addEventListener("change", e => {
      e.target.checked ? state.kinds.add(k) : state.kinds.delete(k);
      savePrefs(); render();
    });
  }
  $("q").addEventListener("input", e => { state.q = e.target.value; render(); });

  $("rooms").addEventListener("click", e => {
    const row = e.target.closest(".row"); if (!row) return;
    const id = row.dataset.id;
    const open = !state.open.has(id);
    open ? state.open.add(id) : state.open.delete(id);
    row.setAttribute("aria-expanded", open);
    $(`d-${id}`).hidden = !open;
  });

  $("empty").addEventListener("click", e => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "retry") show(state.date, true);
    if (action === "longest") { state.sort = "longest"; savePrefs(); render(); }
    if (action === "clear") {
      Object.assign(state, { building: "", minCap: 0, q: "", kinds: new Set(["class", "study"]) });
      $("q").value = "";
      savePrefs(); render();
    }
    if (action === "open-filters") { $("more").open = true; $("until").focus(); }
  });
}

function pickDate(date) {
  const wasNow = state.followNow;
  if (date === lisbonNow().date) useNow();
  else {
    state.followNow = false;
    if (wasNow) state.from = 8 * 60;
  }
  show(date);
}

wire();
show(useNow());

setInterval(() => {
  if (state.followNow && state.date === lisbonNow().date) state.from = lisbonNow().min;
  if (data) render();
}, 60e3);
setInterval(() => show(state.date, true), 10 * 60e3);
