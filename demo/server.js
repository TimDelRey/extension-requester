import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const html = await readFile(new URL("./index.html", import.meta.url));

export function createDemoServer() {
  const received = [];
  const navigations = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/received") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(received));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const result = {
      method: request.method, url: request.url, headers: request.headers,
      body: rawBody.toString("utf8"),
    };
    Object.defineProperty(result, "rawBody", { value: rawBody });
    if (url.pathname === "/redirect") {
      navigations.push(result);
      response.writeHead(302, { Location: `http://localhost:${server.address().port}/redirect-destination?from=302` });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-destination") {
      navigations.push(result);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result, null, 2));
      return;
    }
    received.push(result);
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result, null, 2));
  });
  return { server, received, navigations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createDemoServer();
  server.listen(8787, "127.0.0.1", () => console.log("Тестовая страница: http://127.0.0.1:8787"));
}
