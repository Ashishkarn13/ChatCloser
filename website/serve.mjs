// Tiny zero-dependency static server for the website folder.
// Usage: node website/serve.mjs [port]
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

http
  .createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.endsWith("/")) path += "index.html";
      if (!path.startsWith("/") || path.includes("..")) throw new Error("bad path");
      const file = await readFile(join(root, "." + path));
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(file);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`website ready at http://127.0.0.1:${port}`));
