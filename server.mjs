import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALAMEDA, crawlTree, fetchWeek, mondayOf, addDays } from "./lib/fenix.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CACHE = path.join(ROOT, "cache", "state.json");
const PORT = Number(process.env.PORT) || 3000;
const TREE_TTL = 24 * 3600e3;
const WEEK_TTL = 30 * 60e3;

const STUDY_ROOM = /sala de estudo|d[úu]vidas/i;
const LIBRARY = /biblioteca|sala de leitura/i;
const LIBRARY_ADMIN = /secret|circula|fotocop|sa[íi]da|arq|control|catalog|expositor|reuni|bastidor|lab/i;
const NOT_ROOM = /gabinete|\bgab\.|reuni|i\.s\.|sanit|arrecada|secretaria|corredor|\bwc\b|admiss|seguran|n[úu]cleo|m[áa]quinas|copa|\bbar\b|arquivo|vesti|sal[ãa]o nobre/i;
const STUDENT_GROUP = /^N[A-Z]{2,}$/;

function classify(room) {
  const { name, capacity = 0 } = room;
  if (!name) return null;
  if (!LIBRARY_ADMIN.test(name) && (STUDY_ROOM.test(name) || (LIBRARY.test(name) && capacity > 0))) return "study";
  if (room.teaching) return "class";
  if (capacity >= 10 && !NOT_ROOM.test(name) && !STUDENT_GROUP.test(name)) return "other";
  return null;
}

const lisbonToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());

let state = { treeAt: 0, rooms: {}, weeks: {} };
try {
  state = JSON.parse(await readFile(CACHE, "utf8"));
} catch {}

async function save() {
  const keep = mondayOf(addDays(lisbonToday(), -7));
  for (const monday of Object.keys(state.weeks)) if (monday < keep) delete state.weeks[monday];
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, JSON.stringify(state));
}

async function ensureTree() {
  if (Date.now() - state.treeAt < TREE_TTL) return;
  const list = await crawlTree(ALAMEDA);
  const rooms = {};
  for (const r of list) rooms[r.id] = { ...state.rooms[r.id], ...r };
  state.rooms = rooms;
  state.treeAt = Date.now();
  console.log(`tree: ${list.length} rooms`);
}

const inflight = new Map();
function loadWeek(monday) {
  if (inflight.has(monday)) return inflight.get(monday);
  const job = (async () => {
    const t = Date.now();
    await ensureTree();
    const targets = Object.values(state.rooms).filter(r => r.capacity === undefined || r.capacity > 0 || r.teaching);
    const { events, capacity, failed } = await fetchWeek(targets, monday);
    for (const [id, cap] of Object.entries(capacity)) state.rooms[id].capacity = cap;
    for (const [id, evs] of Object.entries(events)) {
      if (evs.some(e => e.type === "LESSON" || e.type === "TEST")) state.rooms[id].teaching = true;
    }
    state.weeks[monday] = { fetchedAt: Date.now(), events };
    await save();
    console.log(`week ${monday}: ${targets.length} rooms, ${failed} failed, ${Date.now() - t}ms`);
  })().finally(() => inflight.delete(monday));
  inflight.set(monday, job);
  return job;
}

async function getWeek(monday) {
  const week = state.weeks[monday];
  if (!week) {
    await loadWeek(monday);
    return state.weeks[monday];
  }
  if (Date.now() - week.fetchedAt > WEEK_TTL) {
    loadWeek(monday).catch(err => console.error(`refresh ${monday} failed:`, err.message));
  }
  return week;
}

async function roomsFor(date) {
  const week = await getWeek(mondayOf(date));
  const rooms = [];
  for (const r of Object.values(state.rooms)) {
    const kind = classify(r);
    const evs = week.events[r.id];
    if (!kind || !evs) continue;
    rooms.push({
      id: r.id,
      name: r.name,
      building: r.building,
      floor: r.floor,
      capacity: r.capacity ?? 0,
      kind,
      events: evs.filter(e => e.date === date).map(({ date: _, ...e }) => e),
    });
  }
  return { date, updatedAt: week.fetchedAt, rooms };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/rooms") {
      const date = url.searchParams.get("date") ?? lisbonToday();
      const today = lisbonToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < addDays(today, -7) || date > addDays(today, 60)) {
        return send(res, 400, { error: "date must be YYYY-MM-DD, within the last week or next 60 days" });
      }
      return send(res, 200, await roomsFor(date));
    }
    const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", "text/plain");
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, "Not found", "text/plain");
    send(res, 200, body, TYPES[path.extname(file)] ?? "application/octet-stream");
  } catch (err) {
    console.error(err);
    send(res, 502, { error: "Could not load data from Fénix. Try again in a moment." });
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
  loadWeek(mondayOf(lisbonToday())).catch(err => console.error("warm-up failed:", err.message));
});
