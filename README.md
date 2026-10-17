# fnmusic-302

飞牛音乐（fnOS Music）→ OpenList → 115 网盘 **302 直链播放**反代。

```
浏览器 ──► fnmusic-302 :5667 ──► 飞牛音乐 :5666   （登录 / 列表 / 封面等 API）
                │
                └─ /track/stream?guid=xxx
                      ├─ 查 fnMusic metadata 得到本地路径
                      ├─ 映射成 115 路径 → 向 OpenList 换签名直链
                      └─ 302 ──► cdnfhnfile.115cdn.net（浏览器直连，不占 NAS 带宽）
```

## 为什么不能“纯 302”

实测飞牛音乐前端取音频有两种方式，**都要求 CORS**：

| 请求 | 发起方 | 模式 |
|---|---|---|
| `track/stream` | `<audio>` 元素（`crossOrigin="anonymous"`） | CORS |
| `track/stream` + Range 0-1MB | `fetch()`（WASM 解码 / 元数据分片） | CORS |

而 115 CDN 的响应**没有任何 `Access-Control-Allow-Origin`**，`OPTIONS` 直接 403。实测：

- 带 `crossOrigin="anonymous"` 的 `<audio>` 加载 115 直链 → 永远 `readyState=0`
- 普通 `<audio>`（不带 CORS）→ 正常播放
- `fetch` + Range → `TypeError: Failed to fetch`

所以本项目在反代里给播放器 JS 打两个补丁：

1. 去掉 `createAudioElement()` 里的 `crossOrigin="anonymous"`
2. 把 `usesDirectMediaOutput` 强制为 `true`（媒体直出，不接 Web Audio，避免跨域媒体被静音）

补丁后 `<audio>` 变成 no-cors 请求，302 才能成立。启动时会自检补丁锚点，飞牛音乐升级导致锚点消失时**自动回退到 stream 模式**（不 302，但播放正常）。

## 直链过期与“只在播放时刷新”

115 的签名直链带 `t=<过期时间戳>`，约 **40 分钟**失效。本项目**没有任何后台定时器**，不会闲着去换链，全部刷新都发生在播放请求到达的那一刻：

```
播放请求到达 ──► 缓存里剩余寿命 > linkMinTtl ?
                 ├─ 是 → 直接 302（0 次 OpenList 调用）
                 └─ 否 → 现在换一条新链，再 302
```

三层保护：

| 场景 | 行为 |
|---|---|
| 距上次换链 < 40 分钟，缓存充足 | 直接复用，不碰 OpenList |
| 缓存剩余 < `linkMinTtl`（默认 600s） | **播放前**换链，保证这次播放至少还有 10 分钟 |
| 换链后剩余寿命仍撑不完这首（+120s） | `directGuard` 生效，本次改走拉流，服务端可在播放途中续链 |
| 拉流途中 115 返回 403/401（过期） | 自动换链，**用同一个 `Range` 重放**，浏览器完全无感 |
| 同一首歌并发多个 Range / prefetch | 共用一次换链（in-flight 去重），不会打爆 OpenList |

要点：

- **零后台刷新**：不播放就不换链，不浪费 115 的取链配额，也不会因为定时任务让链接在播放中途“被换掉”。
- **播放前刷新是同步的**：`openlistRawUrl()` 在返回 302 之前完成换链，所以浏览器拿到的第一条链一定还有 ≥ `linkMinTtl` 的寿命。
- 想立刻强制换链：在 stream URL 后加 `&renew=1`，或 `curl http://127.0.0.1:5667/__fnmusic302/refresh` 清缓存（下次播放时换）。
- `direct`（302）模式下，浏览器是直连 115 的，反代无法介入已建立的播放；只要**开始播放时**链是新的，一首歌的时长基本都在寿命内。真正需要“播放途中续链”的只有超长音频，用 `mode: "stream"` 或让 `directGuard` 自动接管即可。

## 快速开始

```bash
# 需要 Node >= 18，无第三方依赖
node server.mjs
# 打开 http://<运行本服务的机器IP>:5667/music/
```

首次访问用飞牛音乐账号登录即可（登录、Cookie 全部透传）。

## 配置

编辑 `config.json`（或全部用环境变量覆盖）：

```json
{
  "port": 5667,
  "listen": "0.0.0.0",
  "upstream": "http://192.168.0.108:5666",
  "openlist": {
    "url": "http://192.168.0.108:5244",
    "username": "mario",
    "password": "CHANGE_ME"
  },
  "pathMaps": [
    { "from": "/vol1/1000/音乐库/115音乐库/", "to": "/115网盘/音乐库/" }
  ],
  "mode": "direct",
  "patchPlayer": true,
  "linkMinTtl": 600,
  "directGuard": true,
  "log": true
}
```

| 字段 | 说明 |
|---|---|
| `upstream` | 飞牛音乐地址。反代和它同机时可用 `http://127.0.0.1:5666` |
| `openlist.url` | OpenList 地址 |
| `openlist.username/password` | OpenList 账号（需要能读 115 挂载） |
| `pathMaps` | 飞牛音乐扫描到的**本地路径前缀** → OpenList 里的 **115 路径前缀**，按最长前缀匹配 |
| `mode` | `direct`：能映射就 302；`stream`：不 302，由本服务从 115 拉流并补 CORS |
| `patchPlayer` | 是否给播放器 JS 打补丁。`direct` 模式必须为 `true` |
| `linkMinTtl` | 直链剩余寿命低于该秒数时，在**播放请求到达时**换链（默认 600） |
| `directGuard` | 换链后仍撑不完本曲时，该次请求改走拉流以便播放途中续链（默认 `true`） |

环境变量：`PORT`、`LISTEN`、`UPSTREAM`、`OPENLIST_URL`、`OPENLIST_USER`、`OPENLIST_PASS`、`MODE`、`PATCH_PLAYER`、`LINK_MIN_TTL`、`DIRECT_GUARD`、`CONFIG`。

### 怎么确认 pathMaps 配对了

任选一首歌，直接问飞牛音乐：

```bash
curl -s "http://192.168.0.108:5666/music/api/v1/track/metadata?guid=<guid>" \
  -H "Cookie: music-token=<你的token>" | python3 -m json.tool
```

返回里的 `data.audioSpec.path` 就是本地路径，例如：

```
/vol1/1000/音乐库/115音乐库/刘瑞琦/刘瑞琦毕业音乐会精选版/房间 (Live) - 刘瑞琦.flac
```

把 `/vol1/1000/音乐库/115音乐库/` 映射到 OpenList 的 `/115网盘/音乐库/` 即可。

## 验证

```bash
# 健康检查（含每条直链的剩余寿命和换链统计）
curl -s http://127.0.0.1:5667/__fnmusic302/health
# → linkDetails: [{ path, remaining: 1933, age: 7 }], linkStats: { fetched, reused, refreshedOnPlay, expiredRetry, failed }

# 应该返回 302 + Location: https://cdnfhnfile.115cdn.net/...
curl -sD - -o /dev/null \
  "http://127.0.0.1:5667/music/api/v1/track/stream?guid=<guid>" \
  -H "Cookie: music-token=<token>" \
  -H "Sec-Fetch-Mode: no-cors"

# 强制换链（验证“播放时刷新”）
curl -sD - -o /dev/null \
  "http://127.0.0.1:5667/music/api/v1/track/stream?guid=<guid>&renew=1" \
  -H "Cookie: music-token=<token>"
# 日志里应出现：[link] 换链成功，有效期 33xx s ...
```

连续播放同一首歌两次，`linkStats.fetched` 只 +1、`reused` +1，说明缓存命中、没有多余换链；
把 `LINK_MIN_TTL` 调到 99999 再播一次，日志会出现
`[link] 播放前换链：剩余 3281s < 阈值 99999s`，随后 `换链成功`。

浏览器 DevTools → Network 过滤 `stream`：应看到
`track/stream` → `302` → `cdnfhnfile.115cdn.net` → `206`。
播放时进度条正常走、可拖动，说明直链和 Range 都通了。

### 自动化测试（Playwright）

`test/playback.mjs` 用 Playwright **自己拉起一个 headless Chrome**（独立临时 profile，
不连接本机正在使用的 Chrome，也不碰 9222 调试端口），跑一遍真实播放链路：

```bash
npm install          # 只装 playwright-core（devDependency，不下载浏览器，用系统 Chrome）

# 首次运行：给个账号（文件已 gitignore，也可用环境变量）
echo '{"username":"你的飞牛音乐账号","password":"你的密码"}' > test/credentials.json

npm test             # 等价于 node test/playback.mjs
BASE=http://192.168.0.108:5667 npm test   # 测 NAS 上的实例
HEADED=1 npm test    # 想看着它点
FN_USER=xxx FN_PASS=xxx npm test          # 用环境变量代替 credentials.json
```

24 项断言，全部基于真实浏览器行为：

| 断言 | 说明 |
|---|---|
| `crossOrigin === null` | 播放器补丁生效，302 才可能成功 |
| `readyState >= 3` / 无 error / 进度推进 | 真的在出声，不是假死 |
| `track/stream` → 302 → 115 `206` | 直链链路成立 |
| `Content-Range` 格式 | Range 透传正确 |
| 拖到 150s 继续播 | seek 后重新发 Range 也正常 |
| `?renew=1` → 302 且 `fetched` +1 | 播放前换链生效 |
| `sec-fetch-mode: cors` → 206 + `ACAO: *` | WASM/fetch 分支由反代补 CORS |
| 0 条 CORS 报错 / 0 条页面异常 | 没有隐藏的前端错误 |
| 点播曲目播放期间 0 条媒体错误 | 只断言我们点的那首；页面加载时预取到的“库里文件缺失”曲目会单独提示，不算失败 |

> 测试会真的播一首歌，服务端日志里能看到对应的 `[link] 换链成功` / `[stream] 302`。

## 部署到飞牛 NAS（Docker）

容器端口 **8666**（`docker-compose.yml` 里 `8666:8666`）。

### 方式一：用 CI 构建好的镜像

```bash
docker pull ghcr.io/jinsfoni/fnmusic-302:1.0.0
docker run -d --name fnmusic-302 --restart unless-stopped \
  -p 8666:8666 \
  -e UPSTREAM=http://192.168.0.108:5666 \
  -e OPENLIST_URL=http://192.168.0.108:5244 \
  -e OPENLIST_USER=mario -e OPENLIST_PASS=CHANGE_ME \
  ghcr.io/jinsfoni/fnmusic-302:1.0.0
# 访问 http://192.168.0.108:8666/music/
```

### 方式二：本机构建

```bash
cp .env.example .env      # 填 OPENLIST_USER / OPENLIST_PASS
docker compose up -d --build
# 访问 http://192.168.0.108:8666/music/
```

或直接：

```bash
docker build -t fnmusic-302 .
docker run -d --name fnmusic-302 --restart unless-stopped \
  -p 8666:8666 \
  -e UPSTREAM=http://192.168.0.108:5666 \
  -e OPENLIST_URL=http://192.168.0.108:5244 \
  -e OPENLIST_USER=mario -e OPENLIST_PASS=CHANGE_ME \
  fnmusic-302
```

> 如果容器用 `network_mode: host`，`UPSTREAM` 和 `OPENLIST_URL` 可以写 `127.0.0.1`。

### 镜像自动构建

`.github/workflows/docker-release.yml` **只在发布 release 时**触发（普通 push 不构建）：

```
发布 v1.0.0  ──►  GitHub Actions  ──►  ghcr.io/jinsfoni/fnmusic-302:1.0.0 / 1.0 / 1 / latest
```

- 触发条件：`on: release: types: [published]`
- 多架构：`linux/amd64` + `linux/arm64`
- 标签由 release tag 自动推导（semver），预发布版本不会覆盖 `latest`
- 用仓库自带的 `GITHUB_TOKEN` 推送，无需额外 secret

## 已知限制

- **115 直链约 40 分钟过期**。播放前会自动换链（剩余 < `linkMinTtl` 时），所以每次开始播放拿到的链至少还有 10 分钟；单曲一般远短于此，不会中途失效。若一首超长音频跨过过期点，`directGuard` 会改走拉流并在 403 时自动续链；`direct` 模式下若已暂停超过半小时再拖动进度条，可能 403，重选一次该曲目即可。
- **direct 模式会关闭均衡器/频谱**：为了绕过 Web Audio 的跨域限制，媒体是直出的，`AudioContext` 不再接管音频。音量、播放、拖动都正常。
- **APE / DSF / TTA 等浏览器不原生支持的格式**不会 302：播放器会用 `fetch` 全量下载 + WASM 解码，这类请求由反代拉流并补 CORS（走 NAS 中转，但仍直连 115，不经过 CD2）。
- **cue 整轨**会回退到透传，避免 302 后从整轨 0 秒开始播。
- 飞牛音乐升级后若补丁锚点变化，启动自检会回退 `stream` 模式；此时仍可用，只是不再 302。
- `config.json` 里有 OpenList 密码，已被 `.gitignore` 忽略，**不要把 8666 端口暴露到公网**。

## 文件

- `server.mjs`：全部逻辑（反代 + 302 + 补丁 + 自检），单文件无依赖
- `test/playback.mjs`：Playwright 端到端播放测试（自带 headless Chrome）
- `config.json`：本机配置（含凭据，勿提交）
- `config.example.json`：配置模板
- `Dockerfile` / `docker-compose.yml` / `.env.example`：NAS 部署（容器端口 8666）
- `.github/workflows/docker-release.yml`：发布 release 时自动构建并推送镜像到 GHCR
