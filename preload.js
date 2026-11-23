// ============================================================
// preload.js — 화면(notch.html)과 메인 프로세스(main.js)를 잇는 다리
// ============================================================
// Electron 은 보안 때문에 화면(웹페이지) 쪽에서 Node.js 기능을 바로 못 써요.
// 그래서 여기서 "허락된 통로"만 window.spotify 라는 이름으로 화면에 열어줘요.
//
//   화면 → 메인:  window.spotify.send('control', 'next')
//   메인 → 화면:  window.spotify.on('track', (곡) => { ... })
//   화면 ← 메인:  await window.spotify.getState()   (처음 켤 때 현재 상태 한 번에 받기)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

// 화면이 메인에게 보낼 수 있는 메시지 이름들
const SEND = [
  'login', // Spotify 로그인 버튼
  'choose-platform', // 처음 켰을 때 고른 음악 앱 ('spotify' · 'apple' · 'ytmusic' · 'youtube' · 'melon')
  'control', // 재생/일시정지/이전/다음/좋아요
  'context-menu', // 우클릭 메뉴 열기
  'open-settings', // 톱니바퀴 버튼 → 설정 창 열기
  'interactive', // 마우스를 받을지(true) 뒤로 통과시킬지(false)
  'gesture', // 웹캠 인식기가 확정한 제스처 이름 ('swipe_right' 등)
];

// 메인이 화면에게 보낼 수 있는 메시지 이름들
const RECV = [
  'status', // 로그인 상태
  'track', // 지금 재생 중인 곡 정보
  'lyrics', // 가사
  'notice', // 짧은 안내 문구 ("Premium 에서만 돼요" 등)
  'peek', // 곡이 바뀌었으니 잠깐 펼쳐라
  'layout', // 노치 크기가 바뀜 (모니터 바뀔 때)
  'gesture', // 제스처로 조작했음 → 화면에 "다음 곡" 같은 표시
  'camera', // 카메라 켜기(true)/끄기(false)
  'genre', // 제스처로 튼 장르 이름 ('락' 등)
  'platform', // 지금 조작하는 음악 플랫폼 { id, name, chosen }
  'stream', // 카메라 영상 주소가 바뀜 (라즈베리파이 ↔ 맥북 카메라, 끄면 null)
];

contextBridge.exposeInMainWorld('spotify', {
  send: (ch, data) => SEND.includes(ch) && ipcRenderer.send(ch, data),
  on: (ch, fn) => RECV.includes(ch) && ipcRenderer.on(ch, (_e, data) => fn(data)),
  getState: () => ipcRenderer.invoke('get-state'),
  cameraAccess: () => ipcRenderer.invoke('camera-access'), // macOS 카메라 권한 요청 → true/false
});
