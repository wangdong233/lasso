#!/usr/bin/env node
/** ft-round1 本地 HTTP 夹具：127.0.0.1:18191（SSRF 默认放行段——CDP 设计口）
 *  /big.txt 100KiB 文本（触发 fetch_url 48KiB envelope spill → @oN）
 *  /404 /500 /redir(302→/big.txt) /oversize（content-length > max_bytes 用）
 *  /slow（延时，超时测试可选）
 */
import * as http from "node:http";

const PORT = 18191;
// 100 KiB 可预测文本：每行 64 字节、带行号，便于断言 offset 对齐
const LINES = [];
for (let i = 0; i < 1600; i++) LINES.push(String(i).padStart(6, "0") + " x".repeat(56));
const BIG = LINES.join("\n"); // ~100 KiB

const server = http.createServer((req, res) => {
  const u = req.url ?? "/";
  if (u === "/big.txt") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(BIG);
  } else if (u === "/404") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found here");
  } else if (u === "/500") {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("server exploded");
  } else if (u === "/redir") {
    res.writeHead(302, { location: "/big.txt" });
    res.end();
  } else if (u === "/empty200") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end();
  } else {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ft-fixture root; BIG_BYTES=" + Buffer.byteLength(BIG));
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("ft-http-fixture listening on 127.0.0.1:" + PORT + " BIG_BYTES=" + Buffer.byteLength(BIG));
});
