// ============================================================
// gestures.js — 제스처 엔진 (인식기 등록 + 오작동 방지)
// ============================================================
// 흐름:
//   camera.js 가 1초에 15번 웹캠 프레임을 Gesture.feed(frame) 로 넘김
//     → 등록된 인식기(recognizer)들이 각자 프레임을 보고 '제스처 이름' 또는 null 을 돌려줌
//     → 오작동 방지(다수결 + 유지 시간)를 통과하면 확정
//     → api.send('gesture', 이름) → main.js 의 handleGesture → Spotify 조작
//
// 인식기 하나 추가하는 법 (recognizers/motion-swipe.js 가 예시):
//
//   Gesture.add('내-인식기', (frame) => {
//     // frame.image  : 160x120 ImageData (거울처럼 좌우 반전된 상태, 화면에 보이는 그대로)
//     // frame.video  : <video> 원본 (MediaPipe 같은 라이브러리에 바로 넘길 때)
//     // frame.time   : 시각(ms)
//     if (주먹이_보이면) return 'Closed_Fist';   // 설정의 제스처 이름과 같아야 함
//     return null; // 아무 제스처도 아님
//   }, { hold: 1200 });  // ← 1.2초 동안 유지돼야 확정. 스와이프처럼 순간 동작이면 hold: 0
//
// 인식기가 돌려준 이름이 설정 화면(우클릭 → 설정…)에 등록돼 있어야 실제로 조작돼요.
//
// MediaPipe(손 21점)를 붙일 때 뼈대:
//   npm install @mediapipe/tasks-vision
//   const { HandLandmarker, FilesetResolver } = ... (ES 모듈이라 <script type="module"> 에서 불러오기)
//   const hands = await HandLandmarker.createFromOptions(fileset, { runningMode: 'VIDEO', numHands: 1, ... });
//   Gesture.add('mediapipe', (frame) => {
//     const r = hands.detectForVideo(frame.video, frame.time);
//     const lm = r.landmarks[0];            // 손가락 관절 21개 {x, y, z} (0~1)
//     if (!lm) return null;
//     // 예: 손가락 끝(8,12,16,20)이 모두 마디(6,10,14,18)보다 위 → 손바닥 폄
//     // 주의: frame.video 는 반전 전 원본이라 x 를 1 - x 로 바꿔야 화면 방향과 같아요
//     return ...;
//   }, { hold: 1000 });
// ============================================================

const Gesture = (() => {
  // 다수결 기준: hold 시간 동안 들어온 결과 중 이 비율 이상이 같은 제스처여야 확정
  const MAJORITY = 0.7;

  const recognizers = []; // { name, fn, hold, samples: [{ t, g }] }
  const progressListeners = [];

  // 인식기 등록
  function add(name, fn, { hold = 0 } = {}) {
    recognizers.push({ name, fn, hold, samples: [] });
  }

  const hasRecognizers = () => recognizers.length > 0;

  // 유지 중인 제스처의 진행률(0~1)을 화면에 알려줌 → 노치의 유지 게이지
  function onProgress(fn) {
    progressListeners.push(fn);
  }
  function emitProgress(name, ratio) {
    for (const fn of progressListeners) fn(name, ratio);
  }

  // camera.js 가 매 프레임 부름
  function feed(frame) {
    let best = null; // 이번 프레임에서 가장 많이 진행된 유지 제스처 (게이지 표시용)
    for (const r of recognizers) {
      let g = null;
      try {
        g = r.fn(frame) || null;
      } catch (e) {
        console.error(`[인식기 ${r.name}]`, e);
      }

      // 순간 동작 (스와이프): 바로 확정
      if (!r.hold) {
        if (g) fire(g);
        continue;
      }

      // 유지 동작: 최근 결과들로 다수결 (한두 프레임 놓쳐도 끊기지 않게)
      r.samples.push({ t: frame.time, g });
      while (r.samples.length && frame.time - r.samples[0].t > r.hold * 1.2) r.samples.shift();

      // 모인 결과 중 가장 많이 나온 제스처 = 후보
      const counts = {};
      for (const s of r.samples) if (s.g) counts[s.g] = (counts[s.g] || 0) + 1;
      const [candidate, same] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
      if (!candidate) continue;

      const share = same / r.samples.length; // 후보가 차지하는 비율
      const span = frame.time - r.samples[0].t; // 지금까지 모인 시간
      const ratio = share >= MAJORITY ? Math.min(1, span / r.hold) : 0;
      if (!best || ratio > best.ratio) best = { name: candidate, ratio };
      if (share >= MAJORITY && span >= r.hold) {
        r.samples = []; // 확정했으면 처음부터 다시 모음
        fire(candidate);
      }
    }
    emitProgress(best?.name || null, best?.ratio || 0);
  }

  // 확정 → main.js 로. (쿨다운은 main.js 가 함: 어디서 온 제스처든 똑같이 적용되게)
  function fire(name) {
    window.spotify.send('gesture', name);
  }

  // 카메라 없이 시험: 개발자도구 콘솔에서 Gesture.simulate('swipe_right')
  const simulate = fire;

  return { add, feed, hasRecognizers, onProgress, simulate };
})();
