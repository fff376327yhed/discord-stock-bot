// 외국자산(미국주식·코인)의 배율(mult)을 한 번에 바꿔요. 배율이 클수록 실제 시세 변화가 해정 가격에 크게 반영돼요.
//   node --env-file=.env scripts/set-us-mult.js 5              미국주식만 ×5로 미리보기 (아무것도 저장 안 해요)
//   node --env-file=.env scripts/set-us-mult.js 5 --apply      실제로 저장해요
//   node --env-file=.env scripts/set-us-mult.js 5 --all --apply   미국주식 + 코인 모두
//
// - 가격은 "상장가 × (1 + (실제가 ÷ 기준실제가 − 1) × 배율)"이라, 배율을 바꾸면 다음 시세 변동 때 가격이 바로 새 배율로 다시 계산돼요.
//   (이미 올라 있거나 내려 있는 종목은 그 폭이 배율만큼 커져서 가격이 한 번에 튈 수 있어요. 먼저 미리보기로 확인하세요.)
// - 배율이 너무 크면 실제로 조금만 빠져도 상장폐지돼요. (예: ×10이면 실제 -10%에 가격이 0이 돼요)
// 필요한 환경변수(.env): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { loadEnv, listStocks, setDoc } from "../src/lib.js";
import { isForeign, calcForeignPrice } from "../src/foreign.js";

const mult = Number(process.argv[2]);
const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
if (!Number.isFinite(mult) || mult <= 0 || mult > 20) {
  console.error("사용법: node --env-file=.env scripts/set-us-mult.js <배율 1~20> [--all] [--apply]");
  process.exit(1);
}
const env = loadEnv();
if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
  console.error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

const targets = (await listStocks(env)).filter((s) => isForeign(s) && (all || s.kind === "us"));
const rows = targets.map((s) => {
  const next = calcForeignPrice({ real: s.lastReal, baseReal: s.baseReal, mult, startPrice: s.startPrice });
  return { 이름: s.name, 종류: s.kind, "지금 배율": s.mult ?? "(기본)", 지금가격: s.price, "바뀐 뒤 가격": next ?? "-", 상장폐지위험: next !== null && next <= 1 ? "⚠️" : "" };
});
console.log(`대상 ${targets.length}개 → 배율 ×${mult}\n`);
if (rows.length) console.table(rows);

if (!rows.length) console.log("바꿀 종목이 없어요.");
else if (!apply) console.log("미리보기만 했어요. 저장하려면 --apply 를 붙여서 다시 실행하세요.");
else {
  let ok = 0;
  for (const s of targets) {
    try {
      await setDoc(env, `stocks/${encodeURIComponent(s.name)}`, { mult });
      ok++;
    } catch (err) {
      console.error(`실패 (${s.name}):`, err.message);
    }
  }
  console.log(`${ok}/${targets.length}개 종목의 배율을 ×${mult}로 바꿨어요. (종목 목록은 최대 1분 뒤부터 반영돼요)`);
}