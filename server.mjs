#!/usr/bin/env node
/**
 * fnmusic-302
 * 飞牛音乐 → OpenList(115) 302 直链反代
 *
 * 做三件事：
 *  1. 反代飞牛音乐（/music/*），登录、接口、静态资源全部透传。
 *  2. 拦截 /music/api/v1/track/stream?guid=xxx：
 *     查 fnMusic 的 track/metadata 得到本地路径 → 映射成 115 路径
 *     → 向 OpenList 换 115 签名直链 → 返回 302。
 *  3. 给播放器 JS 打两个小补丁（否则 302 一定失败，见 README）：
 *     - 去掉 <audio> 的 crossOrigin="anonymous"（115 CDN 没有 CORS 头）
 *     - 强制直出媒体（不经过 Web Audio，避免跨域媒体被静音）
 *
 * 无第三方依赖，Node >= 18。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ config */
const defaults = {
  port: 5667,
  listen: '0.0.0.0',
  upstream: 'http://192.168.0.108:5666',
  openlist: {
    url: 'http://192.168.0.108:5244',
    username: '',
    password: '',
  },
  // 本地挂载路径前缀 → OpenList 里的 115 路径前缀（按最长前缀匹配）。
  // 可用 config.json 的 pathMaps 覆盖，也可用环境变量 PATH_MAPS 覆盖（后者优先）。
  pathMaps: [
    { from: '/vol1/1000/音乐库/115音乐库/', to: '/115网盘/音乐库/' },
  ],
  // direct = 能映射就 302；stream = 不 302，由本服务从 115 拉流并补 CORS
  mode: 'direct',
  // 是否给播放器 JS 打补丁（direct 模式必须为 true）
  patchPlayer: true,
  // 直链剩余有效期低于该秒数时，在「播放请求到达时」重新换链。
  // 只在播放时刷新：没有任何后台定时器，不播放就不打扰 115。
  linkMinTtl: 600,
  // 安全阀：若换链后剩余有效期仍撑不完当前曲目（+120s），本次改为拉流，
  // 让服务端能在播放途中自动续链。正常情况下永远用不到。
  directGuard: true,
  log: true,
};

/* 警告不受 log 开关影响；同一个 key 只打一次，避免刷屏 */
const warnedKeys = new Set();
function warn(msg) {
  console.warn(new Date().toISOString(), 'WARN', msg);
}
function warnOnce(key, msg) {
  if (warnedKeys.has(key)) return;
  if (warnedKeys.size > 200) warnedKeys.clear();
  warnedKeys.add(key);
  warn(msg);
}

/* 路径统一成 /a/b/ 形式；空值归一成根目录 / */
function normDir(v) {
  const s = String(v == null ? '' : v)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return s ? `/${s}/` : '/';
}

/*
 * PATH_MAPS="/本地/前缀/=/网盘/前缀/,/另一个/=/另一个2/"
 * 分隔符支持 , ; 换行；等号可写成 = 或 =>；等号两侧空格无所谓。
 * 一旦设置就整体替换 config.json / 内置默认映射（不追加）。
 */
function parsePathMaps(raw) {
  const out = [];
  for (const chunk of String(raw).split(/[,;\n]+/)) {
    const s = chunk.trim();
    if (!s) continue;
    const i = s.includes('=>') ? s.indexOf('=>') : s.indexOf('=');
    if (i < 0) {
      warn(`PATH_MAPS 片段缺少 "="，已忽略: ${s}`);
      continue;
    }
    const from = s.slice(0, i).trim();
    const to = s.slice(i + (s[i] === '=' && s[i + 1] === '>' ? 2 : 1)).trim();
    if (!from) {
      warn(`PATH_MAPS 片段缺少本地前缀，已忽略: ${s}`);
      continue;
    }
    out.push({ from, to: to || '/' });
  }
  return out;
}

let pathMapsSource = 'default';

function loadConfig() {
  let fileCfg = {};
  const cfgPath = process.env.CONFIG || path.join(__dirname, 'config.json');
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[config] 读取 ${cfgPath} 失败: ${e.message}`);
  }
  const cfg = {
    ...defaults,
    ...fileCfg,
    openlist: { ...defaults.openlist, ...(fileCfg.openlist || {}) },
  };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.LISTEN) cfg.listen = process.env.LISTEN;
  if (process.env.UPSTREAM) cfg.upstream = process.env.UPSTREAM;
  if (process.env.OPENLIST_URL) cfg.openlist.url = process.env.OPENLIST_URL;
  if (process.env.OPENLIST_USER) cfg.openlist.username = process.env.OPENLIST_USER;
  if (process.env.OPENLIST_PASS) cfg.openlist.password = process.env.OPENLIST_PASS;
  if (process.env.MODE) cfg.mode = process.env.MODE;
  if (process.env.PATCH_PLAYER) cfg.patchPlayer = process.env.PATCH_PLAYER !== '0';
  if (process.env.LINK_MIN_TTL) cfg.linkMinTtl = Number(process.env.LINK_MIN_TTL);
  if (process.env.DIRECT_GUARD) cfg.directGuard = process.env.DIRECT_GUARD !== '0';
  if (Array.isArray(fileCfg.pathMaps) && fileCfg.pathMaps.length) pathMapsSource = 'config';
  if (process.env.PATH_MAPS) {
    const parsed = parsePathMaps(process.env.PATH_MAPS);
    if (parsed.length) {
      cfg.pathMaps = parsed;
      pathMapsSource = 'env';
    } else {
      warn('PATH_MAPS 解析后为空，沿用 config.json / 内置默认映射');
    }
  }
  cfg.upstream = cfg.upstream.replace(/\/+$/, '');
  cfg.openlist.url = cfg.openlist.url.replace(/\/+$/, '');
  cfg.pathMaps = (cfg.pathMaps || [])
    .map((m) => ({ from: normDir(m && m.from), to: normDir(m && m.to) }))
    .filter((m) => m.from !== '/' && m.from !== m.to);
  return cfg;
}

const CFG = loadConfig();
const log = (...a) => CFG.log && console.log(new Date().toISOString(), ...a);

if (CFG.pathMaps.length) {
  log(`[config] 路径映射 ${CFG.pathMaps.length} 条（来源: ${pathMapsSource}）:`);
  for (const m of CFG.pathMaps) log(`  ${m.from}  →  ${m.to}`);
} else {
  warn('[config] 没有任何路径映射（PATH_MAPS / pathMaps），所有播放都会回退透传');
}

/* --------------------------------------------------------------- utilities */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

function cleanReqHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
  }
  // 让上游返回未压缩文本，便于给 JS 打补丁
  h['accept-encoding'] = 'identity';
  return h;
}

function originOf(req) {
  return req.headers.origin || '*';
}

function corsHeaders(req) {
  const origin = originOf(req);
  const h = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified',
    Vary: 'Origin',
  };
  if (origin !== '*') h['Access-Control-Allow-Credentials'] = 'true';
  return h;
}

const MIME = {
  '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.ape': 'audio/x-ape', '.wv': 'audio/x-wavpack',
  '.dsf': 'audio/x-dsf', '.dff': 'audio/x-dff', '.tta': 'audio/x-tta',
};

/* --------------------------------------------------------------- OpenList */
let olToken = '';
let olTokenExp = 0;

// olPath -> { url, exp, fetchedAt }
//   exp       = 115 直链自身的过期时间（从 URL 的 t 参数解析）
//   fetchedAt = 上次换链时间
// 这里没有、也不会有后台定时刷新：只在播放请求到达时按需换链。
const linkCache = new Map();
const linkInflight = new Map();
const linkStats = { fetched: 0, reused: 0, refreshedOnPlay: 0, expiredRetry: 0, failed: 0 };

const LINK_UNKNOWN_TTL = 10 * 60 * 1000;

// 缓存只做上限保护，不做后台清理（Map 的插入顺序天然是 LRU 的近似）
function pruneCache(map, max = 2000) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function linkExpiry(url) {
  try {
    const t = Number(new URL(url).searchParams.get('t'));
    // 115 的 t 是秒级过期时间戳；没有或已过期就按保守的 10 分钟算
    if (t > 0 && t * 1000 > Date.now()) return t * 1000;
  } catch {}
  return Date.now() + LINK_UNKNOWN_TTL;
}

async function openlistLogin(force = false) {
  if (!force && olToken && Date.now() < olTokenExp) return olToken;
  const r = await fetch(`${CFG.openlist.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: CFG.openlist.username, password: CFG.openlist.password }),
  });
  const j = await r.json();
  if (j.code !== 200 || !j.data?.token) throw new Error(`OpenList 登录失败: ${j.message || r.status}`);
  olToken = j.data.token;
  // token 正常有效 48h，这里保守缓存 12h，遇到 401 会强制重登
  olTokenExp = Date.now() + 12 * 3600 * 1000;
  log('[openlist] 登录成功');
  return olToken;
}

/**
 * 取 115 直链。核心策略：只在播放时刷新。
 *   - 缓存里还有 linkMinTtl 以上的余量 → 直接复用（不碰 115）
 *   - 余量不足 / 已过期 / 显式 force → 现在换一条新的
 *   - 同一路径并发请求共用一次换链（Range 分片、prefetch、媒体元素同时到达很常见）
 */
async function openlistRawUrl(olPath, { force = false, minTtl } = {}) {
  const margin = minTtl ?? CFG.linkMinTtl * 1000;
  const hit = linkCache.get(olPath);

  if (!force && hit) {
    const remaining = hit.exp - Date.now();
    const justFetched = Date.now() - hit.fetchedAt < 30_000;
    if (remaining > margin || (justFetched && remaining > 0)) {
      linkStats.reused++;
      return hit.url;
    }
    linkStats.refreshedOnPlay++;
    log(`[link] 播放前换链：剩余 ${Math.max(0, Math.round(remaining / 1000))}s < 阈值 ${Math.round(margin / 1000)}s`);
  }

  const running = linkInflight.get(olPath);
  if (running) return running;

  const p = fetchRawUrl(olPath).finally(() => linkInflight.delete(olPath));
  linkInflight.set(olPath, p);
  return p;
}

async function fetchRawUrl(olPath) {
  const call = async () => {
    const token = await openlistLogin();
    const r = await fetch(`${CFG.openlist.url}/api/fs/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token },
      body: JSON.stringify({ path: olPath, password: '' }),
    });
    return { status: r.status, json: await r.json() };
  };

  try {
    let { status, json } = await call();
    if (status === 401 || json.code === 401) {
      await openlistLogin(true);
      ({ status, json } = await call());
    }
    if (json.code !== 200 || !json.data?.raw_url) {
      throw new Error(`OpenList 取直链失败(${json.code}): ${json.message || ''} ${olPath}`);
    }
    const url = json.data.raw_url;
    const exp = linkExpiry(url);
    linkCache.set(olPath, { url, exp, fetchedAt: Date.now() });
    pruneCache(linkCache);
    linkStats.fetched++;
    log(`[link] 换链成功，有效期 ${Math.round((exp - Date.now()) / 1000)}s  ${olPath}`);
    return url;
  } catch (e) {
    linkStats.failed++;
    throw e;
  }
}

function mapTo115(localPath) {
  if (!localPath) return null;
  const p = localPath.replace(/\\/g, '/');
  let best = null;
  for (const m of CFG.pathMaps) {
    if (p.startsWith(m.from) && (!best || m.from.length > best.from.length)) best = m;
  }
  if (!best) return null;
  return best.to + p.slice(best.from.length);
}

/* ---------------------------------------------------------------- fnMusic */
const metaCache = new Map(); // guid -> { data, exp }

async function fnMetadata(guid, cookie) {
  const hit = metaCache.get(guid);
  if (hit && Date.now() < hit.exp) return hit.data;
  const r = await fetch(
    `${CFG.upstream}/music/api/v1/track/metadata?guid=${encodeURIComponent(guid)}`,
    { headers: cookie ? { cookie } : {} },
  );
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0 || !j.data) return null;
  metaCache.set(guid, { data: j.data, exp: Date.now() + 5 * 60 * 1000 });
  pruneCache(metaCache);
  return j.data;
}

/* -------------------------------------------------------------- streaming */
const looksExpired = (r) => r.status === 400 || r.status === 401 || r.status === 403;

async function streamFrom115(req, res, rawUrl, olPath) {
  const doFetch = (url) => {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    return fetch(url, { headers, redirect: 'follow' });
  };

  let r;
  try {
    r = await doFetch(rawUrl);
  } catch (e) {
    log('[link] 拉流失败，换链后重试', e.message);
    linkStats.expiredRetry++;
    r = await doFetch(await openlistRawUrl(olPath, { force: true }));
  }

  // 拉流模式下，直链过期会表现为 403（OSS AccessDenied）。此时换一条新链
  // 用同一个 Range 重放，浏览器完全无感 —— 这是「播放途中自动刷新」。
  if (looksExpired(r) && olPath) {
    log(`[link] 115 返回 ${r.status}（多半是直链过期），换链后用同一 Range 重试`);
    linkStats.expiredRetry++;
    try { await r.body?.cancel(); } catch {}
    try {
      r = await doFetch(await openlistRawUrl(olPath, { force: true }));
    } catch (e) {
      log('[link] 换链重试失败', e.message);
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(req) });
      return res.end('115 link expired and renew failed');
    }
  }

  const out = corsHeaders(req);
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = r.headers.get(k);
    if (v) out[k] = v;
  }
  let ct = r.headers.get('content-type') || 'application/octet-stream';
  if (ct === 'application/octet-stream') {
    try {
      const ext = path.extname(decodeURIComponent(new URL(rawUrl).pathname)).toLowerCase();
      if (MIME[ext]) ct = MIME[ext];
    } catch {}
  }
  out['content-type'] = ct;
  out['cache-control'] = 'private, max-age=3600';

  res.writeHead(r.status, out);
  if (!r.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(r.body).pipe(res);
}

/* ------------------------------------------------------------------ proxy */
function proxy(req, res, { patch = false } = {}) {
  const target = new URL(req.url, CFG.upstream);
  const headers = cleanReqHeaders(req);
  const up = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (ur) => {
      const h = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
      }
      // HTTP 下浏览器本来就会忽略 COEP/COOP；顺手去掉，避免以后上 HTTPS 时
      // require-corp 把 115 的媒体请求拦掉。
      delete h['cross-origin-embedder-policy'];
      delete h['cross-origin-opener-policy'];

      const isJs = /javascript|ecmascript/i.test(h['content-type'] || '');
      if (patch && isJs) {
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          const before = body;
          body = body
            .replaceAll('e.crossOrigin=`anonymous`,', '')
            .replaceAll('usesDirectMediaOutput=g()', 'usesDirectMediaOutput=!0');
          const buf = Buffer.from(body);
          h['content-length'] = buf.length;
          delete h.etag;
          delete h['last-modified'];
          h['cache-control'] = 'no-store';
          h['x-fnmusic302-patched'] = before === body ? '0' : '1';
          res.writeHead(ur.statusCode || 200, h);
          res.end(buf);
        });
        return;
      }
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    },
  );
  up.on('error', (e) => {
    log('[proxy] 上游错误', e.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`upstream error: ${e.message}`);
  });
  if (req.method === 'GET' || req.method === 'HEAD') up.end();
  else req.pipe(up);
}

/* ------------------------------------------------------------ stream route */
async function handleStream(req, res, u) {
  const guid = u.searchParams.get('guid');
  if (!guid) return proxy(req, res);

  const meta = await fnMetadata(guid, req.headers.cookie);
  if (!meta) return proxy(req, res); // 未登录 / 曲目不存在，交给上游处理

  const localPath = meta.audioSpec?.path;
  const isCue = !!meta.track?.isCue;
  const olPath = mapTo115(localPath);

  if (!olPath) {
    warnOnce(
      `nomap:${String(localPath || '').split('/').slice(0, 5).join('/')}`,
      `[stream] 未命中路径映射，回退透传: ${localPath || '(no path)'}` +
        ` —— 检查 PATH_MAPS / config.json 的 pathMaps（当前 ${CFG.pathMaps.length} 条）`,
    );
    return proxy(req, res);
  }
  if (isCue) {
    log('[stream] cue 曲目，回退透传', localPath);
    return proxy(req, res);
  }

  let raw;
  try {
    raw = await openlistRawUrl(olPath, { force: u.searchParams.get('renew') === '1' });
  } catch (e) {
    log('[stream] 取直链失败，回退透传', e.message);
    return proxy(req, res);
  }

  // 浏览器 fetch()（WASM 解码 / 元数据分片）是 cors 模式，115 没有 CORS 头，
  // 只能由本服务拉流并补头；<audio> 在补丁后是 no-cors，可以安心 302。
  const fetchMode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
  const wantsCors = fetchMode === 'cors';

  // 安全阀：这条链的剩余寿命撑不完本曲（换链刚失败时会走到这里），
  // 那就改走拉流，让服务端在播放途中自己续链，避免中途 403。
  let tooShort = false;
  if (CFG.directGuard && !wantsCors && CFG.mode !== 'stream') {
    const entry = linkCache.get(olPath);
    const remaining = (entry ? entry.exp : 0) - Date.now();
    const durationMs = Number(meta.audioSpec?.duration || meta.duration || 0);
    tooShort = durationMs > 0 && remaining < durationMs + 120_000;
    if (tooShort) log(`[link] 剩余 ${Math.round(remaining / 1000)}s 撑不完 ${Math.round(durationMs / 1000)}s 的曲目，改走拉流`);
  }

  if (CFG.mode === 'stream' || wantsCors || tooShort) {
    log('[stream] 拉流', wantsCors ? '(cors/fetch)' : tooShort ? '(直链过短)' : '(stream mode)', olPath);
    return streamFrom115(req, res, raw, olPath);
  }

  log('[stream] 302', olPath);
  res.writeHead(302, {
    Location: raw,
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  });
  res.end();
}

/* ------------------------------------------------------------- self check */
async function selfCheck() {
  if (!CFG.patchPlayer) {
    if (CFG.mode === 'direct') {
      console.warn('[selfcheck] patchPlayer=false 但 mode=direct：播放器仍会以 CORS 方式取流，302 会失败，建议改成 stream');
    }
    return;
  }
  try {
    const r = await fetch(`${CFG.upstream}/music/`, { headers: { 'accept-encoding': 'identity' } });
    const html = await r.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1]);
    let checked = 0;
    for (const a of assets) {
      const u = new URL(a, CFG.upstream).href;
      const js = await (await fetch(u, { headers: { 'accept-encoding': 'identity' } })).text();
      checked++;
      if (js.includes('usesDirectMediaOutput=g()') && js.includes('e.crossOrigin=`anonymous`,')) {
        log(`[selfcheck] 播放器补丁锚点正常（已检查 ${checked} 个 JS）`);
        return;
      }
    }
    console.warn('[selfcheck] 没找到播放器补丁锚点，飞牛音乐可能升级了；自动回退到 stream 模式（不 302，但播放正常）');
    CFG.mode = 'stream';
    CFG.patchPlayer = false;
  } catch (e) {
    console.warn(`[selfcheck] 跳过（${e.message}），按配置继续启动`);
  }
}

await selfCheck();

/* ------------------------------------------------------------------ server */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // 根路径是飞牛 fnOS 门户（打开只会卡在「加载中」），直接送到 fnMusic
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(302, { Location: '/music/', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (u.pathname === '/__fnmusic302/health') {
    const now = Date.now();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      mode: CFG.mode,
      patchPlayer: CFG.patchPlayer,
      linkMinTtl: CFG.linkMinTtl,
      directGuard: CFG.directGuard,
      upstream: CFG.upstream,
      openlist: CFG.openlist.url,
      pathMaps: CFG.pathMaps,
      pathMapsSource,
      links: linkCache.size,
      linkDetails: [...linkCache.entries()].map(([p, v]) => ({
        path: p,
        remaining: Math.max(0, Math.round((v.exp - now) / 1000)),
        age: Math.round((now - v.fetchedAt) / 1000),
      })),
      linkStats,
    }));
  }

  // 手动丢弃缓存的直链（下次播放时重新换链）。GET 方便用浏览器/curl 触发。
  if (u.pathname === '/__fnmusic302/refresh') {
    const only = u.searchParams.get('path');
    if (only) linkCache.delete(only);
    else linkCache.clear();
    log('[link] 手动清空直链缓存', only || '(all)');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, cleared: only || 'all', links: linkCache.size }));
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  try {
    if (u.pathname === '/music/api/v1/track/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
      return await handleStream(req, res, u);
    }
    proxy(req, res, { patch: CFG.patchPlayer });
  } catch (e) {
    log('[server] 未捕获错误', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('internal error');
  }
});

server.listen(CFG.port, CFG.listen, () => {
  log(`fnmusic-302 已启动: http://${CFG.listen}:${CFG.port}/music/`);
  log(`模式=${CFG.mode} 补丁=${CFG.patchPlayer} 上游=${CFG.upstream} OpenList=${CFG.openlist.url}`);
  log(`直链策略: 仅在播放时刷新，剩余 < ${CFG.linkMinTtl}s 时换链（无后台定时器）`);
});

server.on('error', (e) => {
  console.error('监听失败:', e.message);
  process.exit(1);
});
