// ============================================================
// players/apple.js — Apple Music (맥의 "음악" 앱)
// ============================================================
// 맥의 음악 앱은 AppleScript 로 조작할 수 있어요. 여기서는 osascript 명령으로 스크립트를 실행해요.
//   지금 곡   : 제목, 가수, 앨범, 재생 위치, 좋아요 여부, 앨범 그림
//   재생 조작 : 재생/일시정지, 이전/다음, 볼륨, 좋아요
//   장르 틀기 : ① 내 플레이리스트 중 이름에 장르가 들어간 것 → ② 보관함에서 장르가 맞는 곡을 모아 재생
//               (Apple Music 전체 카탈로그 검색은 유료 개발자 계정이 있어야 해서 보관함만 써요.
//                보관함에 없으면 null 을 돌려주고, main.js 가 유튜브로 대신 틀어요)
//
// 처음 쓸 때 맥이 "Snaptune 가 음악 앱을 제어하려고 합니다" 라고 물어봐요 → 허용.
// ============================================================

const { execFile } = require('child_process');
const { nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');

const SEP = '\u001f'; // 값 사이 구분 글자 (제목에 절대 안 나오는 글자)

function osa(script, args = [], timeout = 8000) {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout }, (err, out) => resolve(err ? null : out.replace(/\n$/, '')));
  });
}

// 음악 앱이 꺼져 있으면 켜지 않고 "off" (tell application 을 쓰면 앱이 켜져 버려서 먼저 확인)
const NOW = `
if application "Music" is not running then return "off"
tell application "Music"
  if player state is stopped then return "stopped"
  set d to (ASCII character 31)
  set t to current track
  set fav to "?"
  try
    set fav to (favorited of t) as string
  end try
  set pl to ""
  try
    set pl to name of current playlist
  end try
  set pos to 0
  try
    set pos to player position
  end try
  return (persistent ID of t) & d & (name of t) & d & (artist of t) & d & (album of t) & d & (duration of t) & d & pos & d & (player state as string) & d & fav & d & pl
end tell`;

// 앨범 그림을 파일로 저장 (보관함에 있는 곡만 그림을 갖고 있음)
const ARTWORK = `
on run argv
  tell application "Music"
    try
      set t to current track
      if (count of artworks of t) is 0 then return "none"
      set d to raw data of artwork 1 of t
      set f to open for access (POSIX file (item 1 of argv)) with write permission
      set eof f to 0
      write d to f
      close access f
      return "ok"
    on error
      return "none"
    end try
  end tell
end run`;

const GENRE = `
on run argv
  set gname to item 1 of argv
  tell application "Music"
    -- ① 내 플레이리스트 중 이름에 장르/검색어가 들어간 것
    repeat with i from 2 to (count of argv)
      set q to (item i of argv) as text
      repeat with p in (every user playlist whose name contains q)
        if (name of p) does not start with "Notch · " and (count of tracks of p) > 0 then
          set shuffle enabled to true
          play p
          return "ok" & (ASCII character 31) & (name of p)
        end if
      end repeat
    end repeat
    -- ② 보관함에서 장르가 맞는 곡을 모아 "Notch · 락" 플레이리스트로
    repeat with i from 2 to (count of argv)
      set q to (item i of argv) as text
      set ts to (every track of library playlist 1 whose genre contains q)
      set n to (count of ts)
      if n > 0 then
        set plName to "Notch · " & gname
        if (exists user playlist plName) then delete user playlist plName
        set np to make new user playlist with properties {name:plName}
        if n > 60 then set n to 60
        repeat with k from 1 to n
          duplicate (item k of ts) to np
        end repeat
        set shuffle enabled to true
        play np
        return "ok" & (ASCII character 31) & plName
      end if
    end repeat
    return "none"
  end tell
end run`;

function createApple() {
  const artCache = new Map(); // 곡 id → 그림 (data: 주소) 또는 ''
  const artFile = () => path.join(app.getPath('temp'), 'snaptune-artwork');

  async function artworkOf(id, title, artist) {
    if (artCache.has(id)) return artCache.get(id);
    artCache.set(id, ''); // 구하는 동안 또 부르지 않게
    let url = '';
    if ((await osa(ARTWORK, [artFile()])) === 'ok') {
      try {
        const img = nativeImage.createFromBuffer(fs.readFileSync(artFile()));
        if (!img.isEmpty()) url = `data:image/jpeg;base64,${img.resize({ width: 300 }).toJPEG(85).toString('base64')}`;
      } catch {}
    }
    if (!url) {
      // 보관함에 없는 곡(스트리밍)은 그림이 없어서 아이튠즈 검색으로 찾아봄
      try {
        const q = new URLSearchParams({ term: `${title} ${artist}`, entity: 'song', limit: 1, country: 'kr' });
        const hit = (await (await fetch(`https://itunes.apple.com/search?${q}`)).json()).results?.[0];
        if (hit?.artworkUrl100) url = hit.artworkUrl100.replace('100x100', '600x600');
      } catch {}
    }
    artCache.set(id, url);
    if (artCache.size > 50) artCache.delete(artCache.keys().next().value);
    return url;
  }

  return {
    name: 'Apple Music',
    needsLogin: false,

    async now() {
      const out = await osa(NOW);
      if (!out || out === 'off' || out === 'stopped') return null;
      const [id, title, artist, album, dur, pos, state, fav, playlist] = out.split(SEP);
      const num = (s) => Number(String(s).replace(',', '.')) || 0;
      return {
        id: `am:${id}`, uri: `am:${id}`, context: playlist || null,
        title, artist, album,
        image: await artworkOf(id, title, artist),
        isPlaying: state === 'playing',
        progress: Math.round(num(pos) * 1000), duration: Math.round(num(dur) * 1000),
        liked: fav === 'true' ? true : fav === 'false' ? false : null,
      };
    },

    gestures: {
      next: '다음 곡', previous: '이전 곡 · 3초 넘게 들었으면 처음으로', toggle: '재생 / 일시정지',
      volume_up: '음악 앱 볼륨 +10', volume_down: '음악 앱 볼륨 −10', like: '즐겨찾기(♥) 켜고 끄기',
      genre: '내 보관함에서 찾고, 없으면 유튜브로',
    },

    async control(action) {
      const tell = (cmd) => osa(`tell application "Music" to ${cmd}`);
      switch (action) {
        case 'play': return void (await tell('play'));
        case 'pause': return void (await tell('pause'));
        case 'next': return void (await tell('next track'));
        case 'previous': return void (await tell('previous track'));
        case 'volume_up':
        case 'volume_down': {
          const d = action === 'volume_up' ? 10 : -10;
          const v = await osa(`tell application "Music"
            set v to sound volume + (${d})
            if v > 100 then set v to 100
            if v < 0 then set v to 0
            set sound volume to v
            return v
          end tell`);
          return v == null ? '볼륨을 바꾸지 못했어요' : `볼륨 ${v}%`;
        }
        case 'like': {
          const r = await osa(`tell application "Music"
            set t to current track
            set favorited of t to not (favorited of t)
            return favorited of t
          end tell`);
          return r == null ? '좋아요를 바꾸지 못했어요' : null;
        }
      }
    },

    // 성공하면 { context: 플레이리스트 이름, label }, 보관함에 없으면 null
    async playGenre(g) {
      const terms = [...new Set([g.genre, g.query, g.query.replace(/\s+/g, ''), g.query.replace(/\s+/g, '-')])];
      const out = await osa(GENRE, [g.genre, ...terms], 40000);
      if (!out || !out.startsWith('ok')) return null;
      const name = out.split(SEP)[1];
      return { context: name, label: name };
    },

    stop() { osa(`if application "Music" is running then tell application "Music" to pause`); },
    destroy() {},
  };
}

module.exports = { createApple };
