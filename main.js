// ============================================================
// main.js — 앱의 "뒤편" (Electron 메인 프로세스)
// ============================================================
// 맥북 노치 양옆에 작게 붙어 있다가, 마우스를 올리거나 곡이 바뀌면 아래로 펼쳐지는 음악 위젯.
// 음악 플랫폼은 설정에서 골라요: Spotify(이 파일) / Apple Music / YouTube Music / YouTube / 멜론 (players/ 폴더)
//
// 이 파일이 하는 일
//   1. Spotify 로그인 (브라우저로 로그인 → 토큰을 받아 저장)
//   2. 1.5초마다 "지금 뭐 재생 중?"을 Spotify 에 물어봄 (폴링)
//   3. 곡이 바뀌면 앨범커버 대표 색, 좋아요 여부, 가사를 구해서 화면에 보냄
//   4. 재생/일시정지/이전/다음/좋아요 버튼 요청을 Spotify 에 전달
//   5. 노치 자리에 투명 창을 만들고, 접혀 있을 땐 클릭이 뒤로 통과하게 함
//   6. 제스처(손짓) 이름을 받아서 장르 플레이리스트를 틀거나 재생 조작 — 웹캠 화면에서도, 외부 프로그램(파이썬/라즈베리파이)에서도
//   7. Spotify 가 아닌 플랫폼은 players/*.js 에 맡김 — 모두 now() / control() / playGenre() 세 가지만 있으면 됨
//
// 화면(notch.html)과는 preload.js 를 통해 메시지를 주고받아요.
//   main → 화면 : broadcast('track', 곡정보)   → 화면의 api.on('track', ...)
//   화면 → main : api.send('control', 'next') → 여기의 ipcMain.on('control', ...)
//
// 읽는 순서 추천: 맨 아래 "시작" → "재생 정보 폴링" → "노치 창" → 나머지
// ============================================================
const { app, BrowserWindow, ipcMain, screen, shell, Menu, nativeImage, systemPreferences, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

// 이름을 Spotify Notch → Snaptune 으로 바꾸면서 저장 폴더도 바뀜 (…/spotify-notch → …/snaptune)
// 예전 폴더가 있으면 처음 켤 때 한 번 옮겨 와요 (로그인 · 설정 · 기록 · 학습한 동작 그대로)
(function moveOldData() {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'spotify-notch');
  if (now === old || !fs.existsSync(old) || fs.existsSync(path.join(now, 'settings.json'))) return;
  try {
    if (!fs.existsSync(now)) fs.renameSync(old, now);
    else fs.cpSync(old, now, { recursive: true, force: false, errorOnExist: false });
    console.log(`[이름 변경] 예전 데이터를 옮겼어요: ${old} → ${now}`);
  } catch (e) {
    console.error('예전 데이터를 못 옮겼어요:', e.message);
  }
})();

// Spotify 대시보드의 Redirect URI 에 똑같이 등록해야 함
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state', // 재생/일시정지/이전/다음
  'user-library-read', // 좋아요 여부 확인
  'user-library-modify', // 좋아요 누르기/취소
];
// 있으면 좋은 권한: 내 비공개 플레이리스트 목록 (없어도 앱은 돌아가고, 공개 플리만 보여요)
// 예전 토큰에 없다고 강제로 다시 로그인시키지 않으려고 SCOPES 와 따로 둠
const EXTRA_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];

const POLL_MS = 1500;
// 노치 아래로 펼쳐지는 카드 크기 (notch.html 과 같게)
const NOTCH_DEFAULT_W = 190; // 노치 너비 추정값 (config.json 의 notchWidth 로 바꿀 수 있음)
const NOTCH_PAD = 30; // 창 양옆 여백
const NOTCH_PANEL_W = 360;
const NOTCH_CARD_H = 380;

let notchWin = null;
let tokens = null; // { access_token, refresh_token, expires_at, scope }
let status = 'logged-out'; // no-client-id | logged-out | relogin | logging-in | ok
let currentTrack = null;
let lastTrackId = null;
let pollTimer = null;
let polling = false;

// 곡별로 한 번만 계산/요청하도록 기억해 둠
const accentCache = new Map(); // 이미지 URL → 색
const likedCache = new Map(); // 트랙 URI → true/false
const lyricsCache = new Map(); // 트랙 id → 가사 줄 배열 또는 null

const tokenFile = () => path.join(app.getPath('userData'), 'tokens.json');

/* ============================================================
   음악 플랫폼
   ============================================================
   Spotify 는 이 파일에서 직접 하고, 나머지는 players/ 의 파일이 맡아요.
   player 는 전부 같은 모양이에요:
     await player.now()             → 지금 곡 { id, title, artist, album, image, isPlaying, progress, duration, liked, context } 또는 null
     await player.control('next')   → 재생 조작 (안내할 말이 있으면 글자를 돌려줌)
     await player.playGenre(장르)   → 틀었으면 { context, label }, 못 틀면 null
   새 플랫폼을 넣으려면: players/ 에 파일을 만들고 아래 두 목록에 한 줄씩 추가. */
const { createApple } = require('./players/apple');
const { createYouTube } = require('./players/youtube');
const { createMelon } = require('./players/melon');

const PLATFORMS = { spotify: 'Spotify', apple: 'Apple Music', ytmusic: 'YouTube Music', youtube: 'YouTube', melon: '멜론' };
const players = {
  apple: createApple(),
  ytmusic: createYouTube({ music: true }),
  youtube: createYouTube(),
  melon: createMelon(),
};

// active = 지금 조작하는 플랫폼. 보통은 설정에서 고른 것(platform())과 같지만,
// 그 플랫폼이 장르를 못 틀어서 유튜브로 대신 틀었을 땐 'youtube' 가 돼요.
let active = 'spotify';
const platform = () => settings?.platform || 'spotify';
const canUse = () => active !== 'spotify' || !!tokens; // Spotify 만 로그인이 필요
const platformInfo = () => ({ id: active, name: PLATFORMS[active], chosen: platform() });

function setActive(next) {
  if (next === active) return;
  if (active !== 'spotify') players[active].stop(); // 두 군데서 동시에 소리 나지 않게
  active = next;
  lastTrackId = null;
  broadcast('platform', platformInfo());
}

// 설정에서 플랫폼을 고르면(또는 앱을 켜면) 그 플랫폼으로 준비
function applyPlatform() {
  stopPolling();
  if (active !== 'spotify' && active !== platform()) players[active].stop();
  active = platform();
  currentTrack = null;
  lastTrackId = null;
  currentGenre = genreContext = null;
  broadcast('track', null);
  broadcast('lyrics', null);
  broadcast('genre', null);
  broadcast('platform', platformInfo());
  if (firstRun) return setStatus('choose-platform'); // 처음 켬: 노치에서 음악 앱을 고르면 그걸로 시작
  if (active === 'spotify') return startSpotify();
  setStatus('ok'); // 다른 플랫폼은 로그인 화면이 필요 없음
  startPolling();
}

// Spotify: 저장된 토큰이 있으면 바로 연결, 없으면 로그인 안내
function startSpotify() {
  if (!loadClientId()) return setStatus('no-client-id');
  if (!tokens) {
    try {
      tokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    } catch {
      tokens = null;
    }
  }
  if (tokens?.refresh_token && !hasAllScopes(tokens)) {
    tokens = null;
    setStatus('relogin');
  } else if (tokens?.refresh_token) {
    setStatus('ok');
    startPolling();
  } else {
    tokens = null;
    setStatus('logged-out');
  }
}

// 설정 = 앱 안의 config.json + (있으면) userData 폴더의 config.json 으로 덮어쓰기
// .app 으로 묶으면 앱 안 파일은 고치기 어려워서, 바꾸고 싶은 값만 userData 쪽에 적으면 돼요.
//   ~/Library/Application Support/snaptune/config.json   예) { "pi": "ubuntu@192.168.0.10" }
function loadConfig() {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return { ...read(path.join(__dirname, 'config.json')), ...read(path.join(app.getPath('userData'), 'config.json')) };
}

function loadClientId() {
  if (process.env.SPOTIFY_CLIENT_ID) return process.env.SPOTIFY_CLIENT_ID.trim();
  return (loadConfig().clientId || '').trim();
}

function broadcast(channel, data) {
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send(channel, data);
}

function setStatus(s) {
  status = s;
  broadcast('status', s);
}

/* ============================================================
   인증 (Spotify 로그인)
   ============================================================
   PKCE 방식: Client Secret 없이 로그인하는 방법이에요.
   1) 무작위 비밀값(verifier)을 만들고, 그걸 해시한 값(challenge)만 Spotify 로그인 주소에 실어 브라우저를 엶
   2) 사용자가 허용하면 Spotify 가 http://127.0.0.1:8888/callback?code=... 로 돌려보냄
   3) 우리가 잠깐 열어둔 작은 서버가 code 를 받고, verifier 와 함께 토큰으로 바꿈
   4) 토큰은 userData 폴더의 tokens.json 에 저장 → 다음 실행부터 바로 연결
   access_token 은 1시간짜리라서, 만료되면 refresh_token 으로 새로 받아요. */

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function requestToken(params) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const err = new Error(`token ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || tokens?.refresh_token,
    expires_at: Date.now() + (j.expires_in - 60) * 1000,
    scope: j.scope || tokens?.scope || '',
  };
  fs.writeFileSync(tokenFile(), JSON.stringify(tokens));
}

// 예전 버전에서 로그인한 토큰에는 재생 조작/좋아요 권한이 없음
const hasAllScopes = (t) => SCOPES.every((s) => (t?.scope || '').split(' ').includes(s));

function refreshToken() {
  return requestToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: loadClientId(),
  });
}

function login() {
  const clientId = loadClientId();
  if (!clientId) return setStatus('no-client-id');
  if (status === 'logging-in') return;
  setStatus('logging-in');

  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      return res.end();
    }
    const code = url.searchParams.get('code');
    const ok = code && url.searchParams.get('state') === state;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<body style="font-family:sans-serif;background:#121212;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
        <h2>${ok ? '✅ 로그인 완료! 이 탭은 닫아도 돼요.' : '❌ 로그인 실패. 위젯에서 다시 시도해 주세요.'}</h2></body>`
    );
    finish();
    if (!ok) return setStatus('logged-out');
    try {
      await requestToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      });
      if (platform() !== 'spotify') return; // 로그인하는 사이에 다른 플랫폼으로 바꿨음
      setStatus('ok');
      startPolling();
    } catch (e) {
      console.error(e);
      setStatus('logged-out');
    }
  });

  // 5분 안에 로그인 안 하면 포기
  const timeout = setTimeout(() => {
    finish();
    if (status === 'logging-in') setStatus('logged-out');
  }, 5 * 60 * 1000);

  function finish() {
    clearTimeout(timeout);
    server.close();
  }

  server.on('error', (e) => {
    console.error('콜백 서버 오류:', e.message);
    finish();
    setStatus('logged-out');
  });

  server.listen(REDIRECT_PORT, '127.0.0.1', () => {
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: [...SCOPES, ...EXTRA_SCOPES].join(' '),
      state,
    });
    shell.openExternal(`https://accounts.spotify.com/authorize?${q}`);
  });
}

function logout() {
  stopPolling();
  tokens = null;
  currentTrack = null;
  lastTrackId = null;
  try { fs.unlinkSync(tokenFile()); } catch {}
  broadcast('track', null);
  broadcast('lyrics', null);
  setStatus(loadClientId() ? 'logged-out' : 'no-client-id');
}

/* ============================================================
   Spotify API 호출 도우미
   ============================================================
   토큰이 만료됐으면 새로 받고, 401(인증 실패)이 오면 한 번 더 시도해요. */

async function spotifyApi(method, pathname, body) {
  if (Date.now() >= tokens.expires_at) await refreshToken();
  const call = () =>
    fetch(`https://api.spotify.com/v1${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
  let res = await call();
  if (res.status === 401) {
    await refreshToken();
    res = await call();
  }
  return res;
}

/* ============================================================
   앨범커버 대표 색
   ============================================================
   커버를 32x32 로 줄인 뒤 픽셀을 훑어서 "채도는 높고 너무 어둡거나 밝지 않은" 색을 고름.
   이 색이 화면의 --accent 가 되어 이퀄라이저, 진행바, 하트 색이 곡마다 바뀌어요. */

// 커버를 작게 줄여서 채도 높고 너무 어둡거나 밝지 않은 색을 고름
async function accentOf(url) {
  if (!url) return null;
  if (accentCache.has(url)) return accentCache.get(url);
  let color = null;
  try {
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const img = nativeImage.createFromBuffer(buf).resize({ width: 32, height: 32 });
    const px = img.toBitmap(); // BGRA
    if (!px.length) throw new Error('이미지를 읽지 못함');
    let best = null;
    let bestScore = -1;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const B = px[i], G = px[i + 1], R = px[i + 2];
      r += R; g += G; b += B; n++;
      const max = Math.max(R, G, B), min = Math.min(R, G, B);
      const light = (max + min) / 2 / 255;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (light < 0.15 || light > 0.9) continue;
      const score = sat * (1 - Math.abs(light - 0.55));
      if (score > bestScore) { bestScore = score; best = [R, G, B]; }
    }
    // 무채색 커버면 평균색 사용
    color = bestScore > 0.15 ? best : [r / n, g / n, b / n];
    color = brighten(color);
  } catch (e) {
    console.error('색 추출 실패:', e.message);
  }
  accentCache.set(url, color);
  return color;
}

// 어두운 배경 위에서도 잘 보이도록 명도를 끌어올림
function brighten([r, g, b]) {
  const max = Math.max(r, g, b, 1);
  const k = max < 190 ? 190 / max : 1;
  return `rgb(${[r, g, b].map((v) => Math.min(255, Math.round(v * k))).join(',')})`;
}

/* ============================================================
   좋아요 (내 라이브러리에 저장)
   ============================================================
   2026년 2월부터 Spotify 가 /me/library 하나로 통합했어요. 곡을 id 대신 uri(spotify:track:...)로 넘겨요. */

async function fetchLiked(uri) {
  if (!uri?.startsWith('spotify:track:')) return null;
  if (likedCache.has(uri)) return likedCache.get(uri);
  let liked = null; // 실패해도 기억해서 1.5초마다 다시 요청하지 않음
  try {
    const res = await spotifyApi('GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`);
    if (!res.ok) throw new Error(`contains ${res.status}`);
    liked = !!(await res.json())[0];
  } catch (e) {
    console.error('좋아요 확인 실패:', e.message);
  }
  likedCache.set(uri, liked);
  return liked;
}

async function toggleLike() {
  const t = currentTrack;
  if (!t?.uri?.startsWith('spotify:track:') || t.liked == null) return;
  const next = !t.liked;
  const res = await spotifyApi(next ? 'PUT' : 'DELETE', `/me/library?uris=${encodeURIComponent(t.uri)}`);
  if (!res.ok) {
    console.error('좋아요 변경 실패:', res.status, await res.text());
    return notice('좋아요를 바꾸지 못했어요');
  }
  likedCache.set(t.uri, next);
  if (next && session) session.liked = true; // 보상: 틀어 준 걸 좋아요 함
  if (currentTrack?.uri === t.uri) {
    currentTrack.liked = next;
    broadcast('track', currentTrack);
  }
}

/* ============================================================
   재생 조작 (재생/일시정지/이전/다음)
   ============================================================
   Spotify Premium 계정에서만 돼요. 무료 계정이면 403 이 와서 안내 문구를 띄워요. */

const CONTROLS = {
  play: ['PUT', '/me/player/play'],
  pause: ['PUT', '/me/player/pause'],
  next: ['POST', '/me/player/next'],
  previous: ['POST', '/me/player/previous'],
};

/* Spotify 맥 앱 직접 조작 (AppleScript)
   Web API 재생 조작은 Premium 전용이라 무료 계정은 403 이 와요. 그런데 이 맥에서 Spotify 앱이 켜져 있으면
   앱에게 직접 시키는 건 무료 계정도 돼요 → API 가 막히면 이걸로 대신 함. 앱이 꺼져 있으면 null. */
function spotifyApp(cmd) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', `if application "Spotify" is running then
      tell application "Spotify"
        ${cmd}
      end tell
      return "ok"
    end if
    return "off"`], { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim() === 'off' ? null : out.trim()));
  });
}
const APP_CMD = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', previous: 'previous track' };

async function control(action) {
  // 'toggle' 은 지금 상태를 보고 play / pause 중 하나로 바꿈 (제스처 하나로 재생/정지)
  // 멜론처럼 지금 상태를 모르는 플랫폼은 ⏯ 하나로 (상태를 짐작해서 틀리게 누르지 않게)
  if (action === 'toggle' && !(active !== 'spotify' && players[active].nativeToggle)) action = currentTrack?.isPlaying ? 'pause' : 'play';
  // 어느 플랫폼이든 (장르 재생과 같은 길). DJ 가 틀고 있을 때 "알아서 틀기" = 다른 장르로 다시 골라 줘
  if (action === 'auto') return settings.mode === 'dj' && djOwns() ? djPick('다른 장르로', { exclude: currentGenre, byUser: true }) : playAuto();
  if (action === 'other_playlist') return otherPlaylist();
  // Spotify 가 아니면 그 플랫폼 담당(players/)에게 넘김
  if (active !== 'spotify') {
    if (action === 'next') countSkip();
    try {
      const say = await players[active].control(action);
      if (action === 'like' && session && !/못|안 돼|로그인|뺐/.test(say || '')) session.liked = true; // 보상: 좋아요
      if (action === 'volume_up' && session && !/못/.test(say || '')) session.volUp = true;
      if (say) notice(say);
    } catch (e) {
      console.error(e.message);
      notice('조작에 실패했어요');
    }
    return pollSoon();
  }
  if (!tokens) return;
  if (action === 'like') return toggleLike().catch((e) => console.error(e.message));
  if (action === 'volume_up') return changeVolume(+VOLUME_STEP);
  if (action === 'volume_down') return changeVolume(-VOLUME_STEP);
  let request = CONTROLS[action];
  if (!request) return;
  if (action === 'next') countSkip();
  // 이전: 5초 넘게 들었으면 이 곡 처음으로 (Spotify 앱의 ⏮ 버튼과 같게)
  if (action === 'previous' && currentTrack?.progress > 5000) request = ['PUT', '/me/player/seek?position_ms=0'];
  try {
    const res = await spotifyApi(...request);
    if (res.status === 403 || res.status === 404) {
      // 무료 계정(403)이거나 재생 기기를 못 찾으면(404) → 이 맥의 Spotify 앱에 직접
      const cmd = request[1].includes('seek') ? 'set player position to 0' : APP_CMD[action];
      if (await spotifyApp(cmd)) return pollSoon();
      notice(res.status === 403 ? '무료 계정은 맥의 Spotify 앱이 켜져 있어야 조작돼요' : '재생 중인 기기를 찾지 못했어요');
    } else if (!res.ok) notice('조작에 실패했어요');
  } catch (e) {
    console.error(e.message);
    notice('조작에 실패했어요');
  }
  pollSoon();
}

// 볼륨: 지금 기기의 볼륨을 읽어서 delta 만큼 더함 (0~100)
const VOLUME_STEP = 10;
async function changeVolume(delta) {
  try {
    // 무료 계정·볼륨 못 바꾸는 기기 → 이 맥의 Spotify 앱 볼륨으로
    const appVolume = async () => {
      if ((await spotifyApp(`set sound volume to ((sound volume) + (${delta}))`)) === null) return false;
      notice(`Spotify 앱 볼륨 ${delta > 0 ? '+' : '−'}${Math.abs(delta)}`);
      if (delta > 0 && session) session.volUp = true;
      return true;
    };
    const res = await spotifyApi('GET', '/me/player');
    if (res.status !== 200) return (await appVolume()) || notice('재생 중인 기기를 찾지 못했어요');
    const device = (await res.json()).device;
    if (!device?.supports_volume) return (await appVolume()) || notice('이 기기는 볼륨 조절이 안 돼요');
    const v = Math.max(0, Math.min(100, device.volume_percent + delta));
    const r = await spotifyApi('PUT', `/me/player/volume?volume_percent=${v}`);
    if (r.status === 403) return (await appVolume()) || notice('볼륨 조절은 Spotify Premium에서만 돼요');
    notice(r.ok ? `볼륨 ${v}%` : '볼륨을 바꾸지 못했어요');
    if (r.ok && delta > 0 && session) session.volUp = true; // 보상: 볼륨을 올림
  } catch (e) {
    console.error(e.message);
    notice('볼륨을 바꾸지 못했어요');
  }
}

function notice(text) {
  if (notchWin && !notchWin.isDestroyed()) notchWin.webContents.send('notice', text);
}

/* ============================================================
   제스처 → 장르 재생 / 재생 조작
   ============================================================
   제스처를 "누가 인식했든" 전부 handleGesture('이름') 하나로 모여요.
     - 노치 화면의 웹캠 인식기 (gestures.js)  → ipcMain.on('gesture')
     - 외부 프로그램 (파이썬, 라즈베리파이 등) → 아래 HTTP 서버 POST /gesture
     - 우클릭 메뉴 "제스처 테스트" / 설정 화면 "시험" 버튼

   설정(우클릭 → 설정…)에는 목록이 두 개 있고, userData 의 settings.json 에 저장돼요.
     genres   : [{ genre: '락', gesture: 'rock', query: 'rock' }]
                → 그 제스처가 오면 query 로 Spotify 플레이리스트를 검색해서 하나를 틀어요 (기획서 1·3번)
                { genre: '내 노동요', gesture: 'peace', playlist: { uri, name, tracks } }
                → 검색 대신 "내 플레이리스트"를 무작위 곡부터 틀어요 (Spotify 만. 다른 플랫폼은 이름으로 검색)
     controls : [{ gesture: 'swipe_right', action: 'next' }]
                → 다음 곡, 볼륨 같은 재생 조작 (기획서 2번)

   제스처 이름은 라즈베리파이에서 scikit-learn 으로 학습시킨 동작 이름이에요 (pi/README.md).
     파이 대시보드에서 'rock' 이라는 이름으로 동작을 녹화·학습하면 → 여기 'rock' 과 이어져요.
   swipe_* 는 파이가 손바닥 이동으로 따로 알아채는 이름이라 학습이 필요 없어요.

   좌우는 "화면에 보이는 방향" 기준이에요. 웹캠 화면을 거울처럼 뒤집어 보여주기 때문에
   내가 오른쪽으로 손을 흔들면 화면에서도 오른쪽 → swipe_right. */

// 재생 조작 종류 → 설정 화면과 노치에 보이는 이름
const CONTROL_ACTIONS = {
  next: '다음 곡',
  previous: '이전 곡',
  toggle: '재생 / 일시정지',
  play: '재생',
  pause: '일시정지',
  volume_up: '볼륨 +',
  volume_down: '볼륨 −',
  like: '좋아요',
  other_playlist: '같은 장르 다른 플리', // 지금 장르는 그대로, 플리만 바꾸기
  auto: '알아서 틀기', // 상황 엔진: 지금 상황(시간·요일·날씨·워치)과 배운 기록으로 장르를 골라 틀기
};

// 모드 (우클릭 메뉴 · 설정 맨 위에서 바꿈)
//   보통   : 제스처로 바로 조작
//   인식만 : 제스처를 알아보기만 하고 조작은 안 함 → 노치에 "인식만 · 다음 곡"처럼 뭘 했을지만 보여줌 (연습 · 발표 중)
//   DJ     : 상황 엔진이 고른 장르만 계속 틀어요 (아래 "DJ 모드")
const MODES = { normal: '보통', watch: '인식만', dj: 'DJ' };
const MODE_HELP = { normal: '제스처로 바로 조작', watch: '제스처를 알아보기만 하고 조작은 안 함', dj: '상황 엔진이 고른 노래만 계속 틀기' };

const DEFAULT_GENRES = [
  { genre: '락', gesture: 'rock', query: 'rock' },
  { genre: '팝', gesture: 'pop', query: 'pop hits' },
  { genre: '힙합', gesture: 'hiphop', query: 'hip hop' },
  { genre: '재즈', gesture: 'jazz', query: 'jazz' },
];

const DEFAULT_CONTROLS = [
  { gesture: 'swipe_left', action: 'previous' }, // 왼쪽으로 쓸기
  { gesture: 'swipe_right', action: 'next' }, // 오른쪽으로 쓸기
  { gesture: 'swipe_up', action: 'volume_up' },
  { gesture: 'swipe_down', action: 'volume_down' },
  { gesture: 'play_pause', action: 'toggle' },
  { gesture: 'like', action: 'like' },
];

/* ---------- 설정 저장/불러오기 ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = null; // { platform, source, camera, genres, controls, feedback, away, schedule }
let firstRun = false; // settings.json 이 아직 없음 = 처음 켬 → 어떤 음악 앱을 쓸지부터 물어봄
// 카메라(제스처 인식) 종류: 'pi' 라즈베리파이 웹캠 / 'mac' 맥북 카메라 / 'off' 안 씀
const SOURCES = { pi: '라즈베리파이 웹캠', mac: '맥북 카메라', off: '끄기' };

function loadSettings() {
  firstRun = !fs.existsSync(settingsFile());
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {}
  settings = cleanSettings({
    source: loadConfig().piStream ? 'pi' : 'off',
    camera: loadConfig().camera === true, // 웹캠 연결 전이라 기본은 꺼짐
    genres: DEFAULT_GENRES,
    controls: DEFAULT_CONTROLS,
    ...saved,
  });
}

// 내 플레이리스트 또는 "좋아요 표시한 곡"
const PLAYLIST_URI = /^spotify:(playlist:[A-Za-z0-9]{10,40}|user:[^:\s]{1,64}:collection)$/;

// 설정 화면에서 온 값을 믿지 말고 한 번 정리
// (빈 칸, 이상한 동작, 두 목록을 통틀어 겹치는 제스처 이름은 뺌 — 한 제스처는 한 가지 일만)
function cleanSettings(s) {
  const seen = new Set();
  const fresh = (name) => name && !seen.has(name) && seen.add(name);
  const str = (v) => String(v || '').trim();
  const genres = (Array.isArray(s.genres) ? s.genres : [])
    .map((g) => {
      const item = { genre: str(g?.genre), gesture: str(g?.gesture), query: str(g?.query) };
      const p = g?.playlist;
      if (p && PLAYLIST_URI.test(str(p.uri))) {
        item.playlist = { uri: str(p.uri), name: str(p.name).slice(0, 100) || '내 플레이리스트', tracks: Math.max(0, Math.floor(Number(p.tracks)) || 0) };
      }
      return item;
    })
    .filter((g) => g.genre && (g.query || g.playlist) && fresh(g.gesture));
  const controls = (Array.isArray(s.controls) ? s.controls : [])
    .map((c) => ({ gesture: str(c?.gesture), action: c?.action }))
    .filter((c) => CONTROL_ACTIONS[c.action] && fresh(c.gesture));
  // 시간대별 장르: 시작 시각(HH:MM)과 위 목록에 있는 장르만, 시각 순으로
  const names = new Set(genres.map((g) => g.genre));
  const slots = (Array.isArray(s.schedule?.slots) ? s.schedule.slots : [])
    .map((t) => ({ from: str(t?.from), genre: str(t?.genre) }))
    .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t.from) && names.has(t.genre))
    .sort((a, b) => a.from.localeCompare(b.from));
  const minutes = Math.round(Number(s.away?.minutes));
  return {
    platform: PLATFORMS[s.platform] ? s.platform : 'spotify',
    source: SOURCES[s.source] ? s.source : 'off',
    camera: !!s.camera, genres, controls,
    feedback: { sound: s.feedback?.sound !== false }, // 제스처가 인식되면 소리 (기본 켜짐)
    away: { on: !!s.away?.on, minutes: minutes >= 1 && minutes <= 120 ? minutes : 3 }, // 자리 비우면 멈춤
    schedule: { on: !!s.schedule?.on, slots }, // 시간대별 장르
    smooth: { on: s.smooth?.on !== false }, // 장르 바꿀 때 소리를 줄였다가 키움 (기본 켜짐)
    learn: { on: s.learn?.on !== false }, // 들은 시간·넘김으로 단골 플리 만들기 (기본 켜짐)
    situation: {
      city: str(s.situation?.city).slice(0, 40), // 상황 엔진 날씨용 도시 (비우면 날씨 안 씀)
      ical: /^(https|webcal):\/\//i.test(str(s.situation?.ical)) ? str(s.situation.ical).slice(0, 600) : '', // 캘린더 iCal 주소 (선택)
      apps: s.situation?.apps !== false, // 지금 쓰는 앱 종류 보기 (기본 켜짐, 종류만 씀)
    },
    mode: MODES[s.mode] ? s.mode : 'normal', // 보통 / 인식만 / DJ (settings.html readAll 도 맨 끝에 같은 순서로)
  };
}

function saveSettings(next) {
  energyCache.clear(); // 장르 이름·검색어가 바뀌었을 수 있음
  firstRun = false; // 한 번이라도 저장했으면 처음이 아님 (우클릭 메뉴로 플랫폼을 골라도)
  const before = settings?.platform;
  const beforeSource = settings?.source;
  const beforeSchedule = JSON.stringify(settings?.schedule);
  settings = cleanSettings(next);
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  broadcast('camera', settings.camera);
  if (beforeSource !== settings.source) applySource();
  seenAt = Date.now(); // 자리 비움 시간은 저장한 지금부터 다시 셈
  fitModels(); // 장르가 바뀌면 신남 정도도 바뀌어서 다시 배움 (기록은 그대로)
  refreshCalendar(true);
  if (beforeSchedule !== JSON.stringify(settings.schedule)) checkSchedule(true); // 시간대별 장르를 방금 켰거나 고쳤으면 바로 반영
  if (before !== settings.platform) {
    // Spotify 에서 다른 곳으로 옮기면 Spotify 는 멈춰 둠 (두 군데서 동시에 나오지 않게)
    if (before === 'spotify' && tokens && currentTrack?.isPlaying) spotifyApi('PUT', '/me/player/pause').catch(() => {});
    applyPlatform();
  }
  return settings;
}

// 제스처 이름 → { kind: 'genre', item } 또는 { kind: 'control', item }
// 플랫폼마다 제스처가 실제로 하는 일 — 설정 화면의 플랫폼 안내에 보여줌 (null = 그 플랫폼에선 안 됨)
const SPOTIFY_GESTURES = {
  next: '다음 곡', previous: '이전 곡 · 5초 넘게 들었으면 처음으로', toggle: '재생 / 일시정지',
  volume_up: '재생 중인 기기 볼륨 +10', volume_down: '재생 중인 기기 볼륨 −10', like: '좋아요 (내 라이브러리에 저장)',
  genre: '장르에 맞는 플리만 걸러서 틀기 · 단골 플리를 배움',
  note: 'Premium 이 아니면 맥의 Spotify 앱을 켜 두세요 → 재생·넘김·볼륨·장르 재생을 앱에 직접 시켜요 (무료는 셔플).',
};
const gestureHelp = () => Object.fromEntries(Object.keys(PLATFORMS).map((id) =>
  [id, { other_playlist: '같은 장르의 다른 플리', auto: '상황 엔진이 장르를 골라 틀기', ...(id === 'spotify' ? SPOTIFY_GESTURES : players[id].gestures) }]));

function findGesture(name) {
  const genre = settings.genres.find((g) => g.gesture === name);
  if (genre) return { kind: 'genre', item: genre };
  const control = settings.controls.find((c) => c.gesture === name);
  if (control) return { kind: 'control', item: control };
  return null;
}

/* ---------- 제스처 처리 ---------- */

// 한 번 조작한 뒤 이 시간 동안은 제스처를 무시 (손을 내리는 동작 때문에 두 번 넘어가는 것 방지)
const GESTURE_COOLDOWN_MS = 1200; // 플랫폼마다 다르면 players/ 의 cooldown (유튜브는 영상 넘김이 느려서 더 김)
const cooldownMs = () => (active !== 'spotify' && players[active].cooldown) || GESTURE_COOLDOWN_MS;
let lastGestureAt = 0;
let lastUnknownAt = 0;

function handleGesture(name, source = 'camera') {
  const found = findGesture(name);
  // 인식만 모드: 뭘 했을지 노치에만 보여주고 조작은 안 함 (우클릭 "제스처 테스트"는 그대로 조작)
  if (settings.mode === 'watch' && source !== 'menu') return watchGesture(name, found, source);
  if (!found) {
    // 학습은 했는데 설정에서 장르·조작에 연결 안 한 동작 → 알려줌 (안 그러면 인식만 되고 아무 일도 없어 보임)
    if (source !== 'menu' && Date.now() - lastUnknownAt > 8000) {
      lastUnknownAt = Date.now();
      notice(`'${name}' 동작은 아직 연결 안 됐어요 · 설정 → 장르 · 조작 탭에서 연결`);
    }
    return { ok: false, reason: `모르는 제스처: ${name}` };
  }
  const now = Date.now();
  if (now - lastGestureAt < cooldownMs()) return { ok: false, reason: 'cooldown' };
  // DJ 모드: 장르는 엔진만 골라요 → 장르 제스처는 알려주기만 (넘김 · 좋아요 · 볼륨 · 멈춤은 그대로)
  if (settings.mode === 'dj' && found.kind === 'genre' && source !== 'menu') {
    lastGestureAt = now;
    broadcast('gesture', { name, kind: 'ignored', label: 'DJ 모드 · 장르는 엔진이 골라요', source, sound: settings.feedback.sound });
    return { ok: false, reason: 'dj' };
  }
  // 지금 듣고 있는 장르와 같은 장르 제스처면 무시 (곡이 갑자기 다른 플레이리스트로 바뀌지 않게)
  if (found.kind === 'genre' && found.item.genre === currentGenre && currentTrack?.isPlaying) {
    console.log(`[제스처] ${name} → 이미 ${currentGenre} 재생 중이라 무시`);
    // 인식은 됐다는 걸 알려줌 (낮은 소리 + "이미 재생 중")
    broadcast('gesture', { name, kind: 'ignored', label: `이미 ${currentGenre} 재생 중`, source, sound: settings.feedback.sound });
    return { ok: false, reason: 'same-genre', genre: currentGenre };
  }
  lastGestureAt = now;
  runGesture(found, source);
  return { ok: true, kind: found.kind, ...(found.kind === 'genre' ? { genre: found.item.genre } : { action: found.item.action }) };
}

// 인식만 모드: 같은 쿨다운으로 (손을 내리는 동작까지 두 번 뜨지 않게) "무엇을 했을지"만 알려줌
let lastWatchAt = 0;
function watchGesture(name, found, source) {
  const now = Date.now();
  if (now - lastWatchAt < cooldownMs()) return { ok: false, reason: 'cooldown' };
  lastWatchAt = now;
  const would = !found ? null : found.kind === 'genre' ? `${found.item.genre} 틀기` : CONTROL_ACTIONS[found.item.action];
  console.log(`[인식만] ${name} → ${would || '연결 안 된 동작'} (조작 안 함)`);
  broadcast('gesture', { name, kind: 'ignored', label: `인식만 · ${would || `${name} (연결 안 됨)`}`, source, sound: settings.feedback.sound });
  return { ok: false, reason: 'watch', would };
}

function runGesture({ kind, item }, source) {
  const label = kind === 'genre' ? `${item.genre} 틀기` : CONTROL_ACTIONS[item.action];
  console.log(`[제스처] ${item.gesture} → ${label} (${source})`);
  broadcast('gesture', { name: item.gesture, kind, label, source, sound: settings.feedback.sound });
  if (kind === 'genre') return playGenre(item); // Spotify 로그인 전이어도 → 못 틀면 유튜브로 대신
  if (!canUse() && item.action !== 'auto') return notice('먼저 Spotify에 로그인해 주세요'); // 알아서 틀기는 장르 재생처럼 못 틀면 유튜브로
  return control(item.action);
}

/* ---------- 장르 재생 ---------- */

let currentGenre = null; // 지금 틀고 있는 장르 이름 (노치와 /now 에 보여줌)
let genreContext = null; // 그 장르로 튼 플레이리스트 uri
let genreStartedAt = 0;

// 재생 확인할 때마다 부름: 음악 앱에서 직접 다른 걸 틀었으면 "장르 재생 중" 표시를 지움
function checkGenreContext(contextUri) {
  if (!currentGenre || Date.now() - genreStartedAt < 8000) return; // 막 틀었을 땐 아직 옛날 정보가 올 수 있음
  if (contextUri === genreContext) return;
  currentGenre = genreContext = null;
  broadcast('genre', null);
  endSession(true); // 음악 앱에서 직접 다른 걸 틀었음 → 금방 바꿨으면 "별로"
}
const recentByGenre = new Map(); // 장르 → 최근에 튼 플레이리스트 uri 들 (반복 방지)
const RECENT_KEEP = 5;

// 재생 시작. 재생 중인 기기가 없으면(404) 내 기기 목록에서 첫 기기로 다시 시도
async function startPlayback(body) {
  let res = await spotifyApi('PUT', '/me/player/play', body);
  if (res.status === 404) {
    const d = await spotifyApi('GET', '/me/player/devices');
    const device = d.ok ? (await d.json()).devices?.[0] : null;
    if (!device) {
      // 기기 목록에 없어도 맥 앱이 켜져 있으면 앱에 직접 시킴
      const uri = body?.context_uri || body?.uris?.[0];
      if (uri && /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(uri) && (await spotifyApp(`play track "${uri}"`))) return pollSoon(), true;
      return notice('Spotify 앱을 먼저 켜 주세요'), false;
    }
    res = await spotifyApi('PUT', `/me/player/play?device_id=${device.id}`, body);
  }
  if (res.status === 403) {
    // 무료 계정: 맥의 Spotify 앱에 그 플리를 틀라고 직접 시킴 (무료는 셔플로 나와요)
    const uri = body?.context_uri || body?.uris?.[0];
    if (uri && /^spotify:[a-z]+:[A-Za-z0-9]+$/.test(uri) && (await spotifyApp(`play track "${uri}"`))) return pollSoon(), true;
    return notice('무료 계정은 맥의 Spotify 앱을 켜 두면 장르 재생이 돼요'), false;
  }
  if (!res.ok) return notice('재생하지 못했어요'), false;
  pollSoon();
  return true;
}

/* ---------- 장르에 맞는 플리 고르기 ----------
   Spotify 개발 모드 앱은 검색 한 번에 플리 10개까지만 주고, 플리 안의 곡 · 가수 장르는 못 봐요.
   그래서 "제목 · 설명"만 보고 진짜 그 장르 플리인지 점수를 매겨요.
     1) 검색어 여러 개(영어 · 한국어 · 비슷한 말) × 2쪽 → 후보 40개쯤
     2) 제목·설명에 그 장르 낱말이 있으면 +, 다른 장르 낱말이 섞이면 −, 곡이 너무 적으면 −
        "힙한" (= 세련된) 처럼 헷갈리는 낱말은 장르 낱말로 안 쳐요
     3) 점수가 기준을 넘는 것만 남기고 (없으면 그나마 나은 것), 점수만큼 잘 뽑히게
   검색 결과는 장르마다 6시간 기억 (매번 검색하면 느리고 결과도 들쭉날쭉) */
const GENRE_WORDS = {
  hiphop: { words: ['힙합', 'hip hop', 'hip-hop', 'hiphop', '국힙', '외힙', '랩', 'rap', '래퍼', 'rapper', '트랩', 'trap', '붐뱁', 'boom bap', 'drill', '드릴', 'r&b/hip', '쇼미', 'show me the money'], search: ['hip hop', '힙합', 'rap'] },
  rnb: { words: ['r&b', 'rnb', '알앤비', 'neo soul', '네오소울', 'soul', '소울'], search: ['r&b', '알앤비'] },
  rock: { words: ['rock', '락', '록', '밴드', 'band', 'metal', '메탈', 'punk', '펑크', 'grunge', 'alternative', '얼터너티브'], search: ['rock', '락 밴드'] },
  pop: { words: ['pop', '팝', '팝송', '빌보드', 'billboard'], search: ['pop hits', '팝송'] },
  kpop: { words: ['kpop', 'k-pop', '케이팝', '아이돌', 'idol', '걸그룹', '보이그룹'], search: ['kpop', '케이팝'] },
  jazz: { words: ['jazz', '재즈', 'bossa', '보사노바', 'swing', '스윙'], search: ['jazz', '재즈'] },
  classical: { words: ['classical', '클래식', 'piano', '피아노', 'orchestra', '오케스트라', 'symphony', '교향곡', 'mozart', 'bach', 'chopin'], search: ['classical', '클래식'] },
  lofi: { words: ['lofi', 'lo-fi', '로파이', 'chill', '잔잔', 'study', '공부', 'ambient', '앰비언트'], search: ['lofi', '로파이', 'chill'] },
  edm: { words: ['edm', 'house', '하우스', 'techno', '테크노', 'electronic', '일렉', 'dance', '댄스', 'trance'], search: ['edm', 'house'] },
  ballad: { words: ['ballad', '발라드', '이별'], search: ['발라드', 'ballad'] },
  indie: { words: ['indie', '인디'], search: ['indie', '인디'] },
  workout: { words: ['workout', 'gym', '운동', '헬스', 'running', '러닝', 'cardio', 'pump'], search: ['workout', '운동'], mood: true }, // 장르가 아니라 상황 → 섞여도 안 깎음
  jpop: { words: ['jpop', 'j-pop', '제이팝', '일본', 'japan', 'anime', '애니'], search: ['jpop', '제이팝'] },
};
// 장르 낱말처럼 보이지만 아닌 것 (지우고 나서 셈)
const FALSE_FRIENDS = ['힙한', '힙하', '힙스터', '힙 한', 'hipster', '랩탑', '랩소디', '드라이브', '팝콘', '스윙스'];
// 가까운 장르끼리는 섞여도 조금만 깎음
const NEAR = { hiphop: ['rnb'], rnb: ['hiphop'], pop: ['kpop'], kpop: ['pop'], lofi: ['jazz'], jazz: ['lofi'], rock: ['indie'], indie: ['rock'] };
const FIT_PASS = 1.8; // 이 점수 넘는 플리만 틀어요 (제목에 장르 낱말 2 + 곡 많음 0.3, 다른 장르 하나 섞이면 −0.8)
const POOL_TTL = 6 * 3600000;
const MIN_TRACKS = 15;
const poolCache = new Map(); // 장르 → { at, items }

// 장르 이름 + 검색어 → 사전의 장르 (여러 개일 수 있음). 사전에 없으면 null → 검색어 낱말 그대로 씀
function genreKinds(g) {
  const text = clean(`${g.genre} ${g.query}`);
  return Object.entries(GENRE_WORDS).filter(([, d]) => d.words.some((w) => hasWord(text, w))).map(([k]) => k);
}
const clean = (t) => {
  let x = ` ${String(t || '').toLowerCase().replace(/[^\p{L}\p{N}&/+-]+/gu, ' ')} `;
  for (const f of FALSE_FRIENDS) x = x.split(f).join(' ');
  return x;
};
// 짧은 영어 낱말은 낱말 단위로 (rap 이 "trapeze"·"wrap" 에 걸리지 않게),
// 한 글자 한글(락 · 록 · 팝 · 랩)은 낱말 맨 앞에 올 때만 ("기록"·"연락" 에 안 걸리게), 나머지 한글은 그냥 포함
const hasWord = (text, w) => {
  if (/^[a-z&/ -]+$/.test(w) && w.length <= 5) return new RegExp(`(^|[^a-z])${w.replace(/[&/+-]/g, '\\$&')}([^a-z]|$)`).test(text);
  if (w.length === 1) return text.includes(` ${w}`);
  return text.includes(w);
};

// 플리 하나가 그 장르에 얼마나 맞나 (0 이하 = 아님)
function playlistFit(p, kinds, queryWords) {
  const name = clean(p.name), desc = clean(p.description);
  const words = kinds.length ? kinds.flatMap((k) => GENRE_WORDS[k].words) : queryWords;
  let fit = 0;
  if (words.some((w) => hasWord(name, w))) fit += 2;
  else if (words.some((w) => hasWord(desc, w))) fit += 1;
  // 다른 장르가 섞여 있으면 (예: "외힙, 팝송, 국힙") 덜 맞음
  for (const [k, d] of Object.entries(GENRE_WORDS)) {
    if (kinds.includes(k) || d.mood || !d.words.some((w) => hasWord(name, w))) continue;
    fit -= kinds.some((my) => NEAR[my]?.includes(k)) ? 0.3 : 0.8;
  }
  const tracks = p.tracks?.total ?? p.items?.total ?? 0;
  if (tracks && tracks < MIN_TRACKS) fit -= 1.5;
  if (tracks >= 40) fit += 0.3;
  if (p.owner?.id === 'spotify') fit += 1; // 공식 플리 (보이면)
  return fit;
}

async function searchPlaylists(q, offset = 0) {
  const res = await spotifyApi('GET', `/search?${new URLSearchParams({ q, type: 'playlist', limit: 10, offset })}`);
  if (!res.ok) return [];
  return ((await res.json()).playlists?.items || []).filter((p) => p?.uri);
}

// 그 장르 후보 플리들 (점수 붙여서). 6시간 기억
async function genrePool(g) {
  const key = `${g.genre}\n${g.query}`;
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < POOL_TTL) return hit.items;
  const kinds = genreKinds(g);
  const queries = [...new Set([g.query, ...kinds.flatMap((k) => GENRE_WORDS[k].search)].filter(Boolean))].slice(0, 4);
  const pages = await Promise.all(queries.flatMap((q) => [0, 10].map((o) => searchPlaylists(q, o).catch(() => []))));
  const seen = new Map();
  for (const p of pages.flat()) if (!seen.has(p.uri)) seen.set(p.uri, p);
  const queryWords = clean(g.query).split(' ').filter((w) => w.length >= 2);
  const scored = [...seen.values()].map((p) => ({ uri: p.uri, name: p.name, fit: playlistFit(p, kinds, queryWords) }))
    .sort((a, b) => b.fit - a.fit);
  const good = scored.filter((p) => p.fit >= FIT_PASS);
  const items = good.length >= 3 ? good : scored.slice(0, Math.max(3, good.length));
  if (items.length) poolCache.set(key, { at: Date.now(), items });
  console.log(`[검색] ${g.genre}: 후보 ${scored.length}개 중 ${items.length}개 (${kinds.join(',') || '사전에 없음'})`);
  return items;
}

// Spotify: 그 장르 플리 후보 → 최근에 튼 건 빼고 (잘 맞는 · 단골일수록 잘 뽑히게) 하나 → 재생 (기획서 3번)
// 틀었으면 { context, label }, 못 틀었으면 안내를 띄우고 null
async function playGenreSpotify(g) {
  if (!tokens) return null; // 로그인 전 → playGenre 가 유튜브로 대신
  if (g.playlist) return playMyPlaylist(g.playlist);
  let all;
  try {
    all = await genrePool(g);
  } catch {
    return notice('플레이리스트를 검색하지 못했어요'), null;
  }
  if (!all.length) return notice(`${g.genre} 플레이리스트를 못 찾았어요`), null;

  const recent = recentByGenre.get(g.genre) || [];
  const pick = pickPlaylist(g.genre, all, recent);
  recentByGenre.set(g.genre, [...recent, pick.uri].slice(-RECENT_KEEP));

  if (!(await smoothPlay({ context_uri: pick.uri }))) return null;
  return { context: pick.uri, label: pick.star ? `★ ${pick.name}` : pick.name, learn: true, name: pick.name };
}

// 내 플레이리스트: 매번 같은 첫 곡부터 나오지 않게 무작위 곡부터 (셔플 설정은 건드리지 않음)
async function playMyPlaylist(p) {
  const body = { context_uri: p.uri };
  if (p.tracks > 1) body.offset = { position: Math.floor(Math.random() * Math.min(p.tracks, 500)) };
  let ok = await smoothPlay(body);
  if (!ok && body.offset) ok = await startPlayback({ context_uri: p.uri }); // 곡 수가 바뀌어서 위치가 없을 때
  if (!ok) return notice(`"${p.name}" 을(를) 틀지 못했어요`), null;
  return { context: p.uri, label: p.name };
}

// 설정 화면용: 내 플레이리스트 목록 (+ 좋아요 표시한 곡)
async function myPlaylists() {
  if (!tokens?.refresh_token) return { ok: false, reason: 'Spotify 에 로그인해 주세요' };
  const has = (tokens.scope || '').split(' ');
  const full = EXTRA_SCOPES.every((s) => has.includes(s));
  try {
    const items = [];
    const me = await (await spotifyApi('GET', '/me')).json();
    const liked = await spotifyApi('GET', '/me/tracks?limit=1');
    if (liked.ok && me.id) {
      items.push({ uri: `spotify:user:${me.id}:collection`, name: '좋아요 표시한 곡', tracks: (await liked.json()).total || 0, owner: me.display_name || '' });
    }
    for (let url = '/me/playlists?limit=50'; url && items.length < 300;) {
      const res = await spotifyApi('GET', url);
      if (!res.ok) break;
      const j = await res.json();
      for (const p of (j.items || []).filter(Boolean)) {
        items.push({ uri: p.uri, name: p.name, tracks: p.tracks?.total ?? p.items?.total ?? 0, owner: p.owner?.display_name || '', image: p.images?.at(-1)?.url || '' });
      }
      url = j.next ? j.next.replace('https://api.spotify.com/v1', '') : null;
    }
    return { ok: true, items: items.filter((p) => PLAYLIST_URI.test(p.uri)), full };
  } catch (e) {
    return { ok: false, reason: `목록을 못 가져왔어요 (${e.message})` };
  }
}

/* ---------- 부드러운 전환 ----------
   장르를 바꿀 때 소리를 1초 동안 줄였다가 → 새 플리를 틀고 → 1.5초 동안 원래 크기로 키움.
   볼륨을 못 바꾸는 기기(휴대폰 일부, 스피커)거나 조용할 땐 그냥 바로 틀어요. */
const FADE_OUT_MS = 1000;
const FADE_IN_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setVolume(v) {
  try {
    return (await spotifyApi('PUT', `/me/player/volume?volume_percent=${Math.round(v)}`)).ok;
  } catch {
    return false;
  }
}

async function ramp(from, to, ms, steps = 5) {
  for (let i = 1; i <= steps; i++) {
    await setVolume(from + ((to - from) * i) / steps);
    await sleep(ms / steps);
  }
}

async function smoothPlay(body) {
  if (!settings.smooth.on) return startPlayback(body);
  let volume = null;
  try {
    const r = await spotifyApi('GET', '/me/player');
    if (r.status === 200) {
      const j = await r.json();
      if (j.is_playing && j.device?.supports_volume !== false && Number.isFinite(j.device?.volume_percent)) volume = j.device.volume_percent;
    }
  } catch {}
  if (volume === null || volume < 10) return startPlayback(body);
  const low = Math.max(2, Math.round(volume * 0.15));
  let ok = false;
  try {
    await ramp(volume, low, FADE_OUT_MS);
    ok = await startPlayback(body);
    if (ok) await sleep(500); // 새 곡이 실제로 나오기 시작할 때쯤
  } finally {
    await ramp(low, volume, ok ? FADE_IN_MS : 300, ok ? 6 : 1); // 실패해도 원래 크기로 돌려놓음
  }
  return ok;
}

/* ---------- 알아서 단골 만들기 ----------
   검색으로 튼 플리를 얼마나 들었는지 봐요.
     10분 넘게 들음                              → 좋음 (★ 단골)
     45초도 안 듣고 다른 장르/음악으로 바꿈       → 별로
     틀고 2분 안에 "다음 곡"을 3번 넘김           → 별로
   다음에 그 장르를 틀 때 좋음은 자주, 별로는 드물게 (2번 이상 별로면 안 나옴).
   단골은 검색에 안 나와도 후보에 들어가요. userData/favorites.json 에 저장. */
const GOOD_MS = 10 * 60000;
const BAD_LISTEN_MS = 45000;
const SKIP_WINDOW_MS = 2 * 60000;
const SKIPS_BAD = 3;
const favFile = () => path.join(app.getPath('userData'), 'favorites.json');
let favorites = {}; // { 장르: { uri: { name, good, bad, plays, last } } }
let session = null; // 지금 듣는 플리: { genre, uri, name, playlistLearn, meta: { src, p }, situation, startedAt, listened, away, skips, nexts, done, cut, liked, volUp, tick, judged, logged }

function loadFavorites() {
  try {
    const j = JSON.parse(fs.readFileSync(favFile(), 'utf8'));
    favorites = j && typeof j === 'object' ? j : {};
  } catch {
    favorites = {};
  }
}

function saveFavorites() {
  fs.writeFile(favFile(), JSON.stringify(favorites, null, 1), (e) => e && console.error(e.message));
}

function favEntry(genre, uri, name) {
  const g = (favorites[genre] ||= {});
  return (g[uri] ||= { name, good: 0, bad: 0, plays: 0, last: 0 });
}

// playlistLearn: 검색으로 고른 플리라서 "단골" 점수도 매김 (내 플리를 고정한 장르는 상황 점수만)
function startSession(genre, uri, name, playlistLearn, meta = {}) {
  if (!settings.learn.on) return;
  if (playlistLearn) {
    const e = favEntry(genre, uri, name);
    e.name = name;
    e.plays++;
    saveFavorites();
  }
  session = {
    genre, uri, name, playlistLearn, meta, situation: situationNow(), startedAt: Date.now(),
    listened: 0, away: 0, // 들은 시간 / 자리 비운 채 흘러간 시간 (점수에서 뺌)
    skips: 0, nexts: 0, // 2분 안에 넘긴 곡 / 전체 넘긴 곡
    done: 0, cut: 0, // 끝까지(85%) 들은 곡 / 중간에 바뀐 곡 (앱에서 직접 넘긴 것 포함)
    trackId: null, trackProg: 0, trackDur: 0, nextPressed: false,
    tick: Date.now(), judged: false,
  };
}

// 카메라가 자리 비움을 알려주고 있고, 1분 넘게 사람이 안 보이면 "안 듣는 중"
const AWAY_GRACE_MS = 60000;
const listenerAway = () => Date.now() - presenceAt < 15000 && Date.now() - seenAt > AWAY_GRACE_MS;

// 곡이 바뀔 때: 앞 곡을 끝까지 들었는지
function trackStep(s, t) {
  if (!t?.id || t.id === 'yt:ad') return; // 유튜브 광고는 곡으로 안 침
  if (s.trackId && t.id !== s.trackId) {
    const nearEnd = s.trackDur > 0 && (s.trackProg >= s.trackDur * 0.85 || s.trackDur - s.trackProg < 25000);
    if (nearEnd) s.done++;
    else s.cut++;
    s.nextPressed = false;
  }
  s.trackId = t.id;
  s.trackProg = t.progress || 0;
  s.trackDur = t.duration || 0;
}

// 플리 점수를 상황 칸마다 따로도 셈 (주말 밤에 좋은 플리 ≠ 평일 아침에 좋은 플리)
//   칸 = 평일/주말 × 아침·낮·저녁·밤 (8칸 — 너무 잘게 나누면 기록이 안 모여서)
const TIME_GROUP = { 새벽: '밤', 아침: '아침', 낮: '낮', 오후: '낮', 저녁: '저녁', 밤: '밤' };
const ctxBucket = (x) => `${x?.day || '평일'}|${TIME_GROUP[x?.time] || '낮'}`;

function judge(s, kind) {
  if (s.judged) return;
  s.judged = true;
  if (!s.playlistLearn) return;
  const e = favEntry(s.genre, s.uri, s.name);
  e[kind]++;
  e.last = Date.now();
  const c = ((e.ctx ||= {})[ctxBucket(s.situation)] ||= { good: 0, bad: 0 });
  c[kind]++;
  saveFavorites();
  console.log(`[단골] ${s.genre} · ${s.name} → ${kind === 'good' ? '좋음' : '별로'} (좋음 ${e.good} / 별로 ${e.bad})`);
  if (kind === 'good' && e.good === 1) notice(`★ ${s.name} · ${s.genre} 단골로 저장했어요`);
}

// 폴링마다: 그 플리를 실제로 재생 중인 시간만 셈 (어느 플랫폼이든). track: 지금 곡 (끝까지 들었는지 보려고)
function tickSession(isPlaying, contextUri, track) {
  if (!session) return;
  const now = Date.now();
  const dt = now - session.tick;
  session.tick = now;
  const mine = contextUri === session.uri;
  if (isPlaying && mine && dt < 10000) {
    if (listenerAway()) session.away += dt; // 자리 비운 채 흘러간 건 "들은 것"이 아님
    else session.listened += dt;
  }
  if (mine) trackStep(session, track);
  if (session.listened >= GOOD_MS) judge(session, 'good');
  if (session.listened >= LOG_AT_MS) logSession(session, false); // 오래 듣는 중 → 미리 기록
}

function countSkip() {
  if (!session) return;
  session.nexts++;
  session.nextPressed = true;
  if (session.judged || Date.now() - session.startedAt > SKIP_WINDOW_MS) return;
  if (++session.skips >= SKIPS_BAD) judge(session, 'bad');
}

// 다른 걸 틀게 됐을 때. byUser: 사람이 바꾼 거면 금방 바꾼 걸 "별로"로 침
function endSession(byUser) {
  const s = session;
  session = null;
  logSession(s, byUser);
  if (!s || s.judged || !byUser) return;
  if (s.listened < BAD_LISTEN_MS && Date.now() - s.startedAt < 5 * 60000) judge(s, 'bad');
}

// 베타 분포에서 하나 뽑기 (감마 두 개로) — "이 플리가 좋을 확률"의 있을 법한 값
function gammaDraw(k) {
  if (k < 1) return gammaDraw(k + 1) * Math.random() ** (1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gauss(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaDraw = (a, b) => { const x = gammaDraw(a); return x / (x + gammaDraw(b)); };

// 검색 결과 + 단골 중에서 하나 고르기 (무게를 둔 무작위)
//   단골 점수는 Thompson sampling: 지금 상황 칸의 좋음/별로(무게 1) + 다른 칸까지 합친 것(무게 0.4)으로
//   "좋을 확률"을 하나 뽑아서 무게로 씀 → 지금 같은 때 좋았던 플리가 잘 나오고, 덜 들어 본 것도 가끔
function pickPlaylist(genre, found, recent) {
  const fav = settings.learn.on ? favorites[genre] || {} : {};
  const bucket = ctxBucket(situationNow());
  const pool = new Map(found.map((p) => [p.uri, { uri: p.uri, name: p.name, fit: p.fit }]));
  for (const [uri, f] of Object.entries(fav)) if (f.good > f.bad) pool.set(uri, { uri, name: f.name, fit: pool.get(uri)?.fit ?? 2 });
  const weighed = [...pool.values()].map((p) => {
    const f = fav[p.uri];
    let w = p.fit == null ? 1 : Math.max(0.2, p.fit); // 장르에 잘 맞는 플리일수록
    if (f) {
      const c = f.ctx?.[bucket] || { good: 0, bad: 0 };
      const chance = betaDraw(1 + c.good + 0.4 * (f.good - c.good), 1 + c.bad + 0.4 * (f.bad - c.bad));
      w *= 0.3 + 3 * chance;
      if (f.bad >= 2 && f.good === 0) w = 0; // 두 번 별로였으면 빼기
    } else {
      w *= 0.3 + 3 * betaDraw(1, 1); // 처음 보는 플리는 반반
    }
    if (p.uri === recent[recent.length - 1]) w = 0; // 방금 튼 건 바로 다시 안 틂
    else if (recent.includes(p.uri)) w *= 0.3;
    return { ...p, w, star: !!f && f.good > f.bad };
  });
  const total = weighed.reduce((a, p) => a + p.w, 0);
  if (!total) return { ...found[Math.floor(Math.random() * found.length)], star: false };
  let r = Math.random() * total;
  return weighed.find((p) => (r -= p.w) <= 0) || weighed[weighed.length - 1];
}

// 설정 화면용: 장르마다 단골(좋음) 과 뺀 것(별로)
function favoritesSummary() {
  const out = [];
  for (const [genre, items] of Object.entries(favorites)) {
    for (const [uri, f] of Object.entries(items)) {
      const state = f.good > f.bad ? 'good' : f.bad >= 2 && f.good === 0 ? 'out' : f.bad > f.good ? 'less' : null;
      if (state) out.push({ genre, uri, name: f.name, good: f.good, bad: f.bad, plays: f.plays, state });
    }
  }
  return out.sort((a, b) => a.genre.localeCompare(b.genre) || b.good - a.good || a.bad - b.bad);
}

/* ============================================================
   상황 엔진 — 검색도, 장르 고르기도 없이 "지금 나한테 맞는 음악"
   ============================================================
   지금 상황 = { 요일: 평일/주말, 시간대: 새벽·아침·낮·오후·저녁·밤, 날씨: 맑음·흐림·비·눈, 활동: 워치가 알려주면 }
   "알아서 틀기"(제스처·메뉴·POST /auto)를 하면 설정의 장르마다 점수를 매겨서 하나를 골라요.
     배운 점수 : 그 상황 특징에서 그 장르를 틀었을 때의 보상 (history.jsonl → 맥락 밴딧, 아래)
     기본 점수 : 장르 이름·검색어에 상황에 어울리는 낱말이 있으면 + (예: 밤 ↔ 잔잔·재즈·lofi)
     시간대별 장르 : 지금 칸의 장르면 +
   점수가 높을수록 잘 뽑히고, 덜 들어 본 장르는 불확실한 만큼 가끔 뽑혀요 (Thompson sampling).
   틀고 나서 계속 들으면 "이 상황엔 이 장르"를 배우고, 금방 바꾸면 그 상황에선 덜 고르게 돼요.

   워치(나중에): POST /context {"activity":"still|walking|running","heart":72} 를 보내면 5분 동안 상황에 들어가요. */
const TIME_SLOTS = [[0, '새벽'], [6, '아침'], [10, '낮'], [14, '오후'], [18, '저녁'], [21, '밤']];
const TIME_ORDER = TIME_SLOTS.map(([, n]) => n);
const ACTIVITY_NAMES = { still: '가만히', walking: '걷는 중', running: '뛰는 중' };
const HINTS = { // 상황 → 그 상황에 어울리는 장르 이름·검색어 낱말 (소문자)
  새벽: ['잔잔', '새벽', 'lofi', 'lo-fi', 'chill', 'sleep', '잠', 'piano', '피아노', 'ambient', '감성', '발라드'],
  아침: ['아침', 'morning', 'acoustic', '어쿠스틱', '상쾌', 'pop', '팝', 'coffee', '카페'],
  낮: ['노동요', 'focus', '집중', 'study', '공부', 'pop', '팝', 'lofi'],
  오후: ['노동요', 'focus', '집중', 'study', '공부', 'pop', '팝', '신나는'],
  저녁: ['힙합', 'hip hop', 'hiphop', 'r&b', 'rnb', 'pop', '팝', 'city pop', '시티팝', 'jazz', '재즈'],
  밤: ['재즈', 'jazz', 'lofi', 'chill', '잔잔', '감성', 'r&b', '발라드', 'night', '밤'],
  비: ['재즈', 'jazz', 'lofi', 'rain', '비', '어쿠스틱', 'acoustic', '발라드', '감성', 'piano'],
  흐림: ['lofi', 'chill', '잔잔', '감성', 'indie', '인디'],
  맑음: ['pop', '팝', '신나는', 'dance', '댄스', 'summer', 'drive', '드라이브'],
  눈: ['캐롤', 'christmas', 'winter', '겨울', '발라드', '잔잔'],
  주말: ['신나는', 'party', '파티', 'dance', '댄스', 'drive', '드라이브'],
  running: ['workout', '운동', 'edm', '신나는', 'rock', '락', 'hip hop', '힙합', 'dance'],
  walking: ['pop', '팝', 'indie', '인디', 'city pop', '시티팝', 'drive'],
  still: ['focus', '집중', 'lofi', '잔잔', 'jazz', '재즈'],
};
let bodySignal = { activity: null, heart: null, at: 0 }; // 워치가 보낸 몸 상태
let peopleSignal = { n: null, at: 0 }; // 카메라가 센 사람 수 (5초마다)

/* ---------- 상황 정보 더 ----------
   지금 쓰는 앱 : 맨 앞 앱 이름을 30초마다 보고(lsappinfo — 권한 필요 없음) 종류만 남겨요. 앱 이름·창 제목은 저장 안 함.
                  최근 10분 동안 가장 많았던 종류 = 지금 하는 일
   캘린더       : 설정에 적은 iCal 주소(구글 캘린더 "비공개 iCal 주소" 등)를 15분마다 받아서
                  지금 일정 중인지 / 30분 안에 일정이 있는지만 봐요. 일정 제목은 저장 안 함.
   사람 수      : 카메라(파이·맥북)가 5초마다 센 사람 수 → 혼자 / 여럿
   최근에 들은 것: 지난 3시간 동안 장르마다 들은 분 → 같은 걸 오래 들었으면 질렸을 수 있음 */
const APP_KINDS = {
  work: ['code', 'cursor', 'xcode', 'terminal', 'iterm', 'warp', 'ghostty', 'intellij', 'pycharm', 'webstorm', 'android studio', 'sublime',
    'notion', 'obsidian', 'pages', 'word', 'keynote', 'powerpoint', 'excel', 'numbers', 'hwp', '한글', 'figma', 'goodnotes', 'preview', '미리보기'],
  meeting: ['zoom', 'teams', 'facetime', 'webex', 'gather', 'whereby'],
  play: ['steam', 'league', 'riot', 'minecraft', 'battle.net', 'roblox', 'epic games', 'iina', 'vlc', 'quicktime', 'netflix', 'tv', 'disney'],
  chat: ['kakaotalk', '카카오톡', 'slack', 'discord', 'messages', '메시지', 'telegram', 'line', 'instagram'],
  web: ['safari', 'chrome', 'arc', 'firefox', 'whale', 'edge', 'brave', 'opera'],
};
const APP_KIND_NAMES = { work: '작업 중', meeting: '회의 중', play: '노는 중', chat: '채팅 중', web: '웹 보는 중' };
const appSamples = []; // 최근 10분 앱 종류 (30초마다 하나)
function appKindOf(name) {
  const n = String(name || '').toLowerCase();
  if (!n || n.includes('snaptune')) return null;
  for (const [kind, words] of Object.entries(APP_KINDS)) if (words.some((w) => n === w || n.includes(w))) return kind;
  return 'other';
}
function sampleFrontApp() {
  if (settings?.situation?.apps === false) return appSamples.splice(0);
  execFile('/usr/bin/lsappinfo', ['front'], { timeout: 3000 }, (err, asn) => {
    if (err || !asn.trim()) return;
    execFile('/usr/bin/lsappinfo', ['info', '-only', 'name', asn.trim()], { timeout: 3000 }, (e2, out) => {
      if (e2) return;
      const name = (out.match(/"(?:LSDisplayName|name)"\s*=\s*"([^"]*)"/i) || [])[1];
      const kind = appKindOf(name);
      if (kind === null) return; // Snaptune 자기 자신(설정 창 등)은 셈에서 뺌
      appSamples.push(kind);
      if (appSamples.length > 20) appSamples.shift();
    });
  });
}
function appNow() {
  if (appSamples.length < 3) return null;
  const count = {};
  for (const k of appSamples) count[k] = (count[k] || 0) + 1;
  const [kind, n] = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return kind !== 'other' && n / appSamples.length >= 0.4 ? kind : null;
}

// iCal(.ics) 아주 작게 읽기: 한 번짜리 일정 + 매일/매주 반복 (BYDAY, UNTIL, INTERVAL). 종일 일정은 "바쁨"으로 안 침
const calendar = { url: '', events: [], at: 0, error: '', busy: false };
function icsDate(v, tzLocal) {
  const m = String(v).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', z] = m;
  if (m[4] === undefined) return { allDay: true, t: new Date(+y, +mo - 1, +d).getTime() };
  return { allDay: false, t: z && !tzLocal ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) : new Date(+y, +mo - 1, +d, +h, +mi, +se).getTime() };
}
function parseIcs(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') { if (ev?.start && !ev.start.allDay) out.push(ev); ev = null; }
    else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [key, ...params] = line.slice(0, i).split(';');
      const val = line.slice(i + 1);
      const local = params.some((p) => p.startsWith('TZID='));
      if (key === 'DTSTART') ev.start = icsDate(val, local);
      else if (key === 'DTEND') ev.end = icsDate(val, local);
      else if (key === 'RRULE') ev.rrule = Object.fromEntries(val.split(';').map((kv) => kv.split('=')));
      else if (key === 'STATUS' && val === 'CANCELLED') ev.cancelled = true;
    }
  }
  return out.filter((e) => !e.cancelled).map((e) => ({
    start: e.start.t, dur: Math.max(5 * 60000, (e.end?.t || e.start.t + 3600000) - e.start.t), rrule: e.rrule || null,
  }));
}
// 오늘 기준으로 그 일정이 [시작, 끝] 인 때들 (반복 일정은 오늘·어제 것만 계산)
function occurrencesNear(e, now) {
  if (!e.rrule) return [[e.start, e.start + e.dur]];
  const r = e.rrule;
  const until = r.UNTIL ? icsDate(r.UNTIL)?.t ?? Infinity : Infinity;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const base = new Date(e.start);
  const res = [];
  for (const back of [1, 0]) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    day.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
    const t = day.getTime();
    if (t < e.start || t > until) continue;
    const days = Math.round((new Date(day).setHours(0, 0, 0, 0) - new Date(base).setHours(0, 0, 0, 0)) / 86400000);
    let ok = false;
    if (r.FREQ === 'DAILY') ok = days % interval === 0;
    else if (r.FREQ === 'WEEKLY') {
      const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      const by = r.BYDAY ? r.BYDAY.split(',').map((x) => x.slice(-2)) : [codes[base.getDay()]];
      ok = by.includes(codes[day.getDay()]) && Math.floor(days / 7) % interval === 0;
    }
    if (ok) res.push([t, t + e.dur]);
  }
  return res;
}
async function refreshCalendar(force = false) {
  const url = (settings?.situation?.ical || '').replace(/^webcal:/i, 'https:');
  if (!url) return Object.assign(calendar, { url: '', events: [], error: '' });
  if (calendar.busy || (!force && url === calendar.url && Date.now() - calendar.at < 15 * 60000)) return;
  calendar.busy = true;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`캘린더를 받지 못했어요 (${res.status})`);
    const events = parseIcs(await res.text());
    Object.assign(calendar, { url, events, at: Date.now(), error: '' });
  } catch (e) {
    Object.assign(calendar, { url, at: Date.now(), error: e.message.includes('캘린더') ? e.message : '캘린더 주소에 연결하지 못했어요' });
  } finally {
    calendar.busy = false;
  }
}
// 'busy' 지금 일정 중 / 'soon' 30분 안에 시작 / null
function calendarNow(now = Date.now()) {
  if (!calendar.events.length) return null;
  let soon = false;
  for (const e of calendar.events) {
    for (const [a, b] of occurrencesNear(e, now)) {
      if (a <= now && now < b) return 'busy';
      if (a > now && a - now <= 30 * 60000) soon = true;
    }
  }
  return soon ? 'soon' : null;
}
const CAL_NAMES = { busy: '일정 중', soon: '곧 일정' };

// 지난 3시간 장르마다 들은 분 (+ 지금 세션), 마지막으로 들은 장르(30분 안)
function recentListening(now = Date.now()) {
  const recent = {};
  for (const r of history) {
    if (r.t >= now - 3 * 3600000) recent[r.genre] = (recent[r.genre] || 0) + (r.listened || 0) / 60;
  }
  if (session && !session.logged) recent[session.genre] = (recent[session.genre] || 0) + session.listened / 60000;
  for (const k of Object.keys(recent)) recent[k] = Math.round(recent[k]);
  const lastRec = session && !session.logged ? { genre: session.genre, t: now } : history[history.length - 1];
  const last = lastRec && now - (lastRec.t + (lastRec.listened || 0) * 1000) < 30 * 60000 ? lastRec.genre : null;
  return { recent, last };
}

function timeOfDay(d) {
  let name = TIME_SLOTS[0][1];
  for (const [h, n] of TIME_SLOTS) if (d.getHours() >= h) name = n;
  return name;
}

function situationNow(d = new Date()) {
  refreshWeather(); // 기다리지 않음: 이번엔 지난번 날씨로
  refreshCalendar();
  const fresh = Date.now() - bodySignal.at < 5 * 60000;
  const people = Date.now() - peopleSignal.at < 30000 ? peopleSignal.n : null;
  const { recent, last } = recentListening(d.getTime());
  return {
    day: d.getDay() === 0 || d.getDay() === 6 ? '주말' : '평일',
    time: timeOfDay(d),
    hour: Math.round((d.getHours() + d.getMinutes() / 60) * 10) / 10,
    weather: weather.label,
    activity: fresh ? bodySignal.activity : null,
    app: appNow(), // work / meeting / play / chat / web / null
    cal: calendarNow(d.getTime()), // busy / soon / null
    people: people == null || people === 0 ? null : people === 1 ? 'alone' : 'group',
    recent, last, // 장르별 최근 3시간 들은 분, 30분 안에 마지막으로 들은 장르
  };
}
const sitKey = (x) => [x.day, x.time, x.weather || '-', x.activity || '-'].join('|');
const sitFromKey = (k) => { const [day, time, w, a] = k.split('|'); return { day, time, weather: w === '-' ? null : w, activity: a === '-' ? null : a }; };
const PEOPLE_NAMES = { alone: '혼자', group: '여럿이' };
const sitLabel = (x) => [x.day, x.time, x.weather, ACTIVITY_NAMES[x.activity], APP_KIND_NAMES[x.app], CAL_NAMES[x.cal], PEOPLE_NAMES[x.people]]
  .filter(Boolean).join(' · ');

/* ---------- ④ 보상 기록 ----------
   틀었던 것 하나 = history.jsonl 한 줄:
     { t, genre, uri, src: 'auto'|'gesture'|'schedule', p: 그걸 고를 확률(알아서 틀기만), x: 상황,
       listened: 들은 초, skips, liked, volUp, early: 45초 안에 사람이 바꿈, reward }
   보상 = 들은 비율(10분 = 1) + 좋아요 1 + 볼륨 올림 0.2 − 금방 바꿈 1 − 0.5 × (2분 안에 넘긴 곡 / 3)
   p 를 같이 남겨 두면 나중에 "다른 방식으로 골랐다면 어땠을까"를 지난 기록만으로 따져 볼 수 있어요. */
const FULL_MS = 10 * 60000; // 이만큼 들으면 들은 비율 1
const LOG_AT_MS = 20 * 60000; // 이만큼 들으면 끝나기 전에 미리 기록
const HISTORY_KEEP = 5000;
const histFile = () => path.join(app.getPath('userData'), 'history.jsonl');
let history = [];

// 보상 = 들은 비율(10분 = 1, 자리 비운 시간 빼고) + 좋아요 1 + 볼륨 올림 0.2 − 금방 바꿈 1
//        − 0.5 × (2분 안에 넘긴 곡 / 3) + 0.4 × (끝까지 들은 곡 비율 − 0.5)  ← 곡이 2개 이상 지나갔을 때만
function rewardOf(s, early) {
  let r = Math.min(1, s.listened / FULL_MS);
  if (s.liked) r += 1;
  if (s.volUp) r += 0.2;
  if (early) r -= 1;
  r -= 0.5 * Math.min(1, s.skips / SKIPS_BAD);
  const tracks = (s.done || 0) + (s.cut || 0);
  if (tracks >= 2) r += 0.4 * ((s.done || 0) / tracks - 0.5);
  return Math.round(r * 100) / 100;
}

// 세션이 끝날 때(또는 20분 넘게 들었을 때) 한 번 기록
function logSession(s, byUser) {
  if (!s || s.logged || !settings.learn.on) return;
  const early = byUser && s.listened < BAD_LISTEN_MS && Date.now() - s.startedAt < 5 * 60000;
  if (!early && s.listened < 30000 && !s.liked && !s.skips) return; // 아무것도 알 수 없는 짧은 재생 (자리 비운 채 틀어 둔 것도)
  if (s.sameGenre && early) return; // 플리만 바꾼 것 → 장르 선택은 다음 플리 기록이 대신 판단
  s.logged = true;
  const rec = {
    t: s.startedAt, genre: s.genre, uri: s.uri, src: s.meta?.src || 'gesture', p: s.meta?.p ?? null, x: s.situation,
    listened: Math.round(s.listened / 1000), away: Math.round((s.away || 0) / 1000), skips: s.skips, nexts: s.nexts || 0,
    done: s.done || 0, cut: s.cut || 0, liked: !!s.liked, volUp: !!s.volUp, early, reward: rewardOf(s, early),
    platform: s.platform || 'spotify',
  };
  history.push(rec);
  if (history.length > HISTORY_KEEP) history = history.slice(-HISTORY_KEEP);
  fs.appendFile(histFile(), JSON.stringify(rec) + '\n', (e) => e && console.error(e.message));
  fitModels();
  console.log(`[기록] ${sitLabel(rec.x)} · ${rec.genre} · ${rec.listened}초 → 보상 ${rec.reward}${rec.p != null ? ` (확률 ${Math.round(rec.p * 100)}%)` : ''}`);
}

function loadHistory() {
  try {
    history = fs.readFileSync(histFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter((r) => r?.genre && r.x).slice(-HISTORY_KEEP);
  } catch {
    history = [];
    migrateSituations();
  }
  fitModels();
}

// 예전 방식(situations.json: 상황마다 좋음/별로 횟수)으로 배운 걸 새 기록으로 옮김 (한 번만)
function migrateSituations() {
  const old = path.join(app.getPath('userData'), 'situations.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(old, 'utf8')); } catch { return; }
  const mid = { 새벽: 3, 아침: 8, 낮: 12, 오후: 16, 저녁: 19.5, 밤: 22.5 };
  for (const [k, genres] of Object.entries(j || {})) {
    const x = { ...sitFromKey(k), hour: mid[sitFromKey(k).time] ?? 12 };
    for (const [genre, e] of Object.entries(genres)) {
      for (let i = 0; i < (e.good || 0); i++) history.push({ t: Date.now(), genre, src: 'old', p: null, x, listened: 600, skips: 0, liked: false, volUp: false, early: false, reward: 1 });
      for (let i = 0; i < (e.bad || 0); i++) history.push({ t: Date.now(), genre, src: 'old', p: null, x, listened: 20, skips: 0, liked: false, volUp: false, early: true, reward: -1 });
    }
  }
  if (history.length) {
    fs.writeFileSync(histFile(), history.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`[기록] 예전 기록 ${history.length}개를 옮겼어요`);
  }
  fs.rename(old, old.replace('.json', '.old.json'), () => {});
}

/* ---------- ③ 맥락 밴딧 (Thompson sampling) ----------
   두 겹으로 배워요 (베이즈 선형 회귀 두 개, 둘 다 "평균 + 불확실함"을 가짐)
     ① 분위기 모델 (모든 장르가 같이 씀): "이 상황이면 신나는 음악이 나을까, 잔잔한 게 나을까"
        특징 = 상황 φ(x) × 장르의 신남 정도(e: 잔잔 0 ~ 신남 1)  → 재즈로 배운 게 lofi·발라드에도 이어짐
        처음 쓰는 사람: 사전값(PRIOR_BETA — 밤엔 잔잔, 뛸 땐 신나게 …)에서 시작 → 기록 없이도 그럴듯하게
     ② 장르 모델 (장르마다 따로): 분위기로 설명 못 하는 나머지 (그 장르 자체를 좋아하는지, 질렸는지)
   상황 φ(x) = [1, 시간대 6, 시각 sin·cos, 주말, 날씨 4, 활동 3, 하는 일 5, 캘린더 2, 혼자/여럿 2]  (26개)
   장르 모델엔 + [최근 3시간 그 장르 들은 양, 방금 그 장르였는지] (28개) → 같은 걸 오래 들으면 질림을 배움
   고를 때: 분위기 β 하나, 장르마다 θ 하나씩 "있을 법한 값"을 뽑아서 점수가 가장 높은 장르 (Thompson sampling)
     → 확실히 좋은 건 자주, 덜 들어 본 건 가끔 (따로 '섞기' 비율이 필요 없음)
   점수 = φ·θ뽑기 + 분위기·β뽑기 + 기본 점수(장르 이름이 상황과 어울리면 · 시간대별 장르 칸)
   오래된 기록은 덜 믿어요 (90일마다 무게 절반) → 취향이 바뀌어도 따라감 */
const PRIOR_PRECISION = 4; // 클수록 처음엔 덜 흔들림 (기록 4개쯤부터 기록이 앞섬)
const SHARED_PRECISION = 6; // 분위기 사전값을 얼마나 믿을지
const NOISE = 0.6; // 보상이 얼마나 들쭉날쭉한지
const HALF_LIFE_DAYS = 90;
const HINT_WEIGHT = 0.25;
const SLOT_WEIGHT = 0.6;
const MIN_CHANCE = 0.02; // 어떤 장르든 이 정도는 (기록을 나중에 평가할 수 있게)
const WEATHERS = ['맑음', '흐림', '비', '눈'];
const ACTIVITIES = ['still', 'walking', 'running'];
const APP_ORDER = ['work', 'meeting', 'play', 'chat', 'web'];
const FEATURE_NAMES = ['기본', ...TIME_ORDER, '시각sin', '시각cos', '주말', ...WEATHERS, ...ACTIVITIES, ...APP_ORDER, 'busy', 'soon', 'alone', 'group'];
let models = {}; // 장르 → { L: A 의 촐레스키, theta, n }
let shared = null; // 분위기 모델 { L, beta, n }

function baseFeatures(x) {
  const mid = { 새벽: 3, 아침: 8, 낮: 12, 오후: 16, 저녁: 19.5, 밤: 22.5 };
  const h = ((x.hour ?? mid[x.time] ?? 12) / 24) * 2 * Math.PI;
  return [
    1,
    ...TIME_ORDER.map((n) => (x.time === n ? 1 : 0)),
    0.5 * Math.sin(h), 0.5 * Math.cos(h),
    x.day === '주말' ? 1 : 0,
    ...WEATHERS.map((w) => (x.weather === w ? 1 : 0)),
    ...ACTIVITIES.map((a) => (x.activity === a ? 1 : 0)),
    ...APP_ORDER.map((k) => (x.app === k ? 1 : 0)),
    x.cal === 'busy' ? 1 : 0, x.cal === 'soon' ? 1 : 0,
    x.people === 'alone' ? 1 : 0, x.people === 'group' ? 1 : 0,
  ];
}
// 장르 모델 특징: 상황 + 그 장르에 질렸는지
function features(x, genre) {
  const minutes = x.recent?.[genre] || 0;
  return [...baseFeatures(x), Math.min(1.5, minutes / 90), x.last && x.last === genre ? 1 : 0];
}
const DIM = features({ time: '낮', day: '평일' }, '').length;
const SDIM = baseFeatures({ time: '낮', day: '평일' }).length;
// 장르 모델의 처음 값: 전부 0, 질림만 − (같은 장르를 1시간 반 들으면 −0.4, 방금 그 장르였으면 −0.1) → 기록 없이도 가끔 바꿔 줌
const THETA0 = Array.from({ length: DIM }, (_, i) => (i === DIM - 2 ? -0.4 : i === DIM - 1 ? -0.1 : 0));

// 장르의 신남 정도 (0 잔잔 ~ 1 신남): 장르 사전 → 이름·검색어 낱말 → 모르면 0.5
const ENERGY = { lofi: 0.15, classical: 0.2, jazz: 0.3, ballad: 0.3, indie: 0.45, rnb: 0.5, pop: 0.6, jpop: 0.6, kpop: 0.7, hiphop: 0.75, rock: 0.8, edm: 0.9, workout: 0.95 };
const ENERGY_WORDS = [
  [0.15, ['잔잔', 'sleep', '잠', '수면', 'piano', '피아노', 'ambient', '명상', 'calm']],
  [0.4, ['노동요', 'focus', '집중', 'study', '공부', 'acoustic', '어쿠스틱', '카페', 'cafe']],
  [0.85, ['신나는', 'party', '파티', 'dance', '댄스', 'hype', 'drive', '드라이브', '운동']],
];
const energyCache = new Map();
function energyOf(genreName) {
  if (energyCache.has(genreName)) return energyCache.get(genreName);
  const item = settings?.genres?.find((g) => g.genre === genreName) || { genre: genreName, query: '' };
  const kinds = genreKinds({ genre: item.genre, query: item.query || '' }).filter((k) => ENERGY[k] != null);
  let e = kinds.length ? kinds.reduce((a, k) => a + ENERGY[k], 0) / kinds.length : null;
  if (e == null) {
    const text = `${item.genre} ${item.query || ''} ${item.playlist?.name || ''}`.toLowerCase();
    const hit = ENERGY_WORDS.find(([, words]) => words.some((w) => text.includes(w)));
    e = hit ? hit[0] : 0.5;
  }
  energyCache.set(genreName, e);
  return e;
}
// 분위기 모델 특징: 상황 × (신남 − 0.5) × 2  → 신나는 장르는 +, 잔잔한 장르는 −
const sharedFeatures = (x, genre) => { const k = (energyOf(genre) - 0.5) * 2; return baseFeatures(x).map((v) => v * k); };

/* ---------- ④ 처음 쓰는 사람을 위한 사전값 ----------
   "이 상황에서 신나는 음악이 얼마나 나은가" 를 기록 0개일 때 이 값에서 시작해요 (+ 신나게, − 잔잔하게).
   앱 폴더에 engine-prior.json 이 있으면 그 값이 먼저예요 → 여러 사람이 "기본값 내보내기"로 낸 걸
   scripts/merge-priors.js 로 합쳐서 넣으면, 다음 버전부터 처음 쓰는 사람도 그 평균에서 시작해요. */
const PRIOR_BETA = {
  새벽: -0.6, 아침: 0.1, 낮: 0.1, 오후: 0.2, 저녁: 0.2, 밤: -0.4, 주말: 0.15,
  맑음: 0.1, 흐림: -0.1, 비: -0.3, 눈: -0.1,
  still: -0.2, walking: 0.2, running: 0.6,
  work: -0.3, meeting: -0.6, play: 0.3, chat: 0, web: 0,
  busy: -0.5, soon: -0.1, alone: 0, group: 0.3,
};
function priorBeta() {
  let table = PRIOR_BETA;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'engine-prior.json'), 'utf8'));
    if (j && typeof j.beta === 'object') table = { ...PRIOR_BETA, ...j.beta };
  } catch {}
  return FEATURE_NAMES.map((n) => (Number.isFinite(table[n]) ? table[n] : 0));
}

// 작은 행렬 계산 (17 x 17 이라 그냥 손으로)
function cholesky(A) {
  const n = A.length, L = A.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(sum, 1e-9)) : sum / L[j][j];
    }
  }
  return L;
}
function solveLower(L, y) { // L z = y
  const z = [];
  for (let i = 0; i < y.length; i++) {
    let s = y[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z.push(s / L[i][i]);
  }
  return z;
}
function solveUpperT(L, y) { // Lᵀ z = y
  const n = y.length, z = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * z[k];
    z[i] = s / L[i][i];
  }
  return z;
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const eye = (n, v) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? v : 0)));
function addOuter(A, b, f, w, y) {
  for (let i = 0; i < f.length; i++) {
    if (!f[i]) continue;
    b[i] += w * y * f[i];
    for (let j = 0; j < f.length; j++) A[i][j] += w * f[i] * f[j];
  }
}

function fitModels() {
  const now = Date.now();
  const rows = history.map((r) => ({ r, w: 0.5 ** ((now - (r.t || now)) / 86400000 / HALF_LIFE_DAYS) }));
  // ① 분위기 모델: 사전값 β₀ 둘레에서 시작 (A = λI, b = λβ₀)
  const beta0 = priorBeta();
  const As = eye(SDIM, SHARED_PRECISION), bs = beta0.map((v) => v * SHARED_PRECISION);
  let ns = 0;
  for (const { r, w } of rows) { addOuter(As, bs, sharedFeatures(r.x, r.genre), w, r.reward); ns += w; }
  const Ls = cholesky(As);
  shared = { L: Ls, beta: solveUpperT(Ls, solveLower(Ls, bs)), n: ns, beta0 };
  // ② 장르 모델: 분위기로 설명하고 남은 것(보상 − 분위기 예측)을 배움
  const by = {};
  for (const { r, w } of rows) {
    const m = (by[r.genre] ||= { A: eye(DIM, PRIOR_PRECISION), b: THETA0.map((v) => v * PRIOR_PRECISION), n: 0 });
    addOuter(m.A, m.b, features(r.x, r.genre), w, r.reward - dot(sharedFeatures(r.x, r.genre), shared.beta));
    m.n += w;
  }
  models = {};
  for (const [genre, m] of Object.entries(by)) {
    const L = cholesky(m.A);
    models[genre] = { L, theta: solveUpperT(L, solveLower(L, m.b)), n: m.n };
  }
}

// 기록이 없는 장르: θ = 0, A = 사전값 → L = √λ·I
const blankModel = () => ({ L: Array.from({ length: DIM }, (_, i) => Array.from({ length: DIM }, (_, j) => (i === j ? Math.sqrt(PRIOR_PRECISION) : 0))), theta: THETA0.slice(), n: 0 });

// 장르마다 점수 → 고를 확률 (Thompson 을 여러 번 해 보고 각 장르가 1등 한 비율)
// [{ item, chance, mean, sd, why: [...] }] (확률 높은 순)
function rankGenres(now = situationNow(), draws = 400) {
  const slot = currentSlot();
  const playing = currentTrack?.isPlaying ? currentGenre : null; // 지금 듣는 장르는 빼고 (다른 걸 원해서 부른 거니까)
  if (!shared) fitModels();
  const list = settings.genres.filter((g) => g.genre !== playing || settings.genres.length === 1).map((item) => {
    const text = `${item.genre} ${item.query} ${item.playlist?.name || ''}`.toLowerCase();
    const why = [];
    let prior = 0;
    for (const signal of [now.time, now.weather, now.day === '주말' ? '주말' : null, now.activity]) {
      if (signal && HINTS[signal]?.some((w) => text.includes(w))) {
        prior += HINT_WEIGHT;
        why.push(ACTIVITY_NAMES[signal] || signal);
      }
    }
    if (slot?.genre === item.genre) {
      prior += SLOT_WEIGHT;
      why.push(`${slot.from} 시간대 장르`);
    }
    const m = models[item.genre] || blankModel();
    const f = features(now, item.genre);
    const sf = sharedFeatures(now, item.genre);
    const own = dot(f, m.theta);
    const mood = dot(sf, shared.beta);
    const mean = own + mood;
    const vo = dot(solveLower(m.L, f), solveLower(m.L, f)); // φᵀA⁻¹φ
    const vs = dot(solveLower(shared.L, sf), solveLower(shared.L, sf));
    const sd = NOISE * Math.sqrt(vo + vs);
    if (m.n >= 1 && own > 0.25) why.unshift('이런 때 오래 들음');
    else if (m.n >= 1 && own < -0.25) why.unshift('이런 때 금방 넘김');
    if (mood > 0.15) why.push(energyOf(item.genre) >= 0.5 ? '지금은 신나는 게 어울림' : '지금은 잔잔한 게 어울림');
    else if (mood < -0.15) why.push(energyOf(item.genre) >= 0.5 ? '지금은 너무 신남' : '지금은 너무 잔잔함');
    if ((now.recent?.[item.genre] || 0) >= 60) why.push(`최근 ${now.recent[item.genre]}분 들음`);
    if (m.n < 1) why.push('아직 잘 모름');
    return { item, m, f, sf, prior, mean, own, mood, sd, why, wins: 0 };
  });
  if (!list.length) return [];
  for (let d = 0; d < draws; d++) {
    // 분위기 β 는 한 번만 뽑아서 모든 장르에 같이 씀 (같은 "지금 분위기 판단"으로 비교)
    const zs = Array.from({ length: SDIM }, gauss);
    const betaDraw = solveUpperT(shared.L, zs).map((v, i) => shared.beta[i] + NOISE * v);
    let best = null, bestScore = -Infinity;
    for (const c of list) {
      const z = Array.from({ length: DIM }, gauss);
      const score = c.prior + dot(c.f, c.m.theta) + NOISE * dot(c.f, solveUpperT(c.m.L, z)) + dot(c.sf, betaDraw); // φ·(θ + 소음·L⁻ᵀz) + 분위기
      if (score > bestScore) { bestScore = score; best = c; }
    }
    best.wins++;
  }
  const floor = Math.min(MIN_CHANCE, 1 / list.length);
  for (const c of list) c.chance = floor + (1 - floor * list.length) * (c.wins / draws);
  return list.sort((a, b) => b.chance - a.chance);
}

// 위 확률대로 하나 뽑음 → 그 확률(p)을 그대로 기록에 남길 수 있음
// exclude: 이 장르는 빼고 (나머지 확률을 다시 100%로 맞춤 → p 도 실제로 뽑힌 확률 그대로)
function chooseGenre(now, exclude = null) {
  let list = rankGenres(now);
  if (exclude && list.length > 1) {
    const rest = list.filter((x) => x.item.genre !== exclude);
    const sum = rest.reduce((a, x) => a + x.chance, 0) || 1;
    list = rest.map((x) => ({ ...x, chance: x.chance / sum }));
  }
  let r = Math.random();
  return list.find((x) => (r -= x.chance) <= 0) || list[list.length - 1] || null;
}

// byUser: 사람이 시킨 것 (앞 플리를 금방 바꾼 거면 "별로"로 침) / keepSame: 같은 장르가 또 뽑히면 플리를 안 바꿈 (DJ)
async function playAuto({ why = '알아서 ·', exclude = null, byUser = true, keepSame = false } = {}) {
  const now = situationNow();
  const pick = chooseGenre(now, exclude);
  if (!pick) return notice('설정에서 장르를 먼저 만들어 주세요');
  Object.assign(dj, { genre: pick.item.genre, sit: djSit(now), at: Date.now(), skips: [], endedAt: 0, settleUntil: Date.now() + 15000 });
  console.log(`[상황] ${sitLabel(now)} → ${pick.item.genre} (${Math.round(pick.chance * 100)}% · ${pick.why.join(', ') || '그냥'})${why.startsWith('DJ') ? ` [${why}]` : ''}`);
  if (keepSame && pick.item.genre === currentGenre) return; // 상황이 바뀌었어도 엔진이 지금 장르가 맞대요 → 그대로
  return playGenre(pick.item, { auto: !byUser, why, src: 'auto', p: pick.chance });
}

/* ---------- DJ 모드 ----------
   상황 엔진이 고른 장르만 계속 틀어요. 노래 중간엔 안 끊고, 곡이 바뀌는 순간에만 다시 골라요.
     · 엔진이 고르지 않은 걸 듣고 있으면 (DJ 를 막 켰거나, 앱에서 직접 틀었으면) → 이 곡 다음부터 엔진이
     · 4분 안에 3곡을 금방(1분 · 절반 전에) 넘겼으면 → 안 맞는 거니까 다른 장르로
     · 한 장르를 40분 넘게 틀었고 상황(시간대 · 하는 일 · 일정 · 혼자/여럿 · 날씨 · 몸 상태)이 바뀌었으면 → 다시 골라요
     · 한 장르를 90분 넘게 틀었으면 → 질렸을 테니 다른 장르로
     · 플리가 끝나서 멈추면 → 이어서 골라요
   곡 중간에 멈추면(제스처든 앱이든 자리 비움이든) 누가 멈춘 거니까 그대로 둬요. 다시 틀면 이어서 DJ.
   앱을 켤 때 조용하면 먼저 틀지 않아요 (재생하거나 "알아서 틀기"를 하면 시작).
   장르 제스처 · 시간대별 장르는 안 써요. 넘김 · 좋아요 · 볼륨 · 멈춤은 그대로 → 엔진이 배우는 점수가 돼요 */
const DJ_STAY_MS = 40 * 60000;
const DJ_MAX_MS = 90 * 60000;
const DJ_SKIPS = 3;
const DJ_SKIP_WINDOW_MS = 4 * 60000;
const dj = { genre: null, sit: null, at: 0, skips: [], settleUntil: 0, endedAt: 0, picking: false, trackId: null, prog: 0, dur: 0, playing: false };
// "상황이 바뀌었나" 볼 값 (시각은 아침·낮·저녁·밤 4칸으로 크게)
const djSit = (x) => [x.day, TIME_GROUP[x.time], x.weather || '-', x.activity || '-', x.app || '-', x.cal || '-', x.people || '-'].join('|');
const djOwns = () => !!currentGenre && currentGenre === dj.genre; // 지금 나오는 게 엔진이 고른 장르인지

async function djPick(why, { exclude = null, byUser = false } = {}) {
  if (dj.picking) return;
  dj.picking = true;
  try {
    await playAuto({ why: why ? `DJ · ${why} ·` : 'DJ ·', exclude, byUser, keepSame: !exclude && djOwns() });
  } finally {
    dj.picking = false;
  }
}

// 곡이 바뀐 순간: 다시 고를 까닭이 있으면 { why, exclude, byUser }
function djReason() {
  if (dj.skips.length >= DJ_SKIPS) return { why: '자꾸 넘겨서', exclude: currentGenre, byUser: true };
  if (!djOwns()) return { why: '', byUser: false };
  const long = Date.now() - dj.at;
  if (long >= DJ_MAX_MS) return { why: `${currentGenre} 오래 들어서`, exclude: currentGenre, byUser: false };
  if (long >= DJ_STAY_MS && djSit(situationNow()) !== dj.sit) return { why: '상황이 바뀌어서', byUser: false };
  return null;
}

// 폴링마다 (어느 플랫폼이든). track 이 null 이면 아무것도 안 나오는 중
function djTick(isPlaying, track) {
  const now = Date.now();
  const prev = { id: dj.trackId, prog: dj.prog, dur: dj.dur, playing: dj.playing };
  if (track?.id && track.id !== 'yt:ad') Object.assign(dj, { trackId: track.id, prog: track.progress || 0, dur: track.duration || 0 });
  dj.playing = isPlaying;
  if (settings.mode !== 'dj' || dj.picking || now < dj.settleUntil) return;
  if (prev.playing && !isPlaying) {
    // 곡 끝 무렵에 멈췄고, 곡이 넘어갔거나(처음 곡으로 · 없음) 끝까지 갔으면 → 플리가 끝남. 곡 중간이면 → 누가 멈춤
    const nearEnd = prev.dur > 0 && (prev.dur - prev.prog < 15000 || prev.prog >= prev.dur * 0.95);
    const finished = !track?.id || track.id !== prev.id || (track.progress || 0) + 5000 < prev.prog
      || (track.duration > 0 && track.duration - (track.progress || 0) < 2000);
    dj.endedAt = nearEnd && finished ? now : 0;
  }
  if (isPlaying) dj.endedAt = 0;
  if (!isPlaying) {
    if (dj.endedAt && now - dj.endedAt > 4000 && !autoPaused) djPick('플리가 끝나서');
    return;
  }
  if (!prev.id || !track?.id || track.id === prev.id || track.id === 'yt:ad') return; // 곡이 바뀌는 순간에만
  if (prev.prog < Math.min(60000, prev.dur * 0.5)) dj.skips.push(now); // 금방 넘김
  dj.skips = dj.skips.filter((t) => now - t < DJ_SKIP_WINDOW_MS);
  const r = djReason();
  if (r) djPick(r.why, r);
}

// 모드 바꾸기 (우클릭 메뉴 · 설정 맨 위). 설정 창의 "저장"은 모드를 안 건드려요 (창이 열린 사이 메뉴로 바꾼 걸 되돌리지 않게)
function setMode(mode) {
  if (!MODES[mode] || settings.mode === mode) return settings;
  saveSettings({ ...settings, mode });
  console.log(`[모드] ${MODES[mode]}`);
  broadcast('mode', mode);
  if (mode === 'watch') notice('인식만 모드 · 제스처를 알아보기만 하고 조작은 안 해요');
  else if (mode === 'normal') notice('보통 모드 · 제스처로 바로 조작해요');
  else if (!currentTrack?.isPlaying) djPick('시작');
  else notice(djOwns() ? 'DJ 모드 · 지금 장르부터 이어 가요' : 'DJ 모드 · 이 곡이 끝나면 엔진이 고른 걸로 이어 가요');
  if (mode === 'dj') {
    dj.skips = [];
    if (!dj.at) dj.at = Date.now();
  }
  return settings;
}

// 최근 30일 지표: 알아서 틀기 / 직접 고른 것 따로
function historyStats(days = 30) {
  const since = Date.now() - days * 86400000;
  const group = (rows) => rows.length
    ? {
        count: rows.length,
        early: rows.filter((r) => r.early).length / rows.length, // 금방 바꾼 비율 (낮을수록 좋음)
        minutes: rows.reduce((a, r) => a + r.listened, 0) / rows.length / 60, // 한 번에 이어 들은 시간 (길수록 좋음)
        reward: rows.reduce((a, r) => a + r.reward, 0) / rows.length,
      }
    : null;
  const recent = history.filter((r) => r.t >= since && r.src !== 'old');
  const autos = recent.filter((r) => r.src === 'auto');
  return {
    auto: group(autos), manual: group(recent.filter((r) => r.src !== 'auto')),
    liked: autos.length ? autos.filter((r) => r.liked).length / autos.length : null, // 알아서 튼 것 중 좋아요 비율
  };
}

// 분석 창용: 지표 (기간별) · 날짜별 흐름 · 장르별 · 상황×장르 · 지금 상황의 모델 값 · 최근 기록
function analyticsReport(days = 30) {
  const since = Date.now() - days * 86400000;
  const rows = history.filter((r) => r.t >= since && r.src !== 'old');
  const dayKey = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
  const daily = [];
  for (let i = Math.min(days, 30) - 1; i >= 0; i--) {
    const key = dayKey(Date.now() - i * 86400000);
    const today = rows.filter((r) => dayKey(r.t) === key);
    const auto = today.filter((r) => r.src === 'auto');
    daily.push({
      day: key, count: today.length, auto: auto.length,
      reward: today.length ? today.reduce((a, r) => a + r.reward, 0) / today.length : null,
      early: auto.length ? auto.filter((r) => r.early).length / auto.length : null,
    });
  }
  const genres = {};
  for (const r of rows) {
    const g = (genres[r.genre] ||= { genre: r.genre, n: 0, auto: 0, reward: 0, minutes: 0, early: 0, liked: 0 });
    g.n++; g.reward += r.reward; g.minutes += r.listened / 60; g.early += r.early ? 1 : 0; g.liked += r.liked ? 1 : 0;
    if (r.src === 'auto') g.auto++;
  }
  const now = situationNow();
  const sit = situationReport();
  return {
    days,
    stats: historyStats(days),
    daily,
    genres: Object.values(genres).map((g) => ({ ...g, reward: g.reward / g.n, early: g.early / g.n })).sort((a, b) => b.n - a.n),
    now: sit.label, ranking: sit.ranking, learned: sit.learned, total: history.length,
    // 알아서 틀기가 고른 확률이 낮았는데 잘 들었다 = 탐색이 건진 것
    found: rows.filter((r) => r.src === 'auto' && r.p != null && r.p < 0.2 && r.reward >= 0.8).length,
    recent: rows.slice(-60).reverse().map((r) => ({ ...r, label: sitLabel(r.x) })),
    situation: now,
    mood: moodReport(),
  };
}

// 분석 창: 분위기 모델이 배운 것 (상황마다 신나는 쪽 + / 잔잔한 쪽 −, 처음 값과 비교)
const FEATURE_LABELS = { 기본: '평소', still: '가만히', walking: '걷는 중', running: '뛰는 중', ...APP_KIND_NAMES, busy: '일정 중', soon: '곧 일정', alone: '혼자', group: '여럿이' };
function moodReport() {
  if (!shared) fitModels();
  return {
    n: shared.n,
    rows: FEATURE_NAMES.map((name, i) => ({ name, label: FEATURE_LABELS[name] || name, beta: shared.beta[i], beta0: shared.beta0[i] }))
      .filter((r) => !r.name.startsWith('시각')),
    energy: settings.genres.map((g) => ({ genre: g.genre, energy: energyOf(g.genre) })).sort((a, b) => a.energy - b.energy),
  };
}

// 설정 화면용: 지금 상황, 장르 순위, 배운 것, 지표
function situationReport() {
  const now = situationNow();
  const by = new Map();
  for (const r of history) {
    const key = sitKey(r.x);
    const g = by.get(key + '\n' + r.genre) || { key, label: sitLabel(r.x), genre: r.genre, n: 0, sum: 0, minutes: 0 };
    g.n++;
    g.sum += r.reward;
    g.minutes += r.listened / 60;
    by.set(key + '\n' + r.genre, g);
  }
  const learned = [...by.values()].map((g) => ({ ...g, avg: g.sum / g.n, score: (g.sum / g.n) * Math.sqrt(g.n) }))
    .sort((a, b) => b.score - a.score);
  return {
    now, label: sitLabel(now), temp: weather.temp, city: settings.situation.city, weatherError: weather.error,
    calendar: settings.situation.ical ? { events: calendar.events.length, error: calendar.error, state: CAL_NAMES[now.cal] || '일정 없음' } : null,
    app: APP_KIND_NAMES[now.app] || null, people: PEOPLE_NAMES[now.people] || null,
    watch: now.activity ? { activity: ACTIVITY_NAMES[now.activity], heart: bodySignal.heart } : null,
    ranking: rankGenres(now).map((x) => ({ genre: x.item.genre, chance: x.chance, why: x.why, mean: x.mean, sd: x.sd, mood: x.mood, own: x.own, energy: energyOf(x.item.genre) })),
    learned: learned.slice(0, 30),
    stats: historyStats(),
    total: history.length,
  };
}

// 기록 지우기: { key, genre } 그 상황·장르만, {} 전부
function forgetHistory({ key, genre } = {}) {
  history = key && genre ? history.filter((r) => !(r.genre === genre && sitKey(r.x) === key)) : [];
  fs.writeFileSync(histFile(), history.map((r) => JSON.stringify(r)).join('\n') + (history.length ? '\n' : ''));
  fitModels();
}

/* 날씨 (Open-Meteo: 키 필요 없음). 설정에 적은 도시 이름 → 좌표 → 지금 날씨. 20분마다 새로 */
const weather = { city: '', coords: null, label: null, temp: null, at: 0, busy: false, error: '' };
function weatherName(code) {
  if (code <= 1) return '맑음';
  if (code <= 48) return '흐림';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '눈';
  return '비'; // 이슬비·비·소나기·뇌우
}
// 도시 이름 → 좌표. 지도 검색이 한글 이름을 잘 못 찾아서(서울 → 없음, 부산 → 산) 큰 도시는 표로,
// 나머지는 검색 결과 중 "사람이 사는 곳"(PPL…)에서 인구가 가장 많은 곳
const CITIES = {
  서울: [37.566, 126.978], 부산: [35.18, 129.075], 대구: [35.871, 128.601], 인천: [37.456, 126.705], 광주: [35.16, 126.851],
  대전: [36.35, 127.385], 울산: [35.539, 129.311], 세종: [36.48, 127.289], 수원: [37.263, 127.029], 성남: [37.42, 127.127],
  고양: [37.658, 126.832], 용인: [37.241, 127.178], 창원: [35.228, 128.681], 청주: [36.642, 127.489], 전주: [35.824, 127.148],
  천안: [36.815, 127.114], 포항: [36.019, 129.343], 제주: [33.499, 126.531], 김해: [35.229, 128.889], 춘천: [37.881, 127.73],
  원주: [37.342, 127.92], 강릉: [37.752, 128.876], 여수: [34.76, 127.662], 목포: [34.812, 126.392], 안산: [37.322, 126.831],
  안양: [37.394, 126.957], 평택: [36.992, 127.113], 구미: [36.12, 128.344], 경주: [35.856, 129.225], 진주: [35.18, 128.108],
};
async function findCity(city) {
  const short = city.replace(/\s+/g, '').replace(/(특별자치시|특별자치도|특별시|광역시|시|군)$/, '');
  if (CITIES[short]) return { lat: CITIES[short][0], lon: CITIES[short][1] };
  const q = new URLSearchParams({ name: city, count: 10, language: 'ko' });
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`)).json();
  const hit = (g.results || []).filter((r) => String(r.feature_code || '').startsWith('PPL'))
    .sort((x, y) => (y.population || 0) - (x.population || 0))[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
}

async function refreshWeather(force = false) {
  const city = settings?.situation?.city || '';
  if (!city) return Object.assign(weather, { city: '', coords: null, label: null, temp: null, error: '' });
  if (weather.busy || (!force && city === weather.city && Date.now() - weather.at < 20 * 60000)) return;
  weather.busy = true;
  try {
    if (city !== weather.city || !weather.coords) {
      weather.city = city;
      weather.coords = await findCity(city);
      if (!weather.coords) throw new Error(`"${city}" 을(를) 못 찾았어요`);
    }
    const q = new URLSearchParams({ latitude: weather.coords.lat, longitude: weather.coords.lon, current: 'weather_code,temperature_2m' });
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
    weather.label = weatherName(j.current.weather_code);
    weather.temp = Math.round(j.current.temperature_2m);
    weather.error = '';
  } catch (e) {
    weather.error = e.message;
    weather.label = weather.temp = null;
  } finally {
    weather.at = Date.now();
    weather.busy = false;
  }
}

// 장르 틀기: 고른 플랫폼에서 먼저 해 보고, 그 플랫폼이 못 하면 유튜브로 대신
// (멜론 / 보관함에 곡이 없는 Apple Music / 프리미엄 로그인을 안 한 YouTube Music)
// 같은 장르 다른 플리: 지금 장르로 다시 틀되 방금 튼 플리는 빼고 (recentByGenre 가 알아서 피함)
// 장르는 맞는데 플리가 별로였던 거라 → 플리는 "별로"로 배우지만 상황 엔진엔 장르를 탓하지 않음
async function otherPlaylist() {
  const g = settings.genres.find((x) => x.genre === currentGenre);
  if (!g) return notice(currentGenre ? `"${currentGenre}" 장르가 설정에 없어요` : '장르로 튼 음악이 아니에요');
  if (g.playlist) return notice(`${g.genre}은(는) 내 플리 하나로 정해 둔 장르예요`);
  if (session) session.sameGenre = true;
  const meta = session?.genre === g.genre ? session.meta : {};
  return playGenre(g, { why: '다른 플리 ·', src: meta.src || 'gesture', p: meta.p ?? null });
}

async function playGenre(g, { auto = false, why = '', src = auto ? 'schedule' : 'gesture', p = null } = {}) {
  endSession(!auto); // 앞에 틀던 플리 점수 매기기 (시간대·자리 비움으로 바뀐 건 "별로"로 안 침)
  try {
    let via = platform();
    const other = g.query ? g : { ...g, query: g.playlist?.name || g.genre }; // 다른 플랫폼엔 내 Spotify 플리가 없으니 이름으로 검색
    let played = via === 'spotify' ? await playGenreSpotify(g) : await players[via].playGenre(other);
    // 고른 플랫폼에서 못 틀면 (Spotify 무료·기기 없음, Apple 보관함에 없음, 멜론, YT Music 로그인 전) → 유튜브로
    if (!played && via !== 'youtube') {
      const from = via;
      played = await players.youtube.playGenre(other);
      if (played) {
        played.label = `YouTube (${PLATFORMS[from]}에서 못 틀어서)`;
        via = 'youtube';
      }
    }
    if (!played) {
      if (via !== 'spotify') notice(`${g.genre} 플레이리스트를 못 찾았어요`); // Spotify 는 위에서 이미 안내함
      return;
    }
    setActive(via);
    currentGenre = g.genre;
    genreContext = played.context;
    genreStartedAt = Date.now();
    // 점수 기록은 모든 플랫폼에서 (단골 플리 배우기는 Spotify 검색 플리만)
    startSession(g.genre, played.context, played.name || played.label, via === 'spotify' && !!played.learn, { src, p });
    if (session) session.platform = via;
    broadcast('genre', currentGenre);
    notice(`${why ? `${why} ` : ''}${g.genre} · ${played.label}`);
    pollSoon();
  } catch (e) {
    console.error(e.message);
    notice('장르를 틀지 못했어요');
  }
}

/* ============================================================
   자동 기능 — 자리 비움 감지 / 시간대별 장르
   ============================================================
   둘 다 설정 화면에서 켜고 꺼요 (기본은 꺼짐).

   자리 비움 감지
     인식 프로그램(파이·맥북 카메라)이 1초마다 /now 를 물어볼 때 "지금 사람이 보이는지"를 같이 알려줘요
     (/now?present=1 또는 0). 사람이 settings.away.minutes 분 동안 안 보이면 음악을 멈추고,
     다시 보이면 이어서 틀어요. 내가 멈춘 게 아니라 "자동으로 멈춘 것"만 다시 틀어요.

   시간대별 장르
     settings.schedule.slots = [{ from: '07:00', genre: '재즈' }, …]. 지금 시각보다 앞선 것 중 가장 늦은 칸이 "지금 칸".
     칸이 바뀌는 순간, 음악이 나오고 있으면 그 장르로 바꿔요. 조용할 땐 갑자기 틀지 않아요.
     칸 안에서 제스처로 다른 장르를 틀면 다음 칸까지는 그대로 둬요. */
let seenAt = Date.now(); // 마지막으로 사람이 보인 시각
let presenceAt = 0; // 인식 프로그램이 마지막으로 알려준 시각 (오래됐으면 카메라가 꺼진 것 → 판단 안 함)
let autoPaused = false; // 자리 비움으로 멈춘 상태
let slotKey = null; // 지금 시간대 칸 ('07:00 재즈') — 바뀌었는지 보려고

function reportPresence(present, people = null) {
  presenceAt = Date.now();
  if (Number.isFinite(people) && people >= 0) peopleSignal = { n: Math.min(9, Math.round(people)), at: Date.now() };
  if (!present) return;
  seenAt = Date.now();
  if (autoPaused) comeBack();
}

async function comeBack() {
  autoPaused = false;
  if (!settings.away.on || currentTrack?.isPlaying) return;
  console.log('[자리] 돌아옴 → 이어서 재생');
  const slot = currentSlot();
  // 자리를 비운 사이 시간대가 바뀌었으면 그 장르로, 아니면 듣던 걸 이어서 (DJ 모드는 엔진만 고르니까 이어서)
  if (slot && slotKey !== keyOf(slot) && settings.mode !== 'dj') {
    slotKey = keyOf(slot);
    return playGenre(slot.item, { auto: true });
  }
  await control('play');
  notice('다시 왔네요 · 이어서 재생');
}

function checkAway() {
  if (!settings.away.on || settings.source === 'off' || autoPaused) return;
  if (Date.now() - presenceAt > 10000) { seenAt = Date.now(); return; } // 카메라 소식이 끊김 → 시간을 안 셈
  if (!currentTrack?.isPlaying) { seenAt = Math.max(seenAt, Date.now() - settings.away.minutes * 60000 + 30000); return; } // 다시 틀면 30초는 봐줌
  if (Date.now() - seenAt < settings.away.minutes * 60000) return;
  console.log(`[자리] ${settings.away.minutes}분 동안 안 보임 → 멈춤`);
  autoPaused = true;
  control('pause');
  notice('자리를 비워서 멈췄어요');
}

const keyOf = (slot) => `${slot.from} ${slot.genre}`;
// 지금 시각의 칸: { from, genre, item: 장르 설정 } 또는 null
function currentSlot(now = new Date()) {
  const slots = settings.schedule.on ? settings.schedule.slots : [];
  if (!slots.length) return null;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  // 첫 칸보다 이른 새벽이면 어제의 마지막 칸이 이어짐
  const slot = [...slots].reverse().find((t) => t.from <= hhmm) || slots[slots.length - 1];
  const item = settings.genres.find((g) => g.genre === slot.genre);
  return item ? { ...slot, item } : null;
}

// justSaved: 설정을 방금 저장함 → 칸이 그대로여도 지금 장르가 다르면 맞춤
function checkSchedule(justSaved = false) {
  const slot = currentSlot();
  const key = slot ? keyOf(slot) : null;
  if (key === slotKey && !justSaved) return;
  const first = slotKey === null && !justSaved; // 앱을 막 켰을 땐 바꾸지 않고 기억만
  if (autoPaused) return; // 자리 비운 중 → 돌아왔을 때(comeBack) 반영
  slotKey = key;
  if (!slot || first || settings.mode === 'dj' || !canUse() || !currentTrack?.isPlaying || currentGenre === slot.genre) return;
  console.log(`[시간대] ${slot.from} → ${slot.genre}`);
  playGenre(slot.item, { auto: true });
}

function startAutomation() {
  slotKey = currentSlot() ? keyOf(currentSlot()) : null;
  setInterval(() => { checkAway(); checkSchedule(); }, 5000);
  sampleFrontApp();
  setInterval(sampleFrontApp, 30000); // 상황 엔진: 지금 하는 일 (앱 종류만)
  refreshCalendar();
}

/* ---------- 설정 창 ---------- */
let settingsWin = null;
let analyticsWin = null;

// 이미 열려 있으면 (최소화됐거나 다른 창 뒤에 숨었거나 다른 데스크톱에 있어도) 앞으로 꺼내기
function bringUp(win) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (win.isMinimized()) win.restore();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setVisibleOnAllWorkspaces(true); // 지금 보고 있는 데스크톱으로 데려오기
    win.show();
    win.moveTop();
    win.focus();
    setTimeout(() => !win.isDestroyed() && win.setVisibleOnAllWorkspaces(false), 300);
    app.focus({ steal: true });
    return true;
  } catch {
    win.destroy(); // 이상한 상태면 버리고 새로 만듦
    return false;
  }
}

function makeWindow(file, title, size) {
  const win = new BrowserWindow({
    ...size,
    minWidth: 560,
    minHeight: 420,
    title,
    backgroundColor: '#121212',
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js') },
  });
  win.webContents.on('render-process-gone', () => win.destroy()); // 화면이 죽으면 다음에 새로 열리게
  win.loadFile(file);
  app.focus({ steal: true }); // 독 아이콘이 없는 앱이라 창을 앞으로 끌어와야 보임
  return win;
}

function openSettings() {
  if (bringUp(settingsWin)) return;
  settingsWin = makeWindow('settings.html', 'Snaptune 설정', { width: 760, height: 820 });
  settingsWin.on('closed', () => (settingsWin = null));
}

// 분석: 상황 엔진이 잘 맞히는지 (지표 · 장르별 · 배운 것 · 최근 기록)
function openAnalytics() {
  if (bringUp(analyticsWin)) return;
  analyticsWin = makeWindow('analytics.html', 'Snaptune 분석', { width: 820, height: 860 });
  analyticsWin.on('closed', () => (analyticsWin = null));
}

// 분석 창 "기본값 내보내기": 분위기 모델 값만 (기록·장르 이름 없이) → 여럿이 모아 scripts/merge-priors.js 로 합침
ipcMain.handle('auto:export-prior', async () => {
  if (!shared) fitModels();
  const beta = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, Math.round(shared.beta[i] * 1000) / 1000]));
  const { canceled, filePath } = await dialog.showSaveDialog(analyticsWin || settingsWin || undefined, {
    title: '상황 엔진 기본값 내보내기', defaultPath: path.join(app.getPath('desktop'), 'snaptune-prior.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, n: Math.round(shared.n * 10) / 10, beta }, null, 2) + '\n');
  return { ok: true, path: filePath, n: shared.n };
});

ipcMain.handle('settings:get', () => ({
  settings, actions: CONTROL_ACTIONS, platforms: PLATFORMS, sources: SOURCES, modes: MODES,
  piStream: streamUrl(), // 지금 고른 카메라의 영상 주소 (파이 또는 맥북)
  hasPi: !!loadConfig().pi,
  gestureHelp: gestureHelp(), // 플랫폼마다 제스처가 하는 일
  piAddr: loadConfig().pi || '', // 'user@IP' — 설정 화면의 라즈베리파이 주소 칸
}));

// 설정 화면에서 라즈베리파이 주소를 적으면 userData/config.json 에 pi · piStream 으로 저장
//   addr: 'ubuntu@192.168.0.10' 또는 '192.168.0.10' (사용자 이름 없으면 pi)
ipcMain.handle('pi:connect', async (_e, addr) => {
  const m = String(addr || '').trim().match(/^(?:([\w.-]+)@)?([\w.-]+)$/);
  if (!m) return { ok: false, reason: '주소 형식이 이상해요 (예: ubuntu@192.168.0.10)' };
  const [, user = 'pi', host] = m;
  const file = path.join(app.getPath('userData'), 'config.json');
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  c.pi = `${user}@${host}`;
  c.piStream = `http://${host}:8090/stream`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  if (settings.source !== 'pi') saveSettings({ ...settings, source: 'pi' });
  else broadcast('stream', streamUrl());
  helloPi(); // 파이에게 이 맥 주소를 바로 알려줌
  let online = false;
  try { online = !!(await fetch(`http://${host}:8090/api/state`, { signal: AbortSignal.timeout(3000) })).ok; } catch {}
  return { ok: true, pi: c.pi, online };
});

/* 설정 화면의 "제스처 학습" → 인식 프로그램(파이 또는 맥북)의 대시보드 API 를 맥이 대신 불러줌
   (설정 화면에서 바로 부르면 브라우저 보안(CORS) 때문에 막힐 수 있어서 main 에서 함)
   path: '/api/state' | '/api/poses' | '/api/record' | '/api/train' | '/api/delete'  (pi/web.py 참고) */
function piBase() {
  const stream = streamUrl(); // 예) http://192.168.0.10:8090/stream
  try { return stream ? new URL(stream).origin : null; } catch { return null; }
}
ipcMain.handle('pi:api', async (_e, { path: apiPath, body }) => {
  const base = piBase();
  if (!base) return { ok: false, reason: settings.source === 'off' ? '카메라가 꺼져 있어요 (아래 "카메라"에서 고르세요)' : 'config.json 에 piStream 이 없어요' };
  if (!/^\/api\/(state|poses|record|train|delete|oled)$/.test(apiPath)) return { ok: false, reason: '모르는 주소' };
  try {
    const res = await fetch(base + apiPath, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return await res.json();
  } catch {
    return {
      ok: false, offline: true,
      reason: settings.source === 'mac'
        ? (macSetup ? '맥북 카메라 인식을 설치하는 중이에요… (1~3분)' : '맥북 카메라 인식을 켜는 중이에요…')
        : '라즈베리파이에 연결할 수 없어요 (파이 인식이 켜져 있는지, VPN 이 꺼져 있는지 확인)',
    };
  }
});

// 라즈베리파이에서 녹화한 샘플을 맥북 쪽으로 복사 → 맥북에서 다시 학습 (같은 동작을 두 번 녹화하지 않게)
ipcMain.handle('pi:import', async () => {
  if (!loadConfig().pi) return { ok: false, reason: 'config.json 에 pi 주소가 없어요' };
  const dest = path.join(gestureHome(), 'data', 'samples.jsonl');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const copy = (file, to) => new Promise((resolve) => {
    execFile('/usr/bin/scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${loadConfig().pi}:gesture-pi/data/${file}`, to],
      { timeout: 20000 }, (err) => resolve(!err));
  });
  const ok = await copy('samples.jsonl', dest);
  if (!ok) return { ok: false, reason: '라즈베리파이에서 가져오지 못했어요 (연결·VPN 확인, 파이에 녹화한 샘플이 있는지 확인)' };
  try {
    await fetch(`${piBase()}/api/train`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
  } catch {}
  return { ok: true };
});
ipcMain.handle('settings:save', (_e, next) => saveSettings({ ...next, mode: settings.mode })); // 모드는 setMode 로만
ipcMain.handle('settings:mode', (_e, mode) => setMode(mode));
ipcMain.handle('spotify:playlists', () => myPlaylists());
ipcMain.handle('fav:list', () => favoritesSummary());
ipcMain.handle('auto:report', async (_e, { refresh } = {}) => {
  if (refresh) await refreshWeather(true);
  return situationReport();
});
ipcMain.handle('auto:play', () => { control('auto'); return { ok: true }; });
// 상황 기록 지우기: { key, genre } 하나 또는 {} 전부
ipcMain.handle('auto:forget', (_e, x = {}) => {
  forgetHistory(x);
  return situationReport();
});
// 단골/뺀 것 기록 지우기: { genre, uri } 하나 또는 {} 전부
ipcMain.handle('fav:forget', (_e, { genre, uri } = {}) => {
  if (genre && uri) delete favorites[genre]?.[uri];
  else favorites = {};
  saveFavorites();
  return favoritesSummary();
});
// 비공개 플리까지 보려면 권한을 더 받아야 해서 다시 로그인 (브라우저가 열림)
ipcMain.handle('spotify:relogin', () => { login(); return { ok: true }; });
// 저장 안 한 줄도 바로 시험해 볼 수 있게 (쿨다운 없이)
// kind: 'genre' 면 item = { genre, gesture, query }, 'control' 이면 item = { gesture, action }
ipcMain.handle('settings:test', (_e, { kind, item }) => {
  const clean = cleanSettings(kind === 'genre' ? { genres: [item] } : { controls: [item] }); // (platform 은 여기선 안 씀)
  const it = kind === 'genre' ? clean.genres[0] : clean.controls[0];
  if (!it) return { ok: false, reason: '빈 칸을 채워 주세요' };
  runGesture({ kind, item: it }, 'settings');
  return { ok: true };
});

/* 외부 프로그램용 작은 HTTP 서버
   파이썬 예시:
     requests.post('http://127.0.0.1:8899/gesture', json={'name': 'swipe_right'})
   터미널 예시:
     curl -X POST http://127.0.0.1:8899/gesture -d '{"name":"swipe_right"}'
     curl http://127.0.0.1:8899/now            ← 지금 장르·곡 정보 (OLED 표시용)
   라즈베리파이처럼 "다른 기기"에서 보내려면 config.json 에
     "gestureServer": { "host": "0.0.0.0", "port": 8899 }
   를 넣으세요. (같은 와이파이의 누구나 곡을 넘길 수 있게 되니 집/학교망에서만)
   끄려면 "gestureServer": false */
let gestureServer = null;

function startGestureServer() {
  const conf = loadConfig().gestureServer;
  if (conf === false) return;
  const { host = '127.0.0.1', port = 8899 } = conf || {};
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  gestureServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    // 지금 고른 카메라가 보낸 것만 믿음 (맥북 카메라를 쓰는 동안엔 라즈베리파이가 보내는 건 무시, 그 반대도)
    const fromSource = settings.source === 'mac' ? local : settings.source === 'pi';
    if (url.pathname === '/now') {
      if (url.searchParams.has('present') && fromSource) {
        reportPresence(url.searchParams.get('present') === '1', url.searchParams.has('people') ? Number(url.searchParams.get('people')) : null);
      }
      return json(res, 200, currentTrack
        ? {
            id: currentTrack.id, // 곡이 바뀌면 OLED 가 /lyrics 로 가사를 새로 받아감
            title: currentTrack.title, artist: currentTrack.artist, isPlaying: currentTrack.isPlaying, genre: currentGenre,
            // OLED 곡 진행 바 · 가사용 (ms). Spotify 는 1.5초마다만 물어보니까 그 사이 흐른 시간을 더해 "지금" 위치로
            progress: currentTrack.isPlaying && currentTrack.at
              ? Math.min(currentTrack.duration || Infinity, currentTrack.progress + (Date.now() - currentTrack.at))
              : currentTrack.progress,
            duration: currentTrack.duration,
            mode: settings.mode, // OLED: DJ · 인식만 표시
          }
        : { genre: currentGenre, mode: settings.mode });
    }
    // 지금 곡의 가사 (OLED 가사 화면용). ready: 가사 찾기가 끝났는지 (false 면 조금 뒤 다시 물어봄)
    //   { id, ready, lines: [{ t: 시작 ms, text }] 또는 null (가사 없음) }
    if (url.pathname === '/lyrics') {
      const id = currentTrack?.id || null;
      return json(res, 200, { id, ready: !!id && lyricsCache.has(id), lines: (id && lyricsCache.get(id)) || null });
    }
    // 워치 등: 지금 몸 상태 → 상황 엔진 (5분 유효)  {"activity":"still|walking|running","heart":72}
    // 알아서 틀기: POST /auto  (제스처 이름을 몰라도 됨)
    if (url.pathname === '/context' || url.pathname === '/auto') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e4) req.destroy(); });
      req.on('end', () => {
        if (url.pathname === '/auto') {
          if (Date.now() - lastGestureAt < GESTURE_COOLDOWN_MS) return json(res, 200, { ok: false, reason: 'cooldown' });
          lastGestureAt = Date.now();
          broadcast('gesture', { name: 'auto', kind: 'control', label: CONTROL_ACTIONS.auto, source: 'http', sound: settings.feedback.sound });
          control('auto');
          return json(res, 200, { ok: true });
        }
        let j = {};
        try { j = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams); } catch { return json(res, 400, { ok: false }); }
        const heart = Number(j.heart);
        bodySignal = {
          activity: ACTIVITY_NAMES[j.activity] ? j.activity : null,
          heart: heart > 20 && heart < 250 ? Math.round(heart) : null,
          at: Date.now(),
        };
        json(res, 200, { ok: true, situation: sitLabel(situationNow()) });
      });
      return;
    }
    if (url.pathname !== '/gesture') return json(res, 404, { ok: false });
    // 맥북 카메라를 쓰는 동안엔 다른 기기(라즈베리파이)가 보내는 제스처는 무시 (둘이 동시에 조작하지 않게)
    if (settings.source === 'mac' && !local) return json(res, 200, { ok: false, reason: 'source' });
    // GET /gesture?name=swipe_right 도 받아줌 (브라우저 주소창으로 시험하기 쉽게)
    if (req.method === 'GET') return json(res, 200, handleGesture(url.searchParams.get('name'), 'http'));
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      try {
        json(res, 200, handleGesture(JSON.parse(body).name, 'http'));
      } catch {
        json(res, 400, { ok: false, reason: 'JSON 형식: {"name":"swipe_right"}' });
      }
    });
  });
  gestureServer.on('error', (e) => console.error('제스처 서버 오류:', e.message));
  gestureServer.listen(port, host, () => console.log(`제스처 서버: http://${host}:${port}/gesture`));
}

/* ============================================================
   가사 (LRCLIB)
   ============================================================
   어느 플랫폼이든 가사는 따로 찾아야 해서 무료 가사 사이트 lrclib.net 을 써요 (키 필요 없음).
   "[01:23.45] 가사" 형식(LRC)을 받아서 [{ t: 83450, text: '가사' }, ...] 로 바꿔 화면에 보내요.
   화면은 재생 위치에 맞는 줄을 골라서 보여줘요. */

const LRCLIB = 'https://lrclib.net/api';
const LRCLIB_HEADERS = { 'User-Agent': 'spotify-spin-widget/1.1 (desktop widget)' };

// "[01:23.45] 가사" → { t: 83450, text: '가사' }
function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, m, s] of stamps) lines.push({ t: Math.round((Number(m) * 60 + Number(s)) * 1000), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function findLyrics(t) {
  const artist = t.artist.split(', ')[0];
  const sec = Math.round(t.duration / 1000);
  const q = new URLSearchParams({ track_name: t.title, artist_name: artist, album_name: t.album, duration: sec });
  let res = await fetch(`${LRCLIB}/get?${q}`, { headers: LRCLIB_HEADERS });
  if (res.ok) {
    const j = await res.json();
    if (j.syncedLyrics) return parseLrc(j.syncedLyrics);
  }
  // 앨범명/길이가 조금 달라도 찾을 수 있게 검색으로 한 번 더
  res = await fetch(`${LRCLIB}/search?${new URLSearchParams({ track_name: t.title, artist_name: artist })}`, {
    headers: LRCLIB_HEADERS,
  });
  if (!res.ok) return null;
  const hit = (await res.json())
    .filter((r) => r.syncedLyrics && Math.abs(r.duration - sec) <= 3)
    .sort((a, b) => Math.abs(a.duration - sec) - Math.abs(b.duration - sec))[0];
  return hit ? parseLrc(hit.syncedLyrics) : null;
}

async function loadLyrics(t) {
  if (!t?.id) return broadcast('lyrics', null);
  if (!lyricsCache.has(t.id)) {
    let lines = null;
    if (t.title && t.artist && t.duration) { // 제목·가수·길이를 알아야 찾을 수 있음
      try {
        lines = await findLyrics(t);
      } catch (e) {
        console.error('가사 검색 실패:', e.message);
        return broadcast('lyrics', { id: t.id, lines: null }); // 실패는 기억하지 않음
      }
    }
    lyricsCache.set(t.id, lines);
  }
  broadcast('lyrics', { id: t.id, lines: lyricsCache.get(t.id) });
}

/* ============================================================
   재생 정보 폴링 (1.5초마다 "지금 뭐 재생 중?")
   ============================================================
   loop() → poll() → 결과를 화면에 broadcast → 다음 loop 예약
   곡이 바뀐 순간(isNew)에만 노치를 펼치고(peek) 가사를 새로 찾아요. */

function toTrack(j) {
  const item = j?.item;
  if (!item) return null;
  const images = item.album?.images || item.images || item.show?.images || [];
  return {
    id: item.id || item.uri,
    uri: item.uri,
    title: item.name,
    artist: item.artists ? item.artists.map((a) => a.name).join(', ') : item.show?.name || '',
    album: item.album?.name || '',
    image: images[0]?.url || '',
    isPlaying: !!j.is_playing,
    progress: j.progress_ms || 0,
    duration: item.duration_ms || 0,
  };
}

// Spotify 가 아닌 플랫폼: 담당(players/)에게 지금 곡을 물어봄
async function pollPlayer() {
  // 유튜브로 대신 틀던 중에 원래 앱(Apple Music)에서 다시 재생을 시작했으면 그쪽으로 돌아감
  if (active !== platform() && platform() === 'apple' && (await players.apple.now())?.isPlaying) setActive('apple');

  const t = await players[active].now();
  if (!t) {
    currentTrack = null;
    broadcast('track', null);
    djTick(false, null);
    return POLL_MS;
  }
  t.at = Date.now(); // progress 를 받은 시각 (/now 가 그 사이 흐른 시간을 더해서 보냄)
  checkGenreContext(t.context || null);
  tickSession(!!t.isPlaying, t.context || null, t);
  djTick(!!t.isPlaying, t);
  const isNew = t.id !== lastTrackId;
  t.accent = await accentOf(t.image);
  currentTrack = t;
  broadcast('track', t);
  if (isNew) {
    lastTrackId = t.id;
    peek();
    loadLyrics(t);
  }
  return POLL_MS;
}

// 다음 폴링까지 기다릴 ms 를 반환
async function poll() {
  if (active !== 'spotify') return pollPlayer();
  const res = await spotifyApi('GET', '/me/player/currently-playing?additional_types=track,episode');

  if (res.status === 429) return (Number(res.headers.get('retry-after')) || 5) * 1000;
  if (res.status === 204 || !res.ok) {
    currentTrack = null;
    broadcast('track', null);
    if (res.status === 204) djTick(false, null); // 아무것도 안 나옴 (잠깐 안 되는 것(5xx)은 빼고)
    return POLL_MS * 2;
  }

  const json = await res.json();
  checkGenreContext(json.context?.uri || null);
  const t = toTrack(json);
  if (t) t.at = Date.now(); // progress 를 받은 시각 (/now 가 그 사이 흐른 시간을 더해서 보냄)
  tickSession(!!json.is_playing, json.context?.uri || null, t);
  djTick(!!json.is_playing, t);
  if (t) {
    const isNew = t.id !== lastTrackId;
    if (isNew) likedCache.delete(t.uri); // Spotify 앱에서 바꿨을 수도 있으니 곡마다 새로 확인
    // 곡이 바뀌면 색과 좋아요 여부를 먼저 구한 뒤 한 번에 보냄
    [t.accent, t.liked] = await Promise.all([accentOf(t.image), fetchLiked(t.uri)]);
    currentTrack = t;
    broadcast('track', t);
    if (isNew) {
      lastTrackId = t.id;
      peek(); // 곡이 바뀌면 노치가 잠깐 펼쳐짐
      loadLyrics(t);
    }
  } else {
    currentTrack = null;
    broadcast('track', null);
  }
  return POLL_MS;
}

async function loop() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  let delay = POLL_MS;
  try {
    delay = await poll();
  } catch (e) {
    console.error(e.message);
    polling = false;
    // 리프레시 토큰이 만료/취소됨 → 다시 로그인 필요
    if (active === 'spotify' && (e.status === 400 || e.status === 401)) return logout();
    delay = 5000;
  }
  polling = false;
  if (canUse()) pollTimer = setTimeout(loop, delay);
}

// 버튼을 누른 뒤 화면이 빨리 따라오도록 곧바로 한 번 더 확인
function pollSoon() {
  if (!canUse()) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(loop, 400);
}

function startPolling() {
  stopPolling();
  loop();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

/* ============================================================
   노치 창
   ============================================================
   - 메뉴바 높이 = 노치 높이 (노치 있는 맥북은 메뉴바가 노치만큼 두꺼움)
   - 노치 너비는 Electron 이 알려주지 않아서 추정값을 씀 (config.json 의 notchWidth 로 조절)
   - 'screen-saver' 층에 두어야 메뉴바 위에 그려짐
   - setIgnoreMouseEvents(true, { forward: true }) : 클릭은 뒤로 통과, 마우스 움직임은 화면이 받음 */
// 창 크기는 그대로 두고 notch.html 이 그림을 펼치고 접음. 접혀 있을 땐 알약 말고는 클릭이 뒤로 통과함.

function notchLayout() {
  const d = screen.getAllDisplays().find((x) => x.internal) || screen.getPrimaryDisplay();
  const bar = d.workArea.y - d.bounds.y; // 메뉴바 높이 (노치 있는 맥은 노치 높이와 같음)
  const width = NOTCH_PANEL_W + NOTCH_PAD * 2;
  return {
    x: Math.round(d.bounds.x + d.bounds.width / 2 - width / 2),
    y: d.bounds.y,
    width,
    height: NOTCH_CARD_H + 16,
    menuH: bar >= 24 ? bar : 32,
    notchW: loadConfig().notchWidth || NOTCH_DEFAULT_W,
  };
}

function createNotch() {
  const L = notchLayout();
  notchWin = new BrowserWindow({
    x: L.x,
    y: L.y,
    width: L.width,
    height: L.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    title: 'Snaptune',
    enableLargerThanScreen: true, // 메뉴바 위(노치 자리)까지 올라갈 수 있게
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // 창이 포커스가 없어도 웹캠 인식이 느려지지 않게
      autoplayPolicy: 'no-user-gesture-required', // 클릭 없이도 인식 알림음을 낼 수 있게
    },
  });
  notchWin.setAlwaysOnTop(true, 'screen-saver'); // 메뉴바보다 위
  notchWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notchWin.setIgnoreMouseEvents(true, { forward: true });
  notchWin.on('closed', () => app.quit());
  // 화면 구성이 바뀌면(외장 모니터 연결 등) 다시 노치 자리로
  screen.on('display-metrics-changed', placeNotch);
  screen.on('display-added', placeNotch);
  screen.on('display-removed', placeNotch);
  return notchWin.loadFile('notch.html');
}

function placeNotch() {
  if (!notchWin || notchWin.isDestroyed()) return;
  const L = notchLayout();
  notchWin.setBounds({ x: L.x, y: L.y, width: L.width, height: L.height });
  notchWin.webContents.send('layout', { menuH: L.menuH, notchW: L.notchW });
}

function peek() {
  broadcast('peek');
}

/* ============================================================
   IPC — 화면에서 오는 요청 처리
   ============================================================ */

ipcMain.handle('get-state', () => {
  const { menuH, notchW } = notchLayout();
  return {
    status,
    layout: { menuH, notchW },
    track: currentTrack,
    lyrics: currentTrack && lyricsCache.has(currentTrack.id)
      ? { id: currentTrack.id, lines: lyricsCache.get(currentTrack.id) }
      : null,
    camera: settings.camera,
    genre: currentGenre,
    platform: platformInfo(),
    platforms: PLATFORMS, // 처음 켰을 때 고를 음악 앱 목록
    recognizers: loadConfig().recognizers || {}, // 켤 인식기 목록 (config.json)
    piStream: streamUrl(), // 카메라 영상 주소 — 라즈베리파이 또는 맥북 (있으면 카메라 칸에 띄움)
  };
});
ipcMain.on('login', login);
// 처음 켰을 때 노치에서 음악 앱을 고름 → 저장하고 그 앱으로 시작 (Spotify 면 그다음에 로그인 안내)
ipcMain.on('choose-platform', (_e, id) => {
  if (!PLATFORMS[id]) return;
  firstRun = false;
  const same = settings.platform === id;
  saveSettings({ ...settings, platform: id }); // 처음 저장 → 다음부터는 안 물어봄
  if (same) applyPlatform(); // 플랫폼이 그대로면 saveSettings 가 다시 시작하지 않으니 직접
  if (id !== 'spotify') notice(`${PLATFORMS[id]}로 할게요 · 바꾸려면 설정에서`);
});
ipcMain.on('open-settings', openSettings); // 노치의 톱니바퀴 버튼
ipcMain.on('open-analytics', openAnalytics);
ipcMain.handle('auto:analytics', (_e, { days = 30 } = {}) => analyticsReport(days));
ipcMain.on('control', (_e, action) => control(action));

// 웹캠 인식기가 확정한 제스처
ipcMain.on('gesture', (_e, name) => handleGesture(name, 'camera'));

// 카메라 켜기/끄기 (설정에 저장돼서 다음 실행에도 유지)
function setCamera(on) {
  saveSettings({ ...settings, camera: on });
}

// macOS 카메라 권한. 처음 한 번 시스템 창이 뜨고, 거절하면
// 시스템 설정 > 개인정보 보호 및 보안 > 카메라 에서 터미널(또는 Electron)을 켜야 해요.
ipcMain.handle('camera-access', async () => {
  if (process.platform !== 'darwin') return true;
  if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
  return systemPreferences.askForMediaAccess('camera');
});

// 알약 위에 마우스가 있거나 펼쳐져 있을 때만 클릭을 받음
ipcMain.on('interactive', (_e, on) => notchWin.setIgnoreMouseEvents(!on, { forward: true }));

/* ---------- 카메라 고르기: 라즈베리파이 웹캠 / 맥북 카메라 ----------
   인식은 둘 다 같은 프로그램(pi/gesture_pi.py: MediaPipe + scikit-learn)이 해요.
     pi  : 라즈베리파이에서 돌고, 영상은 config.json 의 piStream 주소로 옴
     mac : 이 앱이 맥에서 직접 켜요. 영상은 http://127.0.0.1:8091/stream
           파이썬 환경·모델·녹화한 샘플은 userData/gesture 폴더에 둬요 (앱을 다시 만들어도 안 지워지게)
           처음 고르면 pi/setup-mac.sh 로 한 번 설치해요 (1~3분)
   학습은 따로예요: 파이에서 학습한 동작을 맥북에서도 쓰려면 설정 화면의 "라즈베리파이 샘플 가져오기". */
const { execFile, spawn } = require('child_process');
const MAC_STREAM_PORT = 8091;
const gestureHome = () => path.join(app.getPath('userData'), 'gesture');
const gestureCode = () => path.join(__dirname, 'pi');
const macPython = () => path.join(gestureHome(), '.venv', 'bin', 'python');
let macProc = null; // 켜져 있는 인식 프로그램
let macSetup = false; // 설치 중

function streamUrl() {
  if (settings.source === 'mac') return `http://127.0.0.1:${MAC_STREAM_PORT}/stream`;
  if (settings.source === 'pi') return loadConfig().piStream || null;
  return null;
}

const macReady = () => fs.existsSync(macPython()) && fs.existsSync(path.join(gestureHome(), 'models', 'pose_landmarker_lite.task'))
  && fs.existsSync(path.join(gestureHome(), 'config.json'));

async function startMacCamera() {
  if (macProc || macSetup) return;
  // 카메라 권한 (처음 한 번 맥이 물어봄)
  if (systemPreferences.getMediaAccessStatus('camera') !== 'granted' && !(await systemPreferences.askForMediaAccess('camera'))) {
    return notice('카메라 권한이 없어요 (시스템 설정 → 개인정보 보호 및 보안 → 카메라)');
  }
  if (settings.source !== 'mac' || macProc || macSetup) return; // 물어보는 사이에 바뀌었을 수 있음
  if (!macReady()) return setupMacCamera();
  const log = fs.openSync(path.join(gestureHome(), 'camera.log'), 'w'); // 안 될 때 여기를 보면 돼요
  const proc = spawn(macPython(), ['-u', path.join(gestureCode(), 'gesture_pi.py')], {
    env: { ...process.env, GESTURE_HOME: gestureHome() },
    stdio: ['ignore', log, log],
  });
  macProc = proc;
  proc.on('exit', (code) => {
    if (macProc !== proc) return; // 우리가 끈 것
    macProc = null;
    if (settings.source === 'mac') notice(`맥북 카메라 인식이 꺼졌어요 (코드 ${code}) — 우클릭 → 카메라에서 다시 고르세요`);
  });
}

function stopMacCamera() {
  const proc = macProc;
  macProc = null;
  proc?.kill();
}

function setupMacCamera() {
  macSetup = true;
  notice('맥북 카메라 인식을 처음 설치하는 중… (1~3분)');
  fs.mkdirSync(gestureHome(), { recursive: true });
  const log = fs.openSync(path.join(gestureHome(), 'setup.log'), 'w');
  const conf = loadConfig().gestureServer;
  const proc = spawn('/bin/bash', [path.join(gestureCode(), 'setup-mac.sh'), gestureHome()], {
    env: { ...process.env, GESTURE_PORT: String((conf && conf.port) || 8899), STREAM_PORT: String(MAC_STREAM_PORT) },
    stdio: ['ignore', log, log],
  });
  proc.on('exit', (code) => {
    macSetup = false;
    if (code !== 0 || !macReady()) return notice('맥북 카메라 설치에 실패했어요 (인터넷 연결 확인)');
    notice('맥북 카메라 설치 완료');
    if (settings.source === 'mac') startMacCamera();
  });
}

// 카메라 종류가 바뀌면(또는 앱을 켜면): 맥북 인식을 켜거나 끄고, 노치의 영상 주소를 바꿔줌
function applySource() {
  if (settings.source === 'mac') startMacCamera();
  else stopMacCamera();
  broadcast('stream', streamUrl());
  helloPi();
}

/* 라즈베리파이에게 "제스처는 이 맥으로 보내" 알려주기 (20초마다)
   파이는 요청이 온 IP 를 맥 주소로 써요 → 파이 설정 파일에 맥 IP 를 안 적어도 되고, 맥 IP 가 바뀌어도 따라가요. */
let helloTimer = null;
async function helloPi() {
  clearTimeout(helloTimer);
  if (settings.source !== 'pi') return;
  const base = piBase();
  if (base) {
    try {
      await fetch(`${base}/api/mac`, {
        method: 'POST', body: JSON.stringify({ port: loadConfig().gestureServer?.port || 8899 }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {}
  }
  helloTimer = setTimeout(helloPi, 20000);
}

/* ---------- 라즈베리파이 켜기/끄기 ----------
   config.json 의 "pi": "ubuntu@192.168.0.10" 으로 SSH 접속해서 systemctl 로 서비스를 조작해요.
   비밀번호 없이 들어가는 SSH 키가 맥에 등록돼 있어야 해요 (ssh-copy-id). */
let piState = '확인 중';

function ssh(command) {
  return new Promise((resolve) => {
    execFile('/usr/bin/ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', loadConfig().pi, command],
      { timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function refreshPiState() {
  if (!loadConfig().pi) return;
  const out = await ssh('systemctl is-active gesture-pi');
  piState = out === 'active' ? '켜짐' : out ? '꺼짐' : '연결 안 됨';
}

async function piService(action) {
  notice(`라즈베리파이 인식 ${{ start: '켜는', stop: '끄는', restart: '다시 켜는' }[action]} 중…`);
  const out = await ssh(`sudo systemctl ${action} gesture-pi && systemctl is-active gesture-pi || true`);
  await refreshPiState();
  notice(out === null ? '라즈베리파이에 연결하지 못했어요 (같은 와이파이·VPN 확인)' : `라즈베리파이 인식: ${piState}`);
}

ipcMain.on('context-menu', async () => {
  await Promise.race([refreshPiState(), new Promise((r) => setTimeout(r, 1500))]); // 메뉴가 늦게 뜨지 않게 1.5초까지만
  Menu.buildFromTemplate([
    { label: '곡 미리보기', enabled: !!currentTrack, click: peek },
    {
      // 보통 / 인식만 / DJ
      label: `모드 (${MODES[settings.mode]})`,
      submenu: Object.entries(MODES).map(([id, name]) => ({
        label: `${name} — ${MODE_HELP[id]}`, type: 'radio', checked: settings.mode === id, click: () => setMode(id),
      })),
    },
    {
      // 제스처를 알아볼 카메라: 라즈베리파이 웹캠 / 맥북 카메라 / 끄기
      label: `카메라 (${SOURCES[settings.source]}${macSetup ? ' · 설치 중' : ''})`,
      submenu: Object.entries(SOURCES).map(([id, name]) => ({
        label: name, type: 'radio', checked: settings.source === id,
        // 파이 주소가 아직 없으면 설정 창의 카메라 칸에서 주소를 적게 함
        click: () => (id === 'pi' && !loadConfig().piStream ? openSettings() : saveSettings({ ...settings, source: id })),
      })),
    },
    {
      // 카메라 없이 제스처 → 조작 흐름을 시험 (쿨다운도 똑같이 적용)
      label: '제스처 테스트',
      submenu: [
        ...settings.genres.map((g) => ({ label: `${g.gesture} → ${g.genre}`, click: () => handleGesture(g.gesture, 'menu') })),
        { type: 'separator' },
        ...settings.controls.map((c) => ({
          label: `${c.gesture} → ${CONTROL_ACTIONS[c.action]}`,
          click: () => handleGesture(c.gesture, 'menu'),
        })),
      ],
    },
    {
      label: `음악 플랫폼 (${PLATFORMS[platform()]})`,
      submenu: Object.entries(PLATFORMS).map(([id, name]) => ({
        label: name, type: 'radio', checked: platform() === id,
        click: () => saveSettings({ ...settings, platform: id }),
      })),
    },
    // 유튜브로 틀고 있을 때: 창을 꺼내서 로그인하거나 직접 고를 수 있음
    ...[...new Set([platform(), active])].filter((id) => id === 'youtube' || id === 'ytmusic')
      .map((id) => ({ label: `${PLATFORMS[id]} 창 보기 (로그인 · 직접 고르기)`, click: () => players[id].show() })),
    // 장르를 유튜브로 대신 틀고 있을 때: 원래 플랫폼 조작으로 돌아가기
    ...(active !== platform()
      ? [{ label: `${PLATFORMS[platform()]} 조작으로 돌아가기`, click: () => { setActive(platform()); currentGenre = genreContext = null; broadcast('genre', null); pollSoon(); } }]
      : []),
    { label: '알아서 틀기 (상황 엔진)', click: () => control('auto') },
    ...(currentGenre && settings.genres.some((g) => g.genre === currentGenre && !g.playlist)
      ? [{ label: `${currentGenre} 다른 플리로`, click: () => otherPlaylist() }]
      : []),
    { label: '설정…', click: openSettings },
    { label: '분석…', click: openAnalytics },
    { type: 'separator' },
    // 라즈베리파이 인식 프로그램 켜기/끄기 (SSH 로 파이의 gesture-pi 서비스를 조작)
    ...(loadConfig().pi
      ? [{
          label: `라즈베리파이 인식 (${piState})`,
          submenu: [
            { label: '켜기', click: () => piService('start') },
            { label: '끄기', click: () => piService('stop') },
            { label: '다시 켜기', click: () => piService('restart') },
          ],
        }]
      : [{ label: '라즈베리파이 연결…', click: openSettings }]),
    // 맥에 로그인하면 자동으로 켜기 (.app 으로 실행했을 때만)
    {
      label: '로그인할 때 자동 실행',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    ...(platform() === 'spotify' ? [tokens ? { label: 'Spotify 로그아웃', click: logout } : { label: 'Spotify 로그인', click: login }] : []),
    { label: '종료', click: () => app.quit() },
  ]).popup({ window: notchWin });
});

/* ============================================================
   시작 — 앱이 켜지면 여기서부터
   ============================================================
   노치 창 만들기 → 고른 플랫폼 준비 (Spotify: 저장된 토큰이 있으면 바로 폴링 시작, 없으면 로그인 안내) */

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide(); // 독에 아이콘 없이 노치에만
  loadFavorites();
  loadHistory();
  loadSettings(); // 제스처 설정 (창보다 먼저: 화면이 처음 물어볼 때 필요)
  await createNotch();
  startGestureServer(); // 외부 프로그램이 제스처를 보낼 수 있게

  applyPlatform(); // 설정에서 고른 플랫폼으로 시작 (Spotify 면 저장된 로그인으로 바로 연결)
  applySource(); // 맥북 카메라를 골라 뒀으면 인식 프로그램 켜기
  startAutomation(); // 자리 비움 감지 · 시간대별 장르
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  endSession(false); // 듣던 것 기록
  stopPolling();
  stopMacCamera(); // 카메라 불이 꺼지게
  gestureServer?.close();
  for (const p of Object.values(players)) p.destroy(); // 숨은 유튜브 창까지 닫아야 앱이 꺼짐
});
