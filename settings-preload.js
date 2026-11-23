// ============================================================
// settings-preload.js — 설정 화면(settings.html)과 main.js 를 잇는 다리
// ============================================================
// 노치 화면과는 다른 통로라서 파일을 따로 뒀어요. (설정 화면은 설정에 필요한 것만 쓸 수 있게)
//
//   await window.settingsApi.get()        → { settings, actions }   지금 설정 + 동작 종류 목록
//   await window.settingsApi.save(설정)   → 저장된 설정 (main.js 가 한 번 정리해서 돌려줌)
//   await window.settingsApi.test({ kind, item }) → 저장 안 해도 그 줄을 바로 실행 (kind: genre / control)
//   await window.settingsApi.pi(path, body)       → 라즈베리파이 대시보드 API (녹화·학습·삭제·상태)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (s) => ipcRenderer.invoke('settings:save', s),
  setMode: (m) => ipcRenderer.invoke('settings:mode', m), // 보통 / 인식만 / DJ — 누르면 바로 (저장과 따로)
  test: (g) => ipcRenderer.invoke('settings:test', g),
  playlists: () => ipcRenderer.invoke('spotify:playlists'), // 내 Spotify 플레이리스트 목록
  relogin: () => ipcRenderer.invoke('spotify:relogin'),
  favorites: () => ipcRenderer.invoke('fav:list'), // 알아서 만든 단골 플리
  forget: (x) => ipcRenderer.invoke('fav:forget', x),
  autoReport: (refresh) => ipcRenderer.invoke('auto:report', { refresh }), // 상황 엔진: 지금 상황·순위·배운 것
  autoPlay: () => ipcRenderer.invoke('auto:play'),
  autoForget: (x) => ipcRenderer.invoke('auto:forget', x),
  analytics: (days) => ipcRenderer.invoke('auto:analytics', { days }), // 분석 창: 지표 · 장르별 · 최근 기록
  openAnalytics: () => ipcRenderer.send('open-analytics'),
  exportPrior: () => ipcRenderer.invoke('auto:export-prior'), // 분위기 모델 값만 파일로 (기록 없이)
  pi: (path, body) => ipcRenderer.invoke('pi:api', { path, body }),
  piConnect: (addr) => ipcRenderer.invoke('pi:connect', addr), // 라즈베리파이 주소 저장 (user@IP)
  importPi: () => ipcRenderer.invoke('pi:import'), // 라즈베리파이에서 녹화한 샘플을 맥북 쪽으로 가져와 다시 학습
});
