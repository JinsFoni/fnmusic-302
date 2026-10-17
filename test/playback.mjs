#!/usr/bin/env node
/**
 * fnmusic-302 端到端播放测试（Playwright）
 *
 * 自己拉起一个全新的 headless Chrome（临时 profile），不连接、不干扰本机
 * 正在使用的 Chrome，也不碰 9222 调试端口。
 *
 *   node test/playback.mjs
 *   BASE=http://127.0.0.1:5667 node test/playback.mjs
 *
 * 覆盖：
 *   1. 登录拿 cookie → 打开 /music/ → 点播放
 *   2. track/stream 返回 302，Location 指向 115 CDN
 *   3. 音频元素 crossOrigin=null、真的在走、readyState>=3、无 error
 *   4. 115 返回 206 且 Range 生效
 *   5. 拖动进度条后重新发 Range，播放继续
 *   6. 全程 0 条 CORS / 页面异常
 *   7. 播放前换链：?renew=1 让 /__fnmusic302/health 的 fetched 增长
 */
import { chromium } from 'playwright-core';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';

const BASE = (process.env.BASE || 'http://127.0.0.1:5667').replace(/\/+$/, '');
const HEADLESS = process.env.HEADED !== '1';

// 凭据优先级：环境变量 > test/credentials.json（已 gitignore）
let USER = process.env.FN_USER || '';
let PASS = process.env.FN_PASS || '';
if (!USER || !PASS) {
  try {
    const c = JSON.parse(fs.readFileSync(new URL('./credentials.json', import.meta.url), 'utf8'));
    USER = USER || c.username;
    PASS = PASS || c.password;
  } catch {}
}
if (!USER || !PASS) {
  console.error('缺少飞牛音乐账号：设置 FN_USER / FN_PASS，或创建 test/credentials.json');
  process.exit(2);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function login() {
  const r = await fetch(`${BASE}/music/api/v1/user/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: USER,
      password: sha256(PASS),
      deviceId: crypto.randomUUID().replace(/-/g, ''),
    }),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.data?.userToken) throw new Error(`登录失败: ${JSON.stringify(j)}`);
  return j.data.userToken;
}

const health = async () => (await fetch(`${BASE}/__fnmusic302/health`)).json();

// Node 的 fetch 会自动带 sec-fetch-mode: cors（改不掉），那会走进"拉流"分支。
// 想验证 302 分支必须用 http.request 精确控制请求头。
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: HEADLESS,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// 页面一加载就会预取"上次播放"的曲目；如果库里存在文件缺失的曲目，
// 会先报一次媒体错误（与本项目无关）。所以按阶段区分，只对点播后的错误做断言。
let phase = 'boot';
const consoleErrors = [];
const pageErrors = [];
const responses = [];
const requests = [];

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push({ text: m.text(), phase });
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (res) => {
  const u = res.url();
  if (!/115cdn\.net|track\/stream/.test(u)) return;
  responses.push({ url: u, status: res.status(), headers: res.headers() });
});
page.on('request', (req) => {
  const u = req.url();
  if (!/115cdn\.net|track\/stream/.test(u)) return;
  requests.push({ url: u, range: req.headers()['range'] || '' });
});

// 把播放器 new Audio() 出来的元素收进 window.__audios，便于断言
await page.addInitScript(() => {
  window.__audios = [];
  const Native = window.Audio;
  function Patched(...a) {
    const el = new Native(...a);
    window.__audios.push(el);
    return el;
  }
  Patched.prototype = Native.prototype;
  window.Audio = Patched;
});

try {
  const token = await login();
  await context.addCookies([{ name: 'music-token', value: token, domain: new URL(BASE).hostname, path: '/' }]);
  check('登录并写入 music-token', true, token.slice(0, 8) + '…');

  const before = await health();
  check('health 可访问', before.ok === true, `mode=${before.mode} minTtl=${before.linkMinTtl}`);

  await page.goto(`${BASE}/music/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-cover-playback-state]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  check('页面加载并渲染曲目', true);

  // 点第一首的封面播放（封面 <img> 盖在上层，用 force 跳过可点击性检查，
  // 事件照样冒泡到 [data-cover-playback-state] 的处理器）
  const cover = page.locator('[data-cover-playback-state]').first();
  await cover.scrollIntoViewIfNeeded();
  phase = 'play';
  await cover.click({ force: true });
  await page.waitForTimeout(9000);

  const audio = await page.evaluate(() => {
    const a = (window.__audios || []).filter((x) => x && x.src);
    const el = a[a.length - 1];
    if (!el) return null;
    return {
      crossOrigin: el.crossOrigin,
      paused: el.paused,
      currentTime: +el.currentTime.toFixed(2),
      duration: Math.round(el.duration),
      readyState: el.readyState,
      error: el.error ? el.error.code : null,
      srcHost: (() => { try { return new URL(el.currentSrc || el.src).host; } catch { return ''; } })(),
    };
  });

  check('创建了音频元素', !!audio, audio ? `dur=${audio.duration}s` : '');
  if (audio) {
    check('crossOrigin 已去掉（302 前提）', audio.crossOrigin === null, String(audio.crossOrigin));
    check('音频未暂停', audio.paused === false);
    check('readyState >= 3', audio.readyState >= 3, `readyState=${audio.readyState}`);
    check('无媒体错误', audio.error === null, String(audio.error));
    check('进度在走', audio.currentTime > 1, `currentTime=${audio.currentTime}s`);
  }

  const t1 = audio?.currentTime ?? 0;
  await page.waitForTimeout(3000);
  const t2 = await page.evaluate(() => {
    const a = (window.__audios || []).filter((x) => x && x.src);
    return a.length ? +a[a.length - 1].currentTime.toFixed(2) : 0;
  });
  check('3 秒后进度推进', t2 > t1 + 1, `${t1} → ${t2}`);

  // 302 链路
  const streamRes = responses.filter((r) => /track\/stream/.test(r.url));
  const redirected = streamRes.filter((r) => r.status === 302 && /115cdn\.net/.test(r.headers.location || ''));
  check('track/stream 返回 302 到 115 CDN', redirected.length > 0, `302 次数=${redirected.length}`);

  const cdn = responses.filter((r) => /115cdn\.net/.test(r.url));
  const partial = cdn.filter((r) => r.status === 206);
  check('115 CDN 返回 206', partial.length > 0, `206 次数=${partial.length} / 总 ${cdn.length}`);
  if (partial[0]) {
    const cr = partial[0].headers['content-range'] || '';
    check('Content-Range 正常', /^bytes \d+-\d+\/\d+$/.test(cr), cr);
  }
  check('请求带 Range 头', requests.some((r) => /bytes=/.test(r.range)),
    requests.filter((r) => /bytes=/.test(r.range)).length + ' 条带 Range');

  // 拖动到 150s
  const seekOk = await page.evaluate(() => {
    const a = (window.__audios || []).filter((x) => x && x.src);
    if (!a.length) return false;
    a[a.length - 1].currentTime = 150;
    return true;
  });
  if (seekOk) {
    await page.waitForTimeout(6000);
    const st = await page.evaluate(() => {
      const a = (window.__audios || []).filter((x) => x && x.src);
      const el = a[a.length - 1];
      return { currentTime: +el.currentTime.toFixed(1), paused: el.paused, error: el.error ? el.error.code : null };
    });
    check('拖动后从 150s 继续播放', st.currentTime >= 149 && st.paused === false && st.error === null,
      `currentTime=${st.currentTime}s err=${st.error}`);
  }

  // 播放前换链（?renew=1 走的是同一条 openlistRawUrl 强制刷新路径）
  // 用刚刚真正播过的那首（它一定在 115 上），否则可能拿到库里没上传到 115 的曲目
  const guid = (() => {
    try { return new URL(redirected[0].url).searchParams.get('guid') || ''; } catch { return ''; }
  })();
  if (!guid) {
    check('?renew=1 强制换链', false, '没抓到播放中的 guid');
  } else {
    const h0 = await health();
    const res = await rawGet(`${BASE}/music/api/v1/track/stream?guid=${guid}&renew=1`, {
      cookie: `music-token=${token}`,
      'sec-fetch-mode': 'no-cors',
    });
    const h1 = await health();
    check('?renew=1 强制换链', h1.linkStats.fetched > h0.linkStats.fetched,
      `fetched ${h0.linkStats.fetched} → ${h1.linkStats.fetched}`);
    check('换链后仍是 302', res.status === 302, String(res.status));
    check('302 指向 115 CDN', /^https:\/\/[^/]*115cdn\.net\//.test(res.headers.location || ''),
      (res.headers.location || '').slice(0, 60) + '…');

    // 另一条分支：cors/fetch（WASM 解码）由反代拉流并补 CORS 头
    const corsRes = await rawGet(`${BASE}/music/api/v1/track/stream?guid=${guid}`, {
      cookie: `music-token=${token}`,
      'sec-fetch-mode': 'cors',
      range: 'bytes=0-1023',
    });
    check('cors/fetch 分支拉流', corsRes.status === 206, String(corsRes.status));
    check('拉流补了 CORS 头', corsRes.headers['access-control-allow-origin'] === '*',
      String(corsRes.headers['access-control-allow-origin']));
    check('拉流 Content-Type 正确', /audio\//.test(corsRes.headers['content-type'] || ''),
      String(corsRes.headers['content-type']));

    // 同源 fetch 的 sec-fetch-mode 是 same-origin（不是 cors），也必须拉流，
    // 否则 302 到 115 会被浏览器 CORS 拦掉
    const sameRes = await rawGet(`${BASE}/music/api/v1/track/stream?guid=${guid}`, {
      cookie: `music-token=${token}`,
      'sec-fetch-mode': 'same-origin',
      'sec-fetch-dest': 'empty',
      range: 'bytes=0-1023',
    });
    check('同源 fetch 也走拉流', sameRes.status === 206, String(sameRes.status));

    // 媒体元素请求（audio/no-cors）必须仍然 302，别为了修 fetch 把直链弄没了
    const mediaRes = await rawGet(`${BASE}/music/api/v1/track/stream?guid=${guid}`, {
      cookie: `music-token=${token}`,
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'audio',
    });
    check('媒体元素仍是 302', mediaRes.status === 302, String(mediaRes.status));
  }

  const corsErrs = consoleErrors.filter((e) => /CORS|Access-Control/i.test(e.text));
  check('无 CORS 报错', corsErrs.length === 0, corsErrs.slice(0, 2).map((e) => e.text).join(' | '));

  const playErrs = consoleErrors.filter((e) => e.phase === 'play' && /Audio error|Playback error|DEMUXER|MEDIA_ERR/i.test(e.text));
  check('点播曲目无媒体错误', playErrs.length === 0, playErrs.slice(0, 1).map((e) => e.text.slice(0, 80)).join(''));

  check('无页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  const bootErrs = consoleErrors.filter((e) => e.phase === 'boot' && /Audio error|Playback error|DEMUXER|MEDIA_ERR/i.test(e.text));
  if (bootErrs.length) {
    console.log(`\n⚠️  页面加载阶段有 ${bootErrs.length} 条媒体错误（预取到库里文件缺失的曲目，与本反代无关）：`);
    console.log('   ' + bootErrs[0].text.slice(0, 120));
  }
} catch (e) {
  check('测试执行', false, e.message);
  await page.screenshot({ path: 'test/failure.png' }).catch(() => {});
  console.error(e);
} finally {
  await context.close();
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
