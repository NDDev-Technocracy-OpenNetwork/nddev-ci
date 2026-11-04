import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const port = Number(process.env.NDDEV_WEB_PORT);
if (!Number.isInteger(port) || port < 1)
  throw new Error("Explicit owned test port required");
createServer(async (req, res) => {
  const name =
    req.url === "/"
      ? "index.html"
      : req.url === "/style.css"
        ? "style.css"
        : null;
  if (!name) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    "Content-Type",
    name.endsWith(".css") ? "text/css" : "text/html",
  );
  res.end(await readFile(new URL(name, import.meta.url)));
}).listen(port, "127.0.0.1");
