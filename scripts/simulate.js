// 시세 변동 시뮬레이션: 예전 방식 / 1단계(하락 편향 보정) / 2단계(기업 가치로 끌어당김) / 3단계(시장·업종 충격) / 4단계(변동성 등급) / 6단계(유저 거래 압력)를 나란히 비교해요.
//   node scripts/simulate.js            (종목 1000개, 기본)
//   node scripts/simulate.js 5000       (종목 수 바꾸기)
// Firestore 등 외부 연결 없이 로컬에서만 돌아가요.
import { randomChangePct, nextChange, tradeImpactOf, rollShocks, commonShockOf, SECTORS, NO_SECTOR, VOL_TIER_SIGMA, DELIST_PRICE } from "../src/lib.js";

const STOCKS = Number(process.argv[2]) || 1000;
const START_PRICE = 10000;
const NORMAL = { minPct: -20, maxPct: 20 };
const SURGE = { minPct: -80, maxPct: 120, crashChance: 0.005, crashPct: -100 };
const TICKS_PER_DAY = 96; // 15분마다
const SURGES = [18 * 4, 21 * 4, 0]; // 하루 중 급등락이 일어나는 변동 번호(18시, 21시, 0시)
const DAYS = [1, 3, 7, 14];

// 3단계용: 종목마다 업종을 돌려가며 배정 (마지막 칸은 "기타" = 업종 충격 없음), beta는 모두 1
const SECTOR_LIST = [...SECTORS, NO_SECTOR];
const sectorOfIndex = (i) => SECTOR_LIST[i % SECTOR_LIST.length];
const BETA = 1;

// 4단계용: 종목 10개 중 1개 대형, 3개 중형, 6개 소형 (3단계는 전부 소형 기준이에요)
const tierOfIndex = (i) => (i % 10 === 0 ? "대형" : i % 10 <= 3 ? "중형" : "소형");
const sigmaOf = (tier, shocks) => VOL_TIER_SIGMA[tier][shocks.surge ? "surge" : "normal"];

// 각 방식: (가격, fv, 범위, 종목 번호, 이번 변동의 시장·업종 충격) -> { pct, fv }
const methods = {
  "예전 방식 (균등 난수)": (price, fv, r) => ({
    pct: Math.random() < (r.crashChance || 0) ? r.crashPct : r.minPct + Math.random() * (r.maxPct - r.minPct),
    fv,
  }),
  "1단계 (하락 편향 보정)": (price, fv, r) => ({
    pct: Math.random() < (r.crashChance || 0) ? r.crashPct : randomChangePct(r.minPct, r.maxPct),
    fv,
  }),
  "2단계 (+ 기업 가치 끌어당김)": (price, fv, r) => nextChange(price, fv, r),
  "3단계 (+ 시장·업종 충격)": (price, fv, r, i, shocks) =>
    nextChange(price, fv, { ...r, common: commonShockOf(shocks, sectorOfIndex(i), BETA), idioSigma: sigmaOf("소형", shocks) }),
  "4단계 (+ 변동성 등급: 대형10%·중형30%·소형60%)": (price, fv, r, i, shocks) =>
    nextChange(price, fv, { ...r, common: commonShockOf(shocks, sectorOfIndex(i), BETA), idioSigma: sigmaOf(tierOfIndex(i), shocks) }),
  // 6단계: 유저들이 매 변동마다 좌우 대칭으로 사고판다고 가정 (순매수 평균 0). 쏠림이 없으면 하락·상승 편향이 안 생겨야 해요.
  "6단계 (+ 유저 거래 압력, 매수·매도 균형)": (price, fv, r, i, shocks) => {
    const tier = tierOfIndex(i);
    const flow = (Math.random() - 0.5) * 2 * 200_000; // ±20만 해정 안에서 균등
    const t = tradeImpactOf(flow, { price, volTier: tier });
    return nextChange(price, fv, { ...r, impact: t.impact, tradeFvShift: t.fvShift, common: commonShockOf(shocks, sectorOfIndex(i), BETA), idioSigma: sigmaOf(tier, shocks) });
  },
};

function run(step) {
  const prices = Array(STOCKS).fill(START_PRICE);
  const fvs = Array(STOCKS).fill(START_PRICE);
  const dead = Array(STOCKS).fill(false);
  const out = [];
  let tick = 0;
  let logSum = 0; // 한 번 변동당 평균 로그 수익률 확인용 (폭락 -100%는 빼고 계산)
  let logCnt = 0;
  for (const day of DAYS) {
    while (tick < day * TICKS_PER_DAY) {
      const slot = tick % TICKS_PER_DAY;
      const isSurge = SURGES.includes(slot);
      const range = isSurge ? SURGE : NORMAL; // 급등락 시각에는 평소 변동을 쉬어요
      const shocks = rollShocks(isSurge); // 이번 변동의 시장 충격 1개 + 업종별 충격 1개씩 (3단계만 써요)
      for (let i = 0; i < STOCKS; i++) {
        if (dead[i]) continue;
        const { pct, fv } = step(prices[i], fvs[i], range, i, shocks);
        if (pct > -99.9) {
          logSum += Math.log(1 + pct / 100);
          logCnt++;
        }
        prices[i] = Math.max(1, Math.round(prices[i] * (1 + pct / 100)));
        fvs[i] = fv;
        if (prices[i] <= DELIST_PRICE) dead[i] = true;
      }
      tick++;
    }
    const alive = prices.filter((_, i) => !dead[i]).sort((a, b) => a - b);
    const q = (x) => (alive.length ? alive[Math.min(alive.length - 1, Math.floor(alive.length * x))] : 0);
    out.push({
      일수: day,
      "생존 중앙값": q(0.5),
      "상위10%": q(0.9),
      "하위10%": q(0.1),
      "최고가": alive[alive.length - 1] ?? 0,
      상장폐지: ((dead.filter(Boolean).length / STOCKS) * 100).toFixed(1) + "%",
      "평균 로그수익(%/회)": logCnt ? ((logSum / logCnt) * 100).toFixed(3) : "-",
    });
  }
  return out;
}

console.log(`종목 ${STOCKS}개, 시작가 ${START_PRICE}, 상장폐지 기준 ${DELIST_PRICE} 이하 (생존 종목 기준 통계)\n`);
for (const [name, step] of Object.entries(methods)) {
  console.log(`[${name}]`);
  console.table(run(step));
}
// ---------- 6단계: 순매수 금액별 영향 (%p) ----------
// 한 번 변동 사이에 유저들이 이만큼 순매수(+)/순매도(-)했을 때, 등급별로 가격이 얼마나 밀리는지 보여줘요.
console.log("\n[6단계] 순매수 금액별 이번 변동에 더해지는 영향(%p) / fv에 남는 몫(%p)");
const FLOWS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, -100_000, -10_000_000];
console.table(
  FLOWS.map((flow) => {
    const row = { "순매수(해정)": flow.toLocaleString() };
    for (const tier of ["대형", "중형", "소형"]) {
      const t = tradeImpactOf(flow, { price: 1000, volTier: tier });
      row[tier] = `${t.impact.toFixed(2)} / ${t.fvShift.toFixed(2)}`;
    }
    return row;
  })
);
console.log("금액을 100배로 늘려도 영향은 약 10배(제곱근), 상한(TRADE_IMPACT_CAP)에서 멈추는지 확인하세요.");