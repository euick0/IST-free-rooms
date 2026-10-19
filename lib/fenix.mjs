const API = "https://fenix.tecnico.ulisboa.pt/api/fenix/v1/spaces";
export const ALAMEDA = "2448131360897";

async function get(id, day) {
  const url = `${API}/${id}${day ? `?day=${day}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function crawlTree(campusId) {
  const rooms = [];
  async function walk(id, path) {
    const space = await get(id);
    await Promise.all((space.containedSpaces || []).map(c => {
      const name = (c.name || "").trim();
      if (c.type === "ROOM") rooms.push({ id: c.id, name, path });
      else return walk(c.id, [...path, name]);
    }));
  }
  await walk(campusId, []);
  return rooms.map(r => ({
    id: r.id,
    name: r.name,
    building: r.path[0] ?? r.name,
    floor: r.path.slice(1).join(" / "),
  }));
}

const STUDY_ROOM = /sala de estudo|d[úu]vidas/i;
const LIBRARY = /biblioteca|sala de leitura/i;
const LIBRARY_ADMIN = /secret|circula|fotocop|sa[íi]da|arq|control|catalog|expositor|reuni|bastidor|lab/i;
const NOT_ROOM = /gabinete|\bgab\.|reuni|i\.s\.|sanit|arrecada|secretaria|corredor|\bwc\b|admiss|seguran|n[úu]cleo|m[áa]quinas|copa|\bbar\b|arquivo|vesti|sal[ãa]o nobre/i;
const STUDENT_GROUP = /^N[A-Z]{2,}$/;

export function classify(room) {
  const { name, capacity = 0 } = room;
  if (!name) return null;
  if (!LIBRARY_ADMIN.test(name) && (STUDY_ROOM.test(name) || (LIBRARY.test(name) && capacity > 0))) return "study";
  if (room.teaching) return "class";
  if (capacity >= 10 && !NOT_ROOM.test(name) && !STUDENT_GROUP.test(name)) return "other";
  return null;
}

export const lisbonToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function mondayOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(iso, -((dow + 6) % 7));
}

function parseStamp(stamp) {
  const [date, time] = stamp.trim().split(" ");
  const [dd, mm, yyyy] = date.split("/");
  const [h, min] = time.split(":").map(Number);
  return { date: `${yyyy}-${mm}-${dd}`, min: h * 60 + min };
}

function normalizeEvent(e) {
  const period = e.period ?? { start: `${e.day} ${e.start}`, end: `${e.day} ${e.end}` };
  const a = parseStamp(period.start);
  const b = parseStamp(period.end);
  const info = {
    type: e.type,
    title: e.course?.name ?? e.title ?? e.description ?? e.type,
    tag: e.course ? [e.course.acronym, e.info].filter(Boolean).join(" ") : "",
  };
  const out = [];
  for (let date = a.date; date <= b.date && out.length < 31; date = addDays(date, 1)) {
    const s = date === a.date ? a.min : 0;
    const end = date === b.date ? b.min : 1440;
    if (end > s) out.push({ date, s, e: end, ...info });
  }
  return out;
}

// Rooms whose fetch fails are left out of the result rather than shown as free.
export async function fetchWeek(rooms, monday) {
  const [y, m, d] = monday.split("-");
  const day = `${d}/${m}/${y}`;
  const events = {};
  const capacity = {};
  let failed = 0;
  await pool(rooms, 10, async r => {
    try {
      const space = await get(r.id, day);
      capacity[r.id] = space.capacity?.normal ?? 0;
      events[r.id] = (space.events || []).flatMap(normalizeEvent);
    } catch {
      failed++;
    }
  });
  if (failed > rooms.length * 0.1) throw new Error(`${failed}/${rooms.length} room fetches failed`);
  return { events, capacity, failed };
}
