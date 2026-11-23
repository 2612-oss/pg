// ============================================================
// players/melon.js — 멜론 (그리고 "키보드 재생 키로 조작되는 모든 앱")
// ============================================================
// 멜론은 밖에서 조작할 수 있는 공식 방법(API)이 없어요.
// 그래서 키보드의 ⏯ ⏭ ⏮ 키를 "누른 척" 해요. 맥은 그 키를 지금 음악을 틀고 있는 앱(멜론)에 전달해요.
//   되는 것 : 재생/일시정지, 다음 곡, 이전 곡, 볼륨(맥 전체 볼륨)
//   안 되는 것 : 지금 곡 제목·가수·앨범 그림 읽기, 좋아요, 장르 플레이리스트 틀기
//               → 장르 제스처는 main.js 가 유튜브로 대신 틀어요
//
// 처음 쓸 때 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용 에서 Snaptune 를 허용해야 키가 눌려요.
// ============================================================

const { execFile } = require('child_process');

// 맥의 미디어 키 번호
const KEY = { play: 16, next: 17, previous: 18 };

// JXA(자바스크립트로 쓰는 AppleScript)로 미디어 키를 눌렀다 뗌
const PRESS = `
ObjC.import('Cocoa');
function run(argv) {
  const key = parseInt(argv[0], 10);
  for (const state of [0xa, 0xb]) { // 0xa = 누름, 0xb = 뗌
    const ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
      14, { x: 0, y: 0 }, state << 8, 0, 0, $(), 8, (key << 16) | (state << 8), -1);
    $.CGEventPost(0, ev.CGEvent);
  }
}`;

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim()));
});
const press = (key) => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PRESS, String(key)]);

function createMelon() {
  let playing = false; // 멜론이 알려주지 않아서 "내가 누른 것"으로 짐작만 함

  return {
    name: '멜론',
    needsLogin: false,
    nativeToggle: true, // 재생 중인지 알 수 없으니 ⏯ 키 하나로 (짐작해서 잘못 누르지 않게)
    cooldown: 900, // 키 누르기는 바로 먹혀서 짧게
    gestures: {
      next: '다음 곡 (⏭ 키)', previous: '이전 곡 (⏮ 키)', toggle: '재생 / 일시정지 (⏯ 키)',
      volume_up: '맥 전체 볼륨 +10', volume_down: '맥 전체 볼륨 −10',
      like: null, // 안 됨
      genre: '유튜브로 대신 틀어요 (멜론은 밖에서 플리를 고를 수 없어요)',
      note: '멜론 앱이 마지막으로 소리를 낸 앱이어야 ⏯ ⏭ ⏮ 키가 멜론으로 가요.',
    },

    // 곡 정보를 읽을 수 없어서 버튼이 눌리도록 자리만 채운 가짜 곡을 돌려줌
    async now() {
      return {
        id: 'melon', uri: 'melon', context: null,
        title: '멜론', artist: '곡 정보는 멜론 앱에서 확인하세요', album: '',
        image: '', isPlaying: playing, progress: 0, duration: 0, liked: null,
      };
    },

    async control(action) {
      switch (action) {
        case 'toggle':
          playing = !playing;
          return (await press(KEY.play)) === null ? '키를 누르지 못했어요 (손쉬운 사용 권한을 확인하세요)' : null;
        case 'play':
        case 'pause':
          if (playing === (action === 'play')) return null; // 이미 그 상태로 보이면 안 누름 (⏯ 는 토글이라)
          playing = action === 'play';
          return (await press(KEY.play)) === null ? '키를 누르지 못했어요 (손쉬운 사용 권한을 확인하세요)' : null;
        case 'next':
        case 'previous':
          playing = true;
          return (await press(KEY[action])) === null ? '키를 누르지 못했어요 (손쉬운 사용 권한을 확인하세요)' : null;
        case 'volume_up':
        case 'volume_down': {
          const d = action === 'volume_up' ? 10 : -10;
          const v = await run('/usr/bin/osascript', ['-e',
            `set v to (output volume of (get volume settings)) + (${d})
             if v > 100 then set v to 100
             if v < 0 then set v to 0
             set volume output volume v
             return v`]);
          return v == null ? '볼륨을 바꾸지 못했어요' : `맥 볼륨 ${v}%`;
        }
        case 'like':
          return '멜론은 좋아요를 누를 수 없어요';
      }
    },

    async playGenre() { return null; }, // 못 함 → 유튜브로
    stop() {},
    destroy() {},
  };
}

module.exports = { createMelon };
