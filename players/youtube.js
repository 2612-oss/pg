// ============================================================
// players/youtube.js — 유튜브 / 유튜브 뮤직 플레이어
// ============================================================
// 로그인·API 키 없이 쓰려고, 앱 안에 "숨은 창" 하나를 만들어 거기서 유튜브를 틀어요.
//   장르 제스처 → 유튜브에서 "rock playlist" 를 검색 → 플레이리스트 하나를 골라 숨은 창에서 재생
//   재생/다음 곡/볼륨 → 숨은 창 안의 유튜브 플레이어를 자바스크립트로 조작
//   지금 곡 정보      → 유튜브가 브라우저에 알려주는 정보(mediaSession)를 읽음
//
// 유튜브 뮤직(music: true)도 같은 방식이고, 여는 주소만 music.youtube.com 이에요.
// 단, 한국에선 유튜브 뮤직이 프리미엄 로그인 없이는 재생이 안 돼서 그땐 일반 유튜브로 대신 틀어요.
// 광고가 나올 수 있어요. 프리미엄 계정이면 우클릭 → "유튜브 창 보기" 에서 한 번 로그인하면 돼요.
//
// 사이트 구조가 바뀌면 고쳐야 할 곳: search() 의 검색 결과 읽기, JS_NOW / control() 의 버튼 이름
// ============================================================

const { BrowserWindow, net } = require('electron');

// 일반 크롬인 척 (Electron 이라고 하면 구글 로그인이 막힐 때가 있음)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const RECENT_KEEP = 5;

// 숨은 창 안에서 실행해서 지금 상태를 읽어오는 코드
const JS_NOW = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  // 광고 건너뛰기 버튼이 뜨면 눌러줌
  const skip = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
  if (skip) skip.click();
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  const u = new URL(location.href);
  const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
  const music = location.host === 'music.youtube.com';
  let liked = null; // 로그인했을 때만 좋아요를 알 수 있음
  if (music) {
    const b = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer');
    if (b && !document.querySelector('a.sign-in-link')) liked = b.getAttribute('like-status') === 'LIKE';
  } else if (document.querySelector('#avatar-btn')) {
    const b = document.querySelector('like-button-view-model button');
    if (b) liked = b.getAttribute('aria-pressed') === 'true';
  }
  return {
    id: u.searchParams.get('v'), list: u.searchParams.get('list'),
    title: (md && md.title) || document.title.replace(/ - YouTube( Music)?$/, ''),
    artist: (md && md.artist) || '', album: (md && md.album) || '', art,
    paused: v.paused, pos: v.currentTime || 0, dur: isFinite(v.duration) ? v.duration : 0,
    ad: !!document.querySelector('.ad-showing'), liked,
  };
})()`;

function createYouTube({ music = false } = {}) {
  let win = null;
  let wantPlayUntil = 0; // 막 틀었는데 멈춰 있으면 한 번 더 재생을 눌러줌 (자동 재생이 막혔을 때)
  const recent = new Map(); // 장르 → 최근에 튼 플레이리스트들 (매번 다른 걸 틀려고)
  const name = music ? 'YouTube Music' : 'YouTube';

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: 1080, height: 720, show: false, title: name,
      webPreferences: {
        partition: 'persist:youtube', // 로그인 정보를 따로 저장 (다음에 켜도 유지)
        backgroundThrottling: false, // 숨어 있어도 느려지지 않게
        autoplayPolicy: 'no-user-gesture-required', // 클릭 없이도 소리가 나게
      },
    });
    win.webContents.setUserAgent(UA);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // 새 창(광고 등)은 안 엶
    // 창을 닫아도 음악은 계속 나오게 "숨기기"만 함. 진짜로 없애는 건 destroy()
    win.on('close', (e) => { e.preventDefault(); win.hide(); });
    return win;
  }

  const run = (code) => (win && !win.isDestroyed() ? win.webContents.executeJavaScript(code, true).catch(() => null) : Promise.resolve(null));

  // 유튜브에서 플레이리스트 검색 → [{ list: 플레이리스트 id, video: 첫 영상 id }]
  async function search(query) {
    const q = encodeURIComponent(/playlist|플레이리스트|mix|믹스/i.test(query) ? query : `${query} playlist`);
    // sp=EgIQAw%3D%3D : "플레이리스트만" 필터
    const res = await net.fetch(`https://www.youtube.com/results?search_query=${q}&sp=EgIQAw%253D%253D&hl=ko`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko,en' },
    });
    const html = await res.text();
    const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s); // 검색 결과가 이 변수에 통째로 들어 있음
    if (!m) return [];
    const found = new Map();
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      const w = o.watchEndpoint;
      if (w && w.videoId && w.playlistId && !found.has(w.playlistId)) found.set(w.playlistId, w.videoId);
      for (const v of Object.values(o)) walk(v);
    })(JSON.parse(m[1]));
    return [...found].map(([list, video]) => ({ list, video }));
  }

  return {
    name,
    needsLogin: false,

    // 장르 틀기. 성공하면 { context, label }, 못 찾으면 null
    async playGenre(g) {
      const all = await search(g.query);
      if (!all.length) return null;
      const seen = recent.get(g.genre) || [];
      const fresh = all.slice(0, 10).filter((p) => !seen.includes(p.list));
      const pool = fresh.length ? fresh : all.slice(0, 10);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      recent.set(g.genre, [...seen, pick.list].slice(-RECENT_KEEP));
      const host = music ? 'music.youtube.com' : 'www.youtube.com';
      wantPlayUntil = Date.now() + 15000;
      const url = `https://${host}/watch?v=${pick.video}&list=${pick.list}`;
      const w = ensure();
      if (!music) {
        w.loadURL(url).catch(() => {});
      } else {
        // 한국에선 유튜브 뮤직이 프리미엄 계정으로 로그인해야만 재생돼요.
        // 로그인이 안 돼 있으면 가입 안내 페이지로 튕기니까, 그땐 null → main.js 가 일반 유튜브로 대신 틀어요.
        await w.loadURL(url).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        if (!/^https:\/\/music\.youtube\.com\/watch/.test(w.webContents.getURL())) {
          wantPlayUntil = 0;
          return null;
        }
      }
      return { context: pick.list, label: name };
    },

    // 지금 곡 → main.js 가 쓰는 모양 (없으면 null)
    async now() {
      const s = await run(JS_NOW);
      if (!s || !s.id) return null;
      if (s.paused && Date.now() < wantPlayUntil) run(`document.querySelector('video')?.play()`);
      else if (!s.paused) wantPlayUntil = 0;
      return {
        id: s.ad ? 'yt:ad' : `yt:${s.id}`, uri: `yt:${s.id}`, context: s.list, // 광고는 다른 곡으로 쳐서, 끝나면 진짜 곡의 가사를 다시 찾게
        title: s.ad ? '광고' : s.title, artist: s.ad ? name : s.artist, album: s.album,
        image: s.art || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`,
        isPlaying: !s.paused, progress: Math.round(s.pos * 1000), duration: Math.round(s.dur * 1000),
        liked: s.liked,
      };
    },

    // 재생 조작. 안내할 말이 있으면 글자를 돌려줌
    async control(action) {
      wantPlayUntil = 0;
      const bar = (cls) => `document.querySelector('ytmusic-player-bar ${cls}')?.click()`;
      const player = `document.getElementById('movie_player')`;
      switch (action) {
        case 'play': return void run(`document.querySelector('video')?.play()`);
        case 'pause': return void run(`document.querySelector('video')?.pause()`);
        case 'next': return void run(music ? bar('.next-button') : `${player}?.nextVideo()`);
        case 'previous': return void run(music ? bar('.previous-button') : `${player}?.previousVideo()`);
        case 'volume_up':
        case 'volume_down': {
          const d = action === 'volume_up' ? 10 : -10;
          const v = await run(`(() => { const p = ${player}; if (!p || !p.setVolume) return null;
            const v = Math.max(0, Math.min(100, p.getVolume() + (${d}))); p.unMute && p.unMute(); p.setVolume(v); return v; })()`);
          return v == null ? '볼륨을 바꾸지 못했어요' : `볼륨 ${v}%`;
        }
        case 'like': {
          const ok = await run(music
            ? `(() => { if (document.querySelector('a.sign-in-link')) return false;
                 const b = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button'); if (!b) return false; b.click(); return true; })()`
            : `(() => { if (!document.querySelector('#avatar-btn')) return false;
                 const b = document.querySelector('like-button-view-model button'); if (!b) return false; b.click(); return true; })()`);
          return ok ? null : '좋아요는 유튜브에 로그인해야 돼요 (우클릭 → 유튜브 창 보기)';
        }
      }
    },

    hasWindow: () => !!win && !win.isDestroyed(),
    // 로그인하거나 직접 고르고 싶을 때 창을 보여줌
    show() {
      const w = ensure();
      if (!w.webContents.getURL()) w.loadURL(music ? 'https://music.youtube.com/' : 'https://www.youtube.com/');
      w.show();
      w.focus();
    },
    stop() { run(`document.querySelector('video')?.pause()`); },
    destroy() { if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}

module.exports = { createYouTube };
