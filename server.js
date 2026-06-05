// ============================================================
// Node 反代煤炉 (Mercari) —— 零依赖单文件 (Node 18+，建议 20/24)
//   node server.js           # 默认 http://localhost:8787
// ============================================================
const http = require("http");
const tls = require("tls");
const { Readable } = require("stream");

const PORT = Number(process.env.PORT) || 8787;

// 默认上游（日本站 jp.mercari.com / 美区 www.mercari.com）
const DEFAULT_UPSTREAM = process.env.UPSTREAM || "jp.mercari.com";

// 需要代理的上游域名（按 hostname 匹配）；要加 CDN 就往这里加
const UPSTREAM_RE = /(^|\.)(mercari\.com|mercari\.jp|mercdn\.net|mercari-shops\.com)$/i;
const UPSTREAM_RE_SRC = "(^|\\.)(mercari\\.com|mercari\\.jp|mercdn\\.net|mercari-shops\\.com)$";

// 针对性 JS 文本替换：干掉硬编码 host 检查 / 强制跳转等。默认空，按需补。
// 例：{ from: `location.host!=="jp.mercari.com"`, to: "false" }
const JS_PATCHES = [];

// 转发时要丢掉的 hop-by-hop / 会干扰的头
const DROP_REQ_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection",
  "transfer-encoding", "upgrade", "accept-encoding", "content-length",
]);
const DROP_RESP_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

const handler = async (req, res) => {
  try {
    const PROXY_HOST = req.headers.host || `localhost:${PORT}`;
    const reqUrl = new URL(req.url, `http://${PROXY_HOST}`);

    // 1) CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }

    // 2) 解析上游目标
    const { upstreamHost, upstreamPath } = resolveTarget(reqUrl);
    const upstreamUrl = `https://${upstreamHost}${upstreamPath}${reqUrl.search}`;

    // 3) 组装转发请求头（DPoP / Authorization / Cookie 原样透传）
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (DROP_REQ_HEADERS.has(lk)) continue;
      // cf-* / x-forwarded-* / x-real-ip：放在 CDN 后面时会被注入，转发给同样在 CF
      // 后的 api.mercari.jp 会被当成伪造头 WAF 403。直接丢。
      if (lk.startsWith("cf-") || lk.startsWith("x-forwarded-") || lk === "x-real-ip") continue;
      fwd[k] = v;
    }
    // 关键：浏览器真实的 Origin/Referer 是「站点域名」(jp.mercari.com)，不是 api 域名。
    const SITE = `https://${DEFAULT_UPSTREAM}`;
    if (fwd["origin"]) fwd["origin"] = SITE;
    if (fwd["referer"]) {
      fwd["referer"] = fwd["referer"]
        .split(PROXY_HOST).join(DEFAULT_UPSTREAM)
        .replace(/\/__p\/[^/]+\//, "/");
    }

    // 4) body：非 GET/HEAD 时缓冲整包（API 都是小 JSON）
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const body = hasBody ? await readBody(req) : undefined;

    const resp = await fetch(upstreamUrl, {
      method: req.method,
      headers: fwd,
      body,
      redirect: "manual",
    });

    // 5) 处理响应头
    const outHeaders = {};
    for (const [k, v] of resp.headers) {
      if (k.toLowerCase() === "set-cookie") continue; // 单独处理
      if (DROP_RESP_HEADERS.has(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    stripSecurityHeaders(outHeaders);
    applyCors(outHeaders, req);
    const cookies = rewriteSetCookie(resp);
    if (cookies.length) outHeaders["set-cookie"] = cookies;
    rewriteLocation(outHeaders, upstreamHost, PROXY_HOST);

    const ctype = (resp.headers.get("content-type") || "").toLowerCase();

    // 6) HTML：注入运行时劫持脚本 + 改写绝对 URL 属性
    if (ctype.includes("text/html")) {
      let html = await resp.text();
      html = injectAndRewriteHtml(html, PROXY_HOST);
      res.writeHead(resp.status, outHeaders);
      return res.end(html);
    }

    // 7) JS：仅当配置了补丁时才改（默认不动，保住 DPoP htu）
    const isJs = ctype.includes("javascript") || new URL(upstreamUrl).pathname.endsWith(".js");
    if (JS_PATCHES.length && isJs) {
      let text = await resp.text();
      for (const p of JS_PATCHES) text = text.split(p.from).join(p.to);
      res.writeHead(resp.status, outHeaders);
      return res.end(text);
    }

    // 8) 其它原样透传（流式）
    res.writeHead(resp.status, outHeaders);
    if (resp.body) Readable.fromWeb(resp.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("proxy error: " + (e && e.message ? e.message : String(e)));
  }
};

// http 还是 https：设了 TLS_CERT/TLS_KEY 就走 https（局域网 IP / 域名访问必须走 https，
// 否则浏览器不是安全上下文，crypto.subtle 不可用 → Mercari 的 DPoP 签不出 → 商品刷不出）。
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const SCHEME = TLS_CERT && TLS_KEY ? "https" : "http";
let server;
if (SCHEME === "https") {
  const https = require("https");
  const fs = require("fs");
  server = https.createServer(
    { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
    handler
  );
} else {
  server = http.createServer(handler);
}

// ---------------- WebSocket 代理：/__pws__/<host>/<path> ----------------
server.on("upgrade", (req, clientSock, head) => {
  const m = req.url.match(/^\/__pws__\/([^/]+)(\/.*)?$/);
  if (!m) return clientSock.destroy();
  const host = m[1];
  const path = m[2] || "/"; // 含 query
  const upstream = tls.connect(443, host, { servername: host }, () => {
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`];
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === "host") continue;
      if (lk === "origin") { lines.push(`Origin: https://${DEFAULT_UPSTREAM}`); continue; }
      lines.push(`${k}: ${v}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    clientSock.pipe(upstream);
    upstream.pipe(clientSock);
  });
  upstream.on("error", () => clientSock.destroy());
  clientSock.on("error", () => upstream.destroy());
});

// ---------------- 路由 ----------------
// /__p/<host>/<path...> => https://<host>/<path...>；其它走默认上游
function resolveTarget(reqUrl) {
  const m = reqUrl.pathname.match(/^\/__p\/([^/]+)(\/.*)?$/);
  if (m) return { upstreamHost: m[1], upstreamPath: m[2] || "/" };
  return { upstreamHost: DEFAULT_UPSTREAM, upstreamPath: reqUrl.pathname };
}

function toProxyUrl(absUrl, proxyHost) {
  try {
    const u = new URL(absUrl);
    if (u.hostname === proxyHost) return absUrl;
    if (!UPSTREAM_RE.test(u.hostname)) return absUrl;
    // 用协议相对 //host/...，让浏览器按当前页面协议解析（https 页面→https，http→http），
    // 避免在 https 页面里改出 http 链接造成 mixed-content 被拦。
    return `//${proxyHost}/__p/${u.hostname}${u.pathname}${u.search}`;
  } catch {
    return absUrl;
  }
}

// ---------------- 头处理 ----------------
function stripSecurityHeaders(h) {
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if ([
      "content-security-policy", "content-security-policy-report-only", "x-frame-options",
      "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
      "report-to", "nel",
    ].includes(lk)) delete h[k];
  }
}

function corsHeaders(req) {
  return {
    "access-control-allow-origin": req.headers["origin"] || "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
    "access-control-allow-headers": req.headers["access-control-request-headers"] || "*",
    "access-control-max-age": "86400",
  };
}
function applyCors(h, req) {
  h["access-control-allow-origin"] = req.headers["origin"] || "*";
  h["access-control-allow-credentials"] = "true";
  h["access-control-expose-headers"] = "*";
}

// 去掉 Domain，并下放 Secure/SameSite 以便在 http://localhost 下也能存
function rewriteSetCookie(resp) {
  const cookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  return cookies.map((c) =>
    c.replace(/;\s*Domain=[^;]+/i, "")
     .replace(/;\s*Secure/i, "")
     .replace(/;\s*SameSite=None/i, "; SameSite=Lax")
  );
}

function rewriteLocation(h, upstreamHost, proxyHost) {
  const key = Object.keys(h).find((k) => k.toLowerCase() === "location");
  if (!key) return;
  const loc = h[key];
  let abs = loc;
  if (loc.startsWith("//")) abs = "https:" + loc;
  else if (loc.startsWith("/")) abs = `https://${upstreamHost}${loc}`;
  h[key] = toProxyUrl(abs, proxyHost);
}

// ---------------- HTML 注入 + 属性改写（替代 HTMLRewriter） ----------------
function injectAndRewriteHtml(html, proxyHost) {
  // a) src/href 绝对 URL 改写
  html = html.replace(/\b(src|href)\s*=\s*("|')(.*?)\2/gi, (full, attr, q, val) => {
    let nv = val;
    if (/^https?:\/\//i.test(val)) nv = toProxyUrl(val, proxyHost);
    else if (val.startsWith("//")) nv = toProxyUrl("https:" + val, proxyHost);
    return `${attr}=${q}${nv}${q}`;
  });
  // b) srcset（响应式图片，逗号分隔的 "url 描述符"）
  html = html.replace(/\bsrcset\s*=\s*("|')(.*?)\1/gi, (full, q, val) => {
    const nv = val.split(",").map((part) => {
      const seg = part.trim();
      const sp = seg.indexOf(" ");
      const url = sp === -1 ? seg : seg.slice(0, sp);
      const desc = sp === -1 ? "" : seg.slice(sp);
      let nu = url;
      if (/^https?:\/\//i.test(url)) nu = toProxyUrl(url, proxyHost);
      else if (url.startsWith("//")) nu = toProxyUrl("https:" + url, proxyHost);
      return nu + desc;
    }).join(", ");
    return `srcset=${q}${nv}${q}`;
  });
  // c) 注入劫持脚本到 <head> 最前面（保证早于页面脚本执行）
  const tag = `<script>${buildClientScript(proxyHost)}</script>`;
  const m = html.match(/<head[^>]*>/i);
  if (m) {
    const idx = m.index + m[0].length;
    return html.slice(0, idx) + tag + html.slice(idx);
  }
  return tag + html;
}

// ---------------- 注入页面的运行时劫持脚本 ----------------
function buildClientScript(proxyHost) {
  return `
(function(){
  var PROXY=${JSON.stringify(proxyHost)};
  var RE=new RegExp(${JSON.stringify(UPSTREAM_RE_SRC)},"i");
  function toProxy(input){
    try{
      var u=new URL(input, location.href);
      if(u.hostname===PROXY) return input;
      if(!RE.test(u.hostname)) return input;
      if(u.protocol==="ws:"||u.protocol==="wss:")
        return (location.protocol==="https:"?"wss:":"ws:")+"//"+PROXY+"/__pws__/"+u.hostname+u.pathname+u.search;
      return location.protocol+"//"+PROXY+"/__p/"+u.hostname+u.pathname+u.search;
    }catch(e){ return input; }
  }
  // fetch —— DPoP 头已由原版代码算好放进 init，这里只换 URL，签名照旧有效
  var _fetch=window.fetch;
  window.fetch=function(input,init){
    try{
      if(typeof input==="string") input=toProxy(input);
      else if(input&&input.url) input=new Request(toProxy(input.url),input);
    }catch(e){}
    return _fetch.call(this,input,init);
  };
  // XHR
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,url){ arguments[1]=toProxy(url); return _open.apply(this,arguments); };
  // WebSocket
  var _WS=window.WebSocket;
  window.WebSocket=function(url,p){ return new _WS(toProxy(url),p); };
  window.WebSocket.prototype=_WS.prototype;
  try{ ["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){ window.WebSocket[k]=_WS[k]; }); }catch(e){}
  // 动态插入元素的 src/href
  ["src","href"].forEach(function(prop){
    [HTMLScriptElement,HTMLImageElement,HTMLLinkElement,HTMLIFrameElement].forEach(function(K){
      if(!K) return;
      var d=Object.getOwnPropertyDescriptor(K.prototype,prop);
      if(!d||!d.set) return;
      Object.defineProperty(K.prototype,prop,{
        configurable:true, enumerable:d.enumerable,
        get:function(){ return d.get.call(this); },
        set:function(v){ d.set.call(this,toProxy(v)); }
      });
    });
  });
  var _setAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(n,v){ if(n==="src"||n==="href") v=toProxy(v); return _setAttr.call(this,n,v); };
})();
`;
}

// ---------------- utils ----------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`mercari-proxy (node) → ${SCHEME}://localhost:${PORT}`);
  console.log(`默认上游: ${DEFAULT_UPSTREAM}`);
  if (SCHEME === "http") {
    console.log(
      "⚠ 当前是 http。只有 http://localhost 能用；用局域网 IP/域名访问会因不是安全上下文而 crypto.subtle 缺失，DPoP 失败、商品刷不出。"
    );
    console.log("  上 https：openssl 生成自签证书后用 TLS_CERT=cert.pem TLS_KEY=key.pem node server.js");
  }
});
