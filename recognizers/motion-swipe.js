// ============================================================
// recognizers/motion-swipe.js — 인식기 예시: 움직임으로 스와이프 알아채기
// ============================================================
// 머신러닝 없이, "앞 프레임과 달라진 픽셀"의 무게중심이 빠르게 한쪽으로 이동하면 스와이프로 봐요.
//   오른쪽으로 쭉 → 'swipe_right',  왼쪽 → 'swipe_left',  위 → 'swipe_up',  아래 → 'swipe_down'
//
// 장점: 라이브러리 없이 바로 돌아감.  단점: 몸을 움직여도 반응할 수 있음 (그래서 기본은 꺼짐).
// 켜려면 config.json 에:   "recognizers": { "motionSwipe": true }
// 나중에 MediaPipe 인식기를 만들면 이 파일처럼 함수 하나 만들어서 Gesture.add 하면 돼요.
//
// 숫자를 바꿔가며 맞춰보세요:
//   DIFF      한 픽셀이 "움직였다"고 볼 밝기 차이 (작을수록 예민)
//   MIN_PIX   움직인 픽셀이 이만큼은 있어야 손이 움직인 걸로 봄 (작은 떨림 무시)
//   WINDOW    이 시간 안에 이동한 거리만 봄 (ms)
//   DIST      화면 폭(또는 높이)의 이 비율 이상 움직여야 스와이프
//   REST      한 번 인식하고 이 시간 동안은 쉼 (ms)
// ============================================================

function createMotionSwipe({ DIFF = 40, MIN_PIX = 120, WINDOW = 450, DIST = 0.35, REST = 900 } = {}) {
  let prev = null; // 앞 프레임의 밝기 (흑백)
  const path = []; // 최근 무게중심 [{ t, x, y }]
  let restUntil = 0;

  return (frame) => {
    const { data } = frame.image;
    const { width: W, height: H, time } = frame;

    // 1) 흑백으로 바꾸기
    const gray = new Uint8Array(W * H);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
      gray[p] = (data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 10;
    }
    if (!prev) {
      prev = gray;
      return null;
    }

    // 2) 앞 프레임과 다른 픽셀들의 무게중심
    let n = 0, sx = 0, sy = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const p = y * W + x;
        if (Math.abs(gray[p] - prev[p]) > DIFF) { n++; sx += x; sy += y; }
      }
    }
    prev = gray;

    if (time < restUntil) return null;
    if (n < MIN_PIX / 4) { path.length = 0; return null; } // 2칸씩 건너뛰어 셌으니 1/4
    path.push({ t: time, x: sx / n / W, y: sy / n / H });
    while (path.length && time - path[0].t > WINDOW) path.shift();
    if (path.length < 3) return null;

    // 3) WINDOW 동안 이동한 거리로 방향 판단
    const dx = path[path.length - 1].x - path[0].x;
    const dy = path[path.length - 1].y - path[0].y;
    let g = null;
    if (Math.abs(dx) > DIST && Math.abs(dx) > Math.abs(dy) * 1.5) g = dx > 0 ? 'swipe_right' : 'swipe_left';
    else if (Math.abs(dy) > DIST && Math.abs(dy) > Math.abs(dx) * 1.5) g = dy > 0 ? 'swipe_down' : 'swipe_up';
    if (g) {
      path.length = 0;
      restUntil = time + REST;
    }
    return g;
  };
}
