#!/usr/bin/env node
// ============================================================
// merge-priors.js — 여러 사람이 낸 "기본값 내보내기" 파일을 하나로 합치기
//   node scripts/merge-priors.js 받은파일1.json 받은파일2.json …
//   → engine-prior.json (앱 폴더) 를 만들어요. 다음 버전부터 처음 쓰는 사람은 이 값에서 시작해요.
//
// 각 파일 = { version: 1, n: 기록 수, beta: { 상황: 값 } }  (기록·장르 이름·시간은 안 들어 있어요)
// 합치는 법: 기록이 많은 사람일수록 더 믿되(√n), 한 사람이 너무 세지 않게 n 은 200 까지만 셈.
// 사람이 3명보다 적으면 앱에 들어 있는 기본값과 반반 섞어요 (몇 명 취향이 전부가 되지 않게).
// ============================================================
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('사용법: node scripts/merge-priors.js 파일1.json 파일2.json …');
  process.exit(1);
}
const sum = {};
let total = 0;
let people = 0;
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { console.error(`건너뜀 (JSON 아님): ${f}`); continue; }
  if (!j || typeof j.beta !== 'object' || !(j.n >= 5)) { console.error(`건너뜀 (기록이 5개 미만이거나 형식이 다름): ${f}`); continue; }
  const w = Math.sqrt(Math.min(200, j.n));
  for (const [k, v] of Object.entries(j.beta)) {
    if (!Number.isFinite(v)) continue;
    const s = (sum[k] ||= { v: 0, w: 0 });
    s.v += w * Math.max(-2, Math.min(2, v));
    s.w += w;
  }
  total += j.n;
  people++;
}
if (!people) { console.error('합칠 파일이 없어요'); process.exit(1); }

// 앱 안의 기본값 (main.js 의 PRIOR_BETA) 을 읽어서 사람이 적을 땐 섞음
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const block = (src.match(/const PRIOR_BETA = \{([\s\S]*?)\};/) || [])[1] || '';
const builtIn = Object.fromEntries([...block.matchAll(/([\w가-힣]+):\s*(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
const mix = people >= 3 ? 1 : 0.5;
const beta = {};
for (const k of new Set([...Object.keys(builtIn), ...Object.keys(sum)])) {
  const merged = sum[k] ? sum[k].v / sum[k].w : builtIn[k] ?? 0;
  beta[k] = Math.round((mix * merged + (1 - mix) * (builtIn[k] ?? 0)) * 1000) / 1000;
}
const out = path.join(__dirname, '..', 'engine-prior.json');
fs.writeFileSync(out, JSON.stringify({ version: 1, people, n: Math.round(total), beta }, null, 2) + '\n');
console.log(`${people}명 · 기록 ${Math.round(total)}개를 합쳐서 ${out} 에 저장했어요${mix < 1 ? ' (3명 미만이라 기본값과 반반)' : ''}`);
