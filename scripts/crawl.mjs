// Fetches this week's and next week's Alameda schedules from Fénix and writes
// them to public/data/<monday>.json for the static site.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { ALAMEDA, crawlTree, fetchWeek, classify, mondayOf, addDays, lisbonToday } from "../lib/fenix.mjs";

const OUT = new URL("../public/data/", import.meta.url);
const META = new URL("../data/rooms.json", import.meta.url);

// Remembered between runs so later runs only fetch rooms that can matter.
const meta = JSON.parse(await readFile(META, "utf8").catch(() => "{}"));

const tree = await crawlTree(ALAMEDA);
console.log(`tree: ${tree.length} rooms`);

const thisWeek = mondayOf(lisbonToday());
const fullScan = process.env.FULL_SCAN === "1" || new Date().getUTCHours() === 5;
for (const monday of [thisWeek, addDays(thisWeek, 7)]) {
  const targets = tree.filter(r => (fullScan && monday === thisWeek) || !meta[r.id] ||
    meta[r.id].capacity > 0 || meta[r.id].teaching || classify({ ...r, ...meta[r.id] }));
  const { events, capacity, failed } = await fetchWeek(targets, monday);
  for (const [id, cap] of Object.entries(capacity)) meta[id] = { ...meta[id], capacity: cap };
  for (const [id, evs] of Object.entries(events)) {
    if (evs.some(e => e.type === "LESSON" || e.type === "TEST")) meta[id].teaching = true;
  }

  const rooms = [];
  for (const r of tree) {
    const kind = classify({ ...r, ...meta[r.id] });
    if (!kind || !events[r.id]) continue;
    rooms.push({
      id: r.id, name: r.name, building: r.building, floor: r.floor,
      capacity: meta[r.id].capacity ?? 0, kind,
      events: events[r.id].sort((a, b) => a.date.localeCompare(b.date) || a.s - b.s),
    });
  }
  rooms.sort((a, b) => a.id.localeCompare(b.id));

  const file = new URL(`${monday}.json`, OUT);
  const body = JSON.stringify({ week: monday, rooms });
  const old = await readFile(file, "utf8").catch(() => "");
  if (old !== body) {
    await mkdir(OUT, { recursive: true });
    await writeFile(file, body);
  }
  console.log(`week ${monday}: ${rooms.length} rooms, ${failed} fetches failed, ${old === body ? "unchanged" : "updated"}`);
}

const sorted = Object.fromEntries(Object.entries(meta).sort(([a], [b]) => a.localeCompare(b)));
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(META, JSON.stringify(sorted, null, 0) + "\n");

const keepFrom = addDays(thisWeek, -7);
for (const name of await readdir(OUT)) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] < keepFrom) await unlink(new URL(name, OUT));
}
