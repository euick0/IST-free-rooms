// Local preview of the static site. Run `npm run crawl` first to fetch schedules.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT) || 3000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const file = path.join(PUBLIC, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
  const body = file.startsWith(PUBLIC + path.sep) ? await readFile(file).catch(() => null) : null;
  if (!body) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("Not found");
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(body);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
