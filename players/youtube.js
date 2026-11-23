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
// 제스처는 유튜브에 맞게 바꿔서 동작해요 (음악 앱과 달리 "영상" 단위라서):
//   다음/이전 → 긴 믹스 영상(12분 넘음)에 챕터가 있으면 챕터(=곡) 단위로, 아니면 다음/이전 영상
//               광고 중이면 건너뛰기 버튼을 눌러요
//   좋아요    → 로그인했으면 유튜브 좋아요, 안 했으면 "이 플리를 단골로" 기억 → 다음에 같은 장르에서 먼저 틀어요
//
// 사이트 구조가 바뀌면 고쳐야 할 곳: search() 의 검색 결과 읽기, JS_NOW / control() 의 버튼 이름
// ============================================================

const { BrowserWindow, net, app } = require('electron');
const path = require('path');
const fs = require('fs');

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

// 지금 영상의 챕터 시작 시각(초) — 1) 유튜브가 페이지에 넣어 둔 챕터  2) 설명란의 "12:34 곡 제목" 줄
const JS_CHAPTERS = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  const id = new URL(location.href).searchParams.get('v');
  let starts = [];
  try {
    const d = window.ytInitialData; // 처음 연 영상에만 맞음 (다음 영상으로 넘어가면 옛날 것이라 id 로 확인)
    if (d && d.currentVideoEndpoint && d.currentVideoEndpoint.watchEndpoint.videoId === id) {
      const bar = d.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar;
      for (const m of bar.multiMarkersPlayerBarRenderer.markersMap || [])
        for (const c of (m.value && m.value.chapters) || []) starts.push(c.chapterRenderer.timeRangeStartMillis / 1000);
    }
  } catch (e) {}
  if (starts.length < 3) {
    starts = [];
    const el = document.querySelector('ytd-watch-metadata #description, #description-inline-expander, ytd-text-inline-expander');
    for (const line of ((el && el.innerText) || '').split('\\n')) {
      const m = line.match(/(?:^|[\\s\\[(])((?:\\d{1,2}:)?\\d{1,2}:\\d{2})(?=$|[\\s\\])])/);
      if (m) starts.push(m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0));
    }
  }
  starts = [...new Set(starts)].filter((t) => t < v.duration).sort((a, b) => a - b);
  return { pos: v.currentTime, dur: isFinite(v.duration) ? v.duration : 0, starts,
    ad: !!document.querySelector('.ad-showing'),
    skip: !!document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern') };
})()`;

const LONG_MIX_SEC = 12 * 60; // 이보다 긴 영상은 "여러 곡 믹스"로 보고 챕터 단위로 넘김

function createYouTube({ music = false } = {}) {
  let win = null;
  let wantPlayUntil = 0; // 막 틀었는데 멈춰 있으면 한 번 더 재생을 눌러줌 (자동 재생이 막혔을 때)
  const recent = new Map(); // 장르 → 최근에 튼 플레이리스트들 (매번 다른 걸 틀려고)
  const name = music ? 'YouTube Music' : 'YouTube';
  let genreNow = null; // 지금 튼 장르 (좋아요 → 단골로 기억할 때 씀)
  let lastNow = null; // 마지막으로 읽은 곡 (좋아요할 때 지금 플리 id)

  // 로그인 없이 누른 좋아요 = 장르별 단골 플리 { 장르: [{ list, video }] } — 유튜브·유튜브 뮤직이 같이 씀
  const favFile = () => path.join(app.getPath('userData'), 'youtube-favorites.json');
  const loadFavs = () => { try { return JSON.parse(fs.readFileSync(favFile(), 'utf8')); } catch { return {}; } };
  const saveFavs = (f) => { try { fs.writeFileSync(favFile(), JSON.stringify(f, null, 2)); } catch {} };
  const isFav = (list) => !!list && Object.values(loadFavs()).some((a) => a.some((x) => x.list === list));

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
    cooldown: 1600, // 영상 넘김·페이지 로딩이 음악 앱보다 느려서 제스처 사이를 조금 더 띄움
    // 이 플랫폼에서 각 제스처가 실제로 하는 일 (설정 화면 안내)
    gestures: {
      next: '다음 영상 · 긴 믹스 영상은 다음 챕터(곡) · 광고면 건너뛰기',
      previous: '이전 영상 · 긴 믹스는 이전 챕터 · 5초 넘게 봤으면 처음으로',
      toggle: '재생 / 일시정지',
      volume_up: '유튜브 플레이어 볼륨 +10',
      volume_down: '유튜브 플레이어 볼륨 −10',
      like: '로그인했으면 좋아요, 아니면 이 플리를 장르 단골로 기억',
      genre: music ? '유튜브 뮤직에서 플리 검색 (로그인 전엔 유튜브로)' : '유튜브 플레이리스트 검색 · 단골 플리를 먼저',
    },

    // 장르 틀기. 성공하면 { context, label }, 못 찾으면 null
    async playGenre(g) {
      const seen = recent.get(g.genre) || [];
      const favs = (loadFavs()[g.genre] || []).filter((p) => !seen.includes(p.list));
      let pick;
      if (favs.length && Math.random() < 0.6) {
        pick = favs[Math.floor(Math.random() * favs.length)]; // 단골 플리를 먼저 (가끔은 새 플리도 섞음)
      } else {
        const all = await search(g.query);
        if (!all.length) return null;
        const fresh = all.slice(0, 10).filter((p) => !seen.includes(p.list));
        const pool = fresh.length ? fresh : all.slice(0, 10);
        pick = pool[Math.floor(Math.random() * pool.length)];
      }
      genreNow = g.genre;
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
      if (!s || !s.id) return (lastNow = null);
      lastNow = s;
      if (s.liked === null && s.list) s.liked = isFav(s.list); // 로그인 전: 단골로 기억한 플리면 하트
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
        case 'next':
        case 'previous': {
          const c = await run(JS_CHAPTERS);
          if (c && c.ad) { // 광고 중: 건너뛸 수 있으면 누르고, 아니면 기다림 (now() 가 뜨자마자 눌러 줌)
            if (c.skip) { await run(`document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click()`); return '광고 건너뜀'; }
            return '광고 중이에요 · 건너뛰기가 뜨면 바로 넘겨요';
          }
          // 긴 믹스 영상: 챕터(=곡) 단위로 넘김
          if (c && c.dur > LONG_MIX_SEC && c.starts.length >= 3) {
            const i = c.starts.reduce((k, t, j) => (t <= c.pos + 0.5 ? j : k), 0); // 지금 챕터
            let to = null;
            if (action === 'next') to = i + 1 < c.starts.length ? i + 1 : null;
            else to = c.pos - c.starts[i] > 5 ? i : i - 1 >= 0 ? i - 1 : null; // 5초 넘게 들었으면 이 곡 처음으로
            if (to !== null) {
              await run(`(() => { const p = ${player}; if (p && p.seekTo) p.seekTo(${c.starts[to]}, true); else document.querySelector('video').currentTime = ${c.starts[to]}; })()`);
              return `${action === 'next' ? '다음' : '이전'} 곡 · ${to + 1}/${c.starts.length}`;
            }
          }
          if (action === 'next') return void run(music ? bar('.next-button') : `${player}?.nextVideo()`);
          // 이전: 영상을 5초 넘게 봤으면 처음으로, 아니면 이전 영상
          if (!music && c && c.pos > 5) return void run(`${player}?.seekTo(0, true)`);
          return void run(music ? bar('.previous-button') : `${player}?.previousVideo()`);
        }
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
          if (ok) return null;
          // 로그인 전: 이 플리를 장르 단골로 기억 (다시 누르면 뺌)
          const list = lastNow && lastNow.list;
          if (!list || !genreNow) return '좋아요는 유튜브에 로그인해야 돼요 (우클릭 → 유튜브 창 보기)';
          const f = loadFavs();
          const arr = f[genreNow] || [];
          if (arr.some((x) => x.list === list)) {
            f[genreNow] = arr.filter((x) => x.list !== list);
            saveFavs(f);
            return `${genreNow} 단골에서 뺐어요`;
          }
          f[genreNow] = [...arr, { list, video: lastNow.id }].slice(-20);
          saveFavs(f);
          return `${genreNow} 단골로 기억했어요 · 다음에 먼저 틀어요`;
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
