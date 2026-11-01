// 이미 상장된 종목의 업종을 이름 규칙(공업·AI·반도체 낱말 + 이름별 업종 표)으로 한 번 다시 정해요.
//   node --env-file=.env scripts/reclassify-sectors.js           미리보기: 뭐가 바뀔지만 보여줘요 (아무것도 저장 안 해요)
//   node --env-file=.env scripts/reclassify-sectors.js --apply   실제로 저장해요
//
// - 일반 종목만 봐요. 외국자산(코인·해외주식)은 건드리지 않아요.
// - 이름 규칙에 맞는 종목만 바꿔요. 규칙에 안 맞는 종목은 지금 업종을 그대로 둬요.
// - 저장은 종목 문서의 "sector" 칸 하나만 바꿔요. (가격·기록·보유 수량은 그대로)
// - 관리자가 직접 정해 둔 업종도 이름 규칙으로 바뀔 수 있어요. 먼저 미리보기로 확인하세요.
// 필요한 환경변수(.env): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { loadEnv, listStocks, setDoc, sectorByName, sectorOf } from "../src/lib.js";
import { isForeign } from "../src/foreign.js";

const apply = process.argv.includes("--apply");
const env = loadEnv();
if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
  console.error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

const stocks = (await listStocks(env)).filter((s) => !isForeign(s));
const changes = [];
let same = 0;
let noRule = 0;
for (const s of stocks) {
  const next = sectorByName(s.name);
  if (!next) {
    noRule++;
    continue;
  }
  const now = sectorOf(s);
  if (now === next) {
    same++;
    continue;
  }
  changes.push({ name: s.name, from: now, to: next });
}

console.log(`일반 종목 ${stocks.length}개 · 이미 맞음 ${same}개 · 규칙 없음(그대로 둠) ${noRule}개 · 바뀔 종목 ${changes.length}개\n`);
if (changes.length) console.table(changes);

if (!changes.length) {
  console.log("바꿀 종목이 없어요.");
} else if (!apply) {
  console.log("미리보기만 했어요. 저장하려면 --apply 를 붙여서 다시 실행하세요.");
} else {
  let ok = 0;
  for (const c of changes) {
    try {
      await setDoc(env, `stocks/${encodeURIComponent(c.name)}`, { sector: c.to });
      ok++;
    } catch (err) {
      console.error(`실패 (${c.name}):`, err.message);
    }
  }
  console.log(`${ok}/${changes.length}개 종목의 업종을 바꿨어요. (종목 목록은 최대 1분 뒤부터 반영돼요)`);
}