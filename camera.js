// ============================================================
// camera.js — 웹캠 켜기/끄기 + 프레임을 제스처 엔진에 넘기기
// ============================================================
// - 노치 카드의 <video id="cam"> 에 웹캠 화면을 띄워요 (거울처럼 좌우 반전).
// - 1초에 FPS 번, 작은 캔버스(160x120)에 반전된 프레임을 그려서 Gesture.feed() 로 넘겨요.
//   작게 줄이는 이유: 픽셀을 직접 훑는 인식기도 가볍게 돌 수 있게.
// - 카드가 접혀 있어도 카메라는 계속 돌아요 (인식은 늘 해야 하니까).
//   끄고 싶으면 우클릭 → 카메라 끄기, 또는 config.json 에 "camera": false
//
// 상태는 <body data-cam="..."> 로 화면에 알려줘요 → CSS 가 안내 문구를 바꿈
//   off(꺼짐) / starting(켜는 중) / on(켜짐) / denied(권한 거절) / error(카메라 없음 등)
// ============================================================

const Camera = (() => {
  const FPS = 15;
  const W = 160;
  const H = 120;

  const video = document.getElementById('cam');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let timer = null;
  let wanted = false; // 켜는 도중에 끄라는 요청이 오면 무시하려고

  function setState(s) {
    document.body.dataset.cam = s;
  }
  setState('off');

  async function start() {
    wanted = true;
    if (stream) return true;
    setState('starting');
    if (!(await window.spotify.cameraAccess())) {
      setState('denied');
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
    } catch (e) {
      console.error('카메라 열기 실패:', e.name, e.message);
      setState('error');
      return false;
    }
    if (!wanted) return stop(), false; // 켜는 사이 꺼짐 요청
    video.srcObject = stream;
    await video.play().catch(() => {});
    setState('on');
    timer = setInterval(grab, 1000 / FPS);
    return true;
  }

  function stop() {
    wanted = false;
    clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop()); // 이걸 해야 초록 카메라 불이 꺼져요
    stream = null;
    video.srcObject = null;
    setState('off');
  }

  // 한 프레임을 작게 그려서 제스처 엔진에 넘김
  function grab() {
    if (video.readyState < 2 || !Gesture.hasRecognizers()) return;
    ctx.setTransform(-1, 0, 0, 1, W, 0); // 좌우 반전 → 화면에 보이는 방향 = 인식 방향
    ctx.drawImage(video, 0, 0, W, H);
    Gesture.feed({
      image: ctx.getImageData(0, 0, W, H),
      video,
      width: W,
      height: H,
      time: performance.now(),
    });
  }

  return { start, stop, isOn: () => !!stream };
})();
