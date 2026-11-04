// 7일 송금·거래 한도를 정할 때 참고하는 자산 분포를 보여줘요. (읽기만 해요, 아무것도 저장 안 해요)
//   node --env-file=.env scripts/weekly-limit-stats.js
// - 총자산 = 잔고 + 달러(해정으로 환산) + 보유 종목(코인·미국주식 포함) + 예금 + 선물 평가금 - 대출
//   (/주식랭킹과 같은 계산이라, 은행에 맡기거나 달러로 바꿔 둔 돈도 들어가요)
// - 읽는 양: 유저·은행·선물 문서 전체 + 종목 목록 (유저 13명이면 아주 적어요)
// 필요한 환경변수(.env): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

import { loadEnv, listStocks, listCollection, getFxRate, krwPriceMap, extraAssets } from "../src/lib.js";
import { WEEK_LIMIT, weeklyUsed } from "../src/weekly.js";

const env = loadEnv();
if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
  console.error("FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

const [users, stocks, fx, banks] = await Promise.all([listCollection(env, "users"), listStocks(env), getFxRate(env), listCollection(env, "bank")]);
const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
const krwMap = krwPriceMap(stocks, fx.rate);
const extras = await extraAssets(env, priceMap, fx.rate); // 예금(이자 포함) + 선물 평가금 - 대출
const depositOf = Object.fromEntries(banks.map((b) => [b.id, b.deposit || 0])); // 예금 원금 (참고용)

const n = (x) => Math.round(x).toLocaleString();
const rows = users
  .map((u) => {
    const stockValue = Object.entries(u.holdings || {}).reduce((sum, [name, qty]) => sum + (krwMap[name] || 0) * qty, 0);
    const usdValue = ((u.usd || 0) * fx.rate) / 100;
    const extra = extras[u.id] || 0;
    const total = (u.balance || 0) + usdValue + stockValue + extra;
    return {
      이름: u.username || u.id,
      잔고: u.balance || 0,
      달러환산: usdValue,
      "예금(원금)": depositOf[u.id] || 0,
      "예금·선물-빚": extra,
      주식평가액: stockValue,
      총자산: total,
      "7일 사용": weeklyUsed(u),
    };
  })
  .sort((a, b) => b.총자산 - a.총자산);

console.log(`유저 ${rows.length}명 · 환율 ${fx.rate} · 현재 한도 ${WEEK_LIMIT.toLocaleString()}해정\n`);
console.table(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? n(v) : v]))));

const sorted = rows.map((r) => r.총자산).sort((a, b) => a - b);
const q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))] ?? 0;
const median = q(0.5);
const p75 = q(0.75);
console.log(`총자산 중앙값 ${n(median)} · 상위 25% 경계 ${n(p75)} · 최고 ${n(sorted.at(-1) ?? 0)}\n`);
console.log("한도 후보 (weekly.js의 WEEK_LIMIT에 넣을 숫자)");
console.table([
  { 기준: "빡빡하게: 중앙값의 50%", 한도: n(median * 0.5) },
  { 기준: "추천: 상위 25% 경계의 50%", 한도: n(p75 * 0.5) },
  { 기준: "느슨하게: 상위 25% 경계의 100%", 한도: n(p75) },
]);
console.log("고르는 법: 활발한 유저가 일주일에 정상으로 거래할 금액은 안 막히고, 자산 대부분을 한 번에 몰아주는 건 막히는 숫자가 좋아요.");