# mercari-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#)
[![Zero deps](https://img.shields.io/badge/deps-0-blue.svg)](#)

A **zero-dependency**, single-file Node reverse proxy for **Mercari** (jp / us).

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

```bash
git clone https://github.com/gosoki/mercari-proxy.git
cd mercari-proxy
npm start                 # http://localhost:8787
```

That's it — zero install step, zero runtime dependencies. Node 18+ is the only requirement.

### Other useful scripts

```bash
PORT=9000 npm start                  # custom port
npm run start:us                     # proxy the US site (www.mercari.com)
npm run cert && npm run start:https  # generate self-signed cert + run HTTPS
npm run check                        # syntax check
```

Outbound requests go from **your own IP**, which is the least likely to trip Mercari's bot / WAF rules.

### When you need HTTPS

If you open the proxy via `http://<lan-ip>:8787`, the browser does *not* consider it a secure context, so `crypto.subtle` is missing and DPoP signing fails — items won't load. `http://localhost` is fine; anything else needs HTTPS:

```bash
npm run cert            # writes cert.pem + key.pem (self-signed, 365 days)
npm run start:https     # serves on https://localhost:8787
```

Self-signed certs need a one-time "trust" / "advanced → proceed" in the browser.

---

## Configuration

| Where | What | Default |
| ----- | ---- | ------- |
| Env `PORT` | Listening port | `8787` |
| Env `UPSTREAM` | Upstream host | `jp.mercari.com` |
| Env `TLS_CERT`, `TLS_KEY` | Enable HTTPS when both are set | unset (HTTP) |
| `server.js` → `JS_PATCHES` | Targeted string-replacement in bundled JS | `[]` |

Leave `JS_PATCHES` empty unless something specific is blocking you (e.g. a hardcoded `location.host === "jp.mercari.com"` check that needs neutralizing).

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
├── server.js       # the whole proxy, zero deps
├── package.json    # npm scripts only — no runtime deps
├── LICENSE         # MIT
└── README.md
```

---

## Legal

Reverse-proxying someone else's site touches copyright and Terms of Service. This project is for **personal research and self-use only**. Exposing it as a public service is at your own risk.

---

## 中文文档

零依赖单文件 Node 反代煤炉 (Mercari)。

### 原理

- **服务端**：删 CSP、补 CORS、改 `Set-Cookie`、改 `Location`，HTML 里注入劫持脚本
- **客户端（注入脚本）**：运行时劫持 `fetch` / `XHR` / `WebSocket` 和 `src` / `href` 的 setter，把煤炉域名改写成走代理
- **关键**：不静态改 JS 里的 API 域名，让 Mercari 原版代码先把 DPoP 签名算好（`htu` 仍是 `api.mercari.jp`），只在发请求那一刻换 host，转发时把 Host 设回源站 → 服务端校验 `htu` 仍匹配，登录态/接口能用

### 开跑

```bash
git clone https://github.com/gosoki/mercari-proxy.git
cd mercari-proxy
npm start                            # http://localhost:8787
```

零安装，零运行时依赖，Node 18+ 即可。出站走你本机 IP，最不容易踩风控。

其它常用命令：

```bash
PORT=9000 npm start                  # 换端口
npm run start:us                     # 换成美区 www.mercari.com
npm run cert && npm run start:https  # 自签证书 + 跑 HTTPS
npm run check                        # 语法检查
```

### 关于 HTTPS

局域网 IP / 域名访问必须走 HTTPS，否则浏览器不是安全上下文，`crypto.subtle` 不可用 → Mercari 的 DPoP 签不出 → 商品刷不出。`http://localhost` 例外，能直接用。

```bash
npm run cert            # 生成自签证书 cert.pem + key.pem
npm run start:https     # https://localhost:8787
```

自签证书第一次访问需要在浏览器点「高级 → 继续访问」。

### 配置项

| 在哪 | 是啥 | 默认值 |
| ---- | ---- | ------ |
| 环境变量 `PORT` | 监听端口 | `8787` |
| 环境变量 `UPSTREAM` | 上游域名 | `jp.mercari.com` |
| 环境变量 `TLS_CERT` / `TLS_KEY` | 同时设置则跑 HTTPS | 未设置（跑 HTTP） |
| `server.js` 里 `JS_PATCHES` | JS 文本针对性替换 | `[]` |

### 注意点

1. **硬编码 host 检查**（如 `if (location.host !== 'jp.mercari.com') ...`）：浏览器 `location` 改不了，只能在 `JS_PATCHES` 里替换掉那段逻辑（先抓到对应 chunk 字符串）
2. **反 bot 指纹**（Akamai 等）：可能给 403 / 挑战页，属于风控层，不一定能稳过
3. **WebSocket** 已带基础代理（`/__pws__/`），SSE 走普通 fetch 透传
4. **Cookie**：多个上游域名的 cookie 都落到代理域名上，多数情况共用一套没事
5. **DPoP 登录**：理论可用；若额外校验 TLS 指纹或更严的 Origin 绑定，登录可能失败。建议先用浏览/搜索验证通路，再试登录

### 合规

反代他人站点涉及版权 / ToS，仅供自用研究；对外提供服务风险较大，自行把握。
