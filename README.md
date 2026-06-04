# mercari-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020.svg)](#)

A zero-dependency reverse proxy for **Mercari** (jp / us), shipped in two flavors:

- **`server.js`** — single-file Node server (Node 18+).
- **`worker.js`** — single-file Cloudflare Worker.

> [中文文档见下方](#中文文档)

---

## How it works

The hard part of proxying Mercari is **DPoP**: the front-end signs every API request with a JWT whose `htu` claim is the *original* API host (`api.mercari.jp`). If you statically rewrite the API host in the bundled JS, the signature stops matching the URL the server sees.

This proxy avoids that by splitting the work between server and client:

- **Server side** — strips CSP, adds CORS, rewrites `Set-Cookie`, rewrites `Location`, and injects a small script into every HTML response.
- **Client side (injected script)** — at runtime, hijacks `fetch` / `XMLHttpRequest` / `WebSocket` and the `src` / `href` setters, so Mercari domains get rewritten *just before the request goes out*. The original code has already computed the DPoP signature against the real host, so by the time we swap in the proxy host the signature is still valid; the server then forwards to the real upstream with the original Host header intact.

The net effect: cookies, auth, DPoP — all keep working.

---

## Quick start

### Option A — Node (recommended for personal use)

```bash
git clone https://github.com/gosoki/mercari-proxy.git
cd mercari-proxy
npm start                 # http://localhost:8787
```

Other variants:

```bash
PORT=9000 npm start                 # custom port
npm run start:us                    # proxy the US site (www.mercari.com)
npm run cert && npm run start:https # generate self-signed cert + run HTTPS
```

Outbound requests go from **your own IP**, which is the least likely to trip Mercari's bot/WAF rules.

> **Why HTTPS matters for LAN access.** If you open the proxy via `http://<lan-ip>:8787`, the browser does *not* consider it a secure context, so `crypto.subtle` is missing and DPoP signing fails — items won't load. `http://localhost` is fine, anything else needs HTTPS.

### Option B — Cloudflare Workers

```bash
npm i -g wrangler
wrangler login
# edit wrangler.toml: set your route pattern + zone_name
npm run deploy
```

> ⚠️ **Known gotcha (already handled in `worker.js`).** `api.mercari.jp` itself sits behind Cloudflare. If you forward the incoming request's headers as-is, Cloudflare injects `cf-connecting-ip` etc. — and the upstream CF rejects requests carrying a `cf-connecting-ip` it didn't set, returning a **WAF 403** that looks like "search / items broken". `worker.js` strips all `cf-*`, `x-forwarded-*`, and `x-real-ip` before forwarding.

---

## Configuration

| Where | What to change |
| ----- | -------------- |
| `worker.js` | `DEFAULT_UPSTREAM` — `jp.mercari.com` (default) or `www.mercari.com` |
| `wrangler.toml` | `routes[].pattern` and `zone_name` to your domain |
| Env (`server.js`) | `PORT`, `UPSTREAM`, `TLS_CERT`, `TLS_KEY` |

Both files also accept a `JS_PATCHES` array for targeted string-replacement in the bundled JS — e.g. defusing a hardcoded `location.host === "jp.mercari.com"` check. Empty by default; leave it empty unless something is actually blocking you.

---

## Caveats

1. **Hardcoded host checks** in the SPA bundle — `location.host` isn't spoofable client-side, so any `if (location.host !== "jp.mercari.com") …` has to be neutralized via `JS_PATCHES`.
2. **Anti-bot fingerprinting** (Akamai et al.) — 403 / challenge pages are possible. This proxy doesn't solve fingerprinting.
3. **WebSocket** — basic proxy at `/__pws__/<host>/<path>`. SSE rides regular `fetch` and passes through.
4. **Cookies** — cookies from multiple upstream domains are collapsed onto the proxy domain. Usually fine in practice.
5. **Login (DPoP)** — works in theory; if Mercari adds stricter Origin binding or TLS fingerprinting, login may break. Verify browse / search first, then try logging in.

---

## Project layout

```
mercari-proxy/
├── server.js       # Node server (single file, zero deps)
├── worker.js       # Cloudflare Worker (single file)
├── wrangler.toml   # CF Worker deployment config
├── package.json    # npm scripts only — no runtime deps
└── LICENSE         # MIT
```

---

## Legal

Reverse-proxying someone else's site touches copyright and Terms of Service. This project is for **personal research and self-use only**. Exposing it as a public service is at your own risk.

---

## 中文文档

Cloudflare Workers / Node 反代煤炉 (Mercari)，零依赖单文件。

### 原理

- **服务端**：删 CSP、补 CORS、改 `Set-Cookie`、改 `Location`，HTML 里注入劫持脚本
- **客户端（注入脚本）**：运行时劫持 `fetch` / `XHR` / `WebSocket` 和 `src` / `href` 的 setter，把煤炉域名改写成走代理
- **关键**：不静态改 JS 里的 API 域名，让 Mercari 原版代码先把 DPoP 签名算好（`htu` 仍是 `api.mercari.jp`），只在发请求那一刻换 host，转发时把 Host 设回源站 → 服务端校验 `htu` 仍匹配，登录态/接口能用

### 部署

**方式一：本机 / 普通服务器跑 Node（推荐）**

```bash
git clone https://github.com/gosoki/mercari-proxy.git
cd mercari-proxy
npm start                            # http://localhost:8787
PORT=9000 npm start                  # 换端口
npm run start:us                     # 换成美区 www.mercari.com
npm run cert && npm run start:https  # 自签证书 + 跑 HTTPS
```

零依赖，Node 18+ 即可。出站走你本机 IP，最不容易踩风控。

> **关于 HTTPS**：局域网 IP / 域名访问必须走 HTTPS，否则浏览器不是安全上下文，`crypto.subtle` 不可用 → Mercari 的 DPoP 签不出 → 商品刷不出。`http://localhost` 例外，能直接用。

**方式二：Cloudflare Workers**

```bash
npm i -g wrangler
wrangler login
# 改 wrangler.toml 里的 pattern / zone_name
npm run deploy
```

> ⚠️ **坑（已在 worker.js 修掉）**：`api.mercari.jp` 也在 Cloudflare 后面。Worker 入站请求里 Cloudflare 会注入 `cf-connecting-ip` 等头，若用 `new Headers(request.headers)` 原样转发，上游那侧的 CF 会把它当成「伪造 cf-connecting-ip」直接 **WAF 403**，表现为搜索/商品接口全挂、商品显示不出来。`worker.js` 现在转发前会 strip 掉所有 `cf-*` / `x-forwarded-*` / `x-real-ip`。

### 用之前要改的

1. `worker.js` 里的 `DEFAULT_UPSTREAM`（日本站 `jp.mercari.com`，美区 `www.mercari.com`）
2. `wrangler.toml` 里的 `pattern` / `zone_name`

### 注意点

1. **硬编码 host 检查**（如 `if (location.host !== 'jp.mercari.com') ...`）：浏览器 `location` 改不了，只能在 `JS_PATCHES` 里替换掉那段逻辑（先抓到对应 chunk 字符串）
2. **反 bot 指纹**（Akamai 等）：可能给 403 / 挑战页，属于风控层，不一定能稳过
3. **WebSocket** 已带基础代理（`/__pws__/`），SSE 走普通 fetch 透传
4. **Cookie**：多个上游域名的 cookie 都落到代理域名上，多数情况共用一套没事
5. **DPoP 登录**：理论可用；若额外校验 TLS 指纹或更严的 Origin 绑定，登录可能失败。建议先用浏览/搜索验证通路，再试登录

### 合规

反代他人站点涉及版权 / ToS，仅供自用研究；对外提供服务风险较大，自行把握。
