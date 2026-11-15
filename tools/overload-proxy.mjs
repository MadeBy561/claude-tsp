// A test proxy in front of the Anthropic API: answers the first N model
// requests with 529 "overloaded", then passes everything through unchanged.
// usage: node overload-proxy.mjs PORT [N]   (point ANTHROPIC_BASE_URL at it)
import http from "node:http";
import https from "node:https";

let fails = Number(process.argv[3] ?? 2);
http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // Only the conversation's own request (it streams) is failed, so side requests do not use the failures up.
      if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens") && fails > 0 && body.includes('"stream":true')) {
        fails -= 1;
        res.writeHead(529, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      const upstream = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers: { ...req.headers, host: "api.anthropic.com" } }, reply => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", error => {
        res.writeHead(502);
        res.end(String(error));
      });
      upstream.end(body);
    });
  })
  .listen(Number(process.argv[2]), "127.0.0.1");
