// 7일 송금·거래 한도를 정할 때 참고하는 자산 분포를 보여줘요. (읽기만 해요, 아무것도 저장 안 해요)
//   node --env-file=.env scripts/weekly-limit-stats.js
// - 자산 = 잔고 + 일반 종목 평가액 (달러·예금·선물은 빼서 실제 순자산보다 조금 작게 나와요)
// - 읽는 양: 유저 문서 전체 + 종목 목록 1번 (유저 13명이면 아주 적어요)
// 필요한 환경변수(.env): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { loadEnv, listStocks, listCollection } from "../src/lib.js";
import { isForeign } from "../src/foreign.js";
import { WEEK_LIMIT, weeklyUsed } from "../src/weekly.js";

const env = loadEnv();
if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
  console.error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

const [users, stocks] = await Promise.all([listCollection(env, "users"), listStocks(env)]);
const price = new Map(stocks.filter((s) => !isForeign(s)).map((s) => [s.name, s.price]));

const rows = users
  .map((u) => {
    const stockValue = Object.entries(u.holdings || {}).reduce((sum, [name, qty]) => sum + (price.get(name) || 0) * qty, 0);
    return { 이름: u.username || u.id, 잔고: u.balance || 0, 주식평가액: stockValue, 자산: (u.balance || 0) + stockValue, "7일 사용(한도)": weeklyUsed(u) };
  })
  .sort((a, b) => b.자산 - a.자산);

console.log(`유저 ${rows.length}명 · 현재 한도 ${WEEK_LIMIT.toLocaleString()}해정\n`);
console.table(rows.map((r) => ({ ...r, 잔고: r.잔고.toLocaleString(), 주식평가액: r.주식평가액.toLocaleString(), 자산: r.자산.toLocaleString(), "7일 사용(한도)": r["7일 사용(한도)"].toLocaleString() })));

const sorted = rows.map((r) => r.자산).sort((a, b) => a - b);
const q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))] ?? 0;
const median = q(0.5);
const p75 = q(0.75);
console.log(`자산 중앙값 ${median.toLocaleString()} · 상위 25% 경계 ${p75.toLocaleString()} · 최고 ${(sorted.at(-1) ?? 0).toLocaleString()}\n`);
console.log("한도 후보 (weekly.js의 WEEK_LIMIT에 넣을 숫자)");
console.table([
  { 기준: "빡빡하게: 중앙값의 50%", 한도: Math.round(median * 0.5).toLocaleString() },
  { 기준: "추천: 상위 25% 경계의 50%", 한도: Math.round(p75 * 0.5).toLocaleString() },
  { 기준: "느슨하게: 상위 25% 경계의 100%", 한도: Math.round(p75).toLocaleString() },
]);
console.log("고르는 법: 활발한 유저가 일주일에 정상으로 거래할 금액은 안 막히고, 자산 대부분을 한 번에 몰아주는 건 막히는 숫자가 좋아요.");