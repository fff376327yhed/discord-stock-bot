import {
  loadEnv, isAuthorizedCron, currentSurgeSlot, surgeSlotKey, isSurgeMoment,
  fluctuatePrices, announcePriceChanges, notifyPriceChanges, announcePreAlert,
  processOrders, processPriceAlerts, processFutures, processBank, processDividends, takeNews, finishNews, publishNews, runEarnings, prepareCrowd, finishCrowd, getDoc, setDoc,
  rollBankRate, rollFxRate, logTradePressure,
} from "../src/lib.js";

// 크론 엔드포인트 3개(fluctuate / midnight / prealert)를 한 함수로 합친 파일이에요.
// 호출: /api/cron?task=fluctuate | midnight | prealert | news | bankRate | fxRate | earnings
//  - vercel.json의 rewrites 덕분에 예전 주소(/api/cron/fluctuate 등)도 그대로 동작해요.
//  - 인증: Authorization: Bearer <CRON_SECRET>

// ---------- 공통: 시세 변동 1회 실행 ----------
async function runFluctuation(env, range, label) {
  // 봇 주문 수집 (실패해도 시세 변동은 그대로 진행)
  let crowd = null;
  try {
    crowd = await prepareCrowd(env);
  } catch (err) {
    console.error("봇 준비 실패:", err.message);
  }

  // 공시: 예고된 호재/악재가 있으면 이번 변동에 반영 (실패해도 시세 변동은 그대로 진행)
  let news = null;
  try {
    news = await takeNews(env);
  } catch (err) {
    console.error("공시 불러오기 실패:", err.message);
  }

  const changes = await fluctuatePrices(env, { ...range, impact: crowd?.impact, news: news?.shifts, newsFv: news?.fvShifts });

  // 상장폐지 종목을 봇 보유분에서 지우고 봇 저장
  try {
    if (crowd) await finishCrowd(env, crowd, changes);
  } catch (err) {
    console.error("봇 저장 실패:", err.message);
  }

  // 1) 주식채널 공지 (알림 설정과 무관)
  // 반영된 공시를 비우고 결과 문구를 만들어 공지에 같이 올려요
  let newsResult = { lines: [], count: 0 };
  try {
    newsResult = await finishNews(env, news, changes);
  } catch (err) {
    console.error("공시 결과 처리 실패:", err.message);
  }

  const announce = await announcePriceChanges(env, changes, label, newsResult.lines);

  // 2) 예약 매수/매도 체결 (실패해도 시세 변동 결과는 그대로 응답)
  let orders = null;
  try {
    orders = await processOrders(env);
  } catch (err) {
    console.error("예약 주문 처리 실패:", err.message);
  }

  // 2-1) 가격 알림: 도달한 종목은 DM으로 알리고 알림 삭제 (실패해도 시세 변동 결과는 그대로 응답)
  let alerts = null;
  try {
    alerts = await processPriceAlerts(env);
  } catch (err) {
    console.error("가격 알림 처리 실패:", err.message);
  }

  // 2-2) 선물 강제청산/폐지 정산 (실패해도 시세 변동 결과는 그대로 응답)
  let futures = null;
  try {
    futures = await processFutures(env, changes);
  } catch (err) {
    console.error("선물 정산 실패:", err.message);
  }

  // 2-3) 은행: 만기 알림 / 만기 대출 자동 회수 / 연체 처리 (실패해도 시세 변동 결과는 그대로 응답)
  // 읽기를 아끼려고 정각 근처(0~14분) 변동에서만 돌려요. (1시간에 1번)
  let bank = null;
  try {
    if (new Date().getMinutes() < 15) bank = await processBank(env);
  } catch (err) {
    console.error("은행 처리 실패:", err.message);
  }

  // 2-4) 배당금: 하루 한 번 (매일 오전 9시 이후 첫 변동 때, 이미 줬으면 알아서 건너뜀)
  let dividends = null;
  try {
    dividends = await processDividends(env);
  } catch (err) {
    console.error("배당금 처리 실패:", err.message);
  }

  // 3) 알림을 켠 유저에게 DM
  await notifyPriceChanges(env, changes);

  // 4) 로그 기반 거래 압력 집계 (마지막 집계 시각 이후 로그만 읽어요, 실패해도 시세 변동 결과는 그대로 응답)
  let logPressure = null;
  try {
    logPressure = await logTradePressure(env);
  } catch (err) {
    console.error("로그 거래 압력 집계 실패:", err.message);
  }

  return Response.json({
    ok: true,
    announce,
    orders,
    alerts,
    futures,
    bank,
    dividends,
    news: newsResult.count,
    crowd: crowd?.summary,
    logPressure,
    mode: label,
    shocks: changes.shocks, // 이번에 뽑은 시장·업종 충격(로그 수익률)
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    marketBreaker: !!changes.marketBreaker, // 시장 서킷브레이커 발동 여부
    halted: changes.filter((c) => c.halted).map((c) => c.name), // 거래정지 종목
    limits: changes.filter((c) => c.limit).map((c) => `${c.name}${c.limit === "up" ? "↑" : "↓"}`), // 상·하한가 종목
    changes,
  });
}

// ---------- 1) 평소 변동: -50% ~ +100% (종 모양이라 끝값은 거의 안 나와요) (15분마다, cron-job.org: */15 * * * *) ----------
const NORMAL_RANGE = { minPct: -50, maxPct: 100 }; // 평소에도 시장·업종 충격은 작게 들어가요 (surge 아님)

async function fluctuateTask(env) {
  // 급등락 시각 직전·직후에는 평소 변동을 쉬어서 겹치지 않게 함
  if (isSurgeMoment()) {
    return Response.json({ ok: true, skipped: true, reason: "급등락 시각이라 평소 변동은 건너뛰었어요." });
  }
  return runFluctuation(env, NORMAL_RANGE, "평소 변동");
}

// ---------- 2) 급등락: -90% ~ +900% (+ 종목마다 0.5% 확률로 -100%) ----------
// 하루 3번(18시/21시/0시 KST), 슬롯마다 딱 1번만 실행. 실행 기록은 Firebase config/surge 에 남겨요.
// 슬롯 시각이 아니면 아무것도 읽지 않고 바로 끝내요. (평소 변동은 fluctuate 가 담당)
// 그래서 cron-job.org에서 5분마다 호출해도 읽기가 거의 늘지 않아요.
// surge: true -> fluctuatePrices가 시장 충격·업종 충격을 급등락용(크게)으로 뽑아요. (상수는 src/lib.js의 SHOCK_SURGE)
const SURGE_RANGE = { minPct: -90, maxPct: 900, crashChance: 0.005, crashPct: -100, surge: true };

async function midnightTask(env) {
  const slot = currentSurgeSlot();
  if (!slot) {
    return Response.json({ ok: true, skipped: true, reason: "급등락 시각이 아니에요." });
  }

  const key = surgeSlotKey(slot);
  const state = await getDoc(env, "config/surge");
  if (state?.lastKey === key) {
    return Response.json({ ok: true, skipped: true, reason: "이 슬롯은 이미 실행했어요." });
  }

  // 실행 전에 먼저 기록해서, 5분 간격 호출이 겹쳐도 두 번 실행되지 않게 함
  await setDoc(env, "config/surge", { lastKey: key });
  return runFluctuation(env, SURGE_RANGE, slot.label);
}

// ---------- 3) 급등락 예고 (5~6분 전, cron-job.org: 17:54 / 20:54 / 23:54 KST) ----------
const PREALERT_SLOTS = [
  { min: 18 * 60, label: "오후 6시 급등락" },
  { min: 21 * 60, label: "오후 9시 급등락" },
  { min: 0, label: "새벽 12시 급등락" },
];
const LEAD_MIN = 5;
const LEAD_MAX = 6;

// 한국시간 기준 현재 분 (0~1439)
function kstNowMinutes() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

async function prealertTask(env) {
  const now = kstNowMinutes();
  let target = null;
  for (const slot of PREALERT_SLOTS) {
    const diff = (slot.min - now + 1440) % 1440; // 자정을 넘어가는 경우도 계산
    if (diff >= LEAD_MIN && diff <= LEAD_MAX) {
      target = { label: slot.label, lead: diff };
      break;
    }
  }
  if (!target) {
    return Response.json({ ok: true, sent: false, reason: "예고 시각이 아니에요" });
  }
  const result = await announcePreAlert(env, target.label, target.lead);
  return Response.json({ ok: true, ...result, target });
}

// ---------- 진입점 ----------
// ---------- 4) 공시 (5분 전 공지, cron-job.org: 10,25,40,55 * * * *) ----------
async function newsTask(env) {
  const result = await publishNews(env);
  return Response.json({ ok: true, ...result });
}

// ---------- 5) 은행 금리 변동 (1시간마다, cron-job.org: 0 * * * *) ----------
async function bankRateTask(env) {
  const rate = await rollBankRate(env);
  return Response.json({ ok: true, ...rate });
}

// ---------- 6) 환율 변경 (1시간마다, cron-job.org: 0 * * * *, 주소: /api/cron?task=fxRate) ----------
async function fxRateTask(env) {
  const rate = await rollFxRate(env);
  return Response.json({ ok: true, ...rate });
}

// ---------- 7) 실적 시즌 (cron-job.org: 5,20,35,50 * * * *, 주소: /api/cron?task=earnings) ----------
// 주기(기본 7일)마다 대상 종목을 예고하고, 30분쯤 뒤 실적을 발표해요. (상수는 src/lib.js의 EARNINGS_*)
// 시세 변동(0,15,30,45분)과 겹치지 않게 5분 뒤에 불러요. 평소엔 문서 1개만 읽고 끝나요.
// 테스트: /api/cron?task=earnings&force=1 → 시각과 상관없이 지금 바로 시작해요.
async function earningsTask(env, url) {
  const result = await runEarnings(env, { force: url?.searchParams.get("force") === "1" });
  return Response.json(result);
}

const TASKS = { fluctuate: fluctuateTask, midnight: midnightTask, prealert: prealertTask, news: newsTask, bankRate: bankRateTask, fxRate: fxRateTask, earnings: earningsTask };

export default {
  fetch: async function handler(request) {
    const env = loadEnv();
    if (!isAuthorizedCron(request, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const task = url.searchParams.get("task") || url.pathname.split("/").filter(Boolean).pop();
    const run = TASKS[task];
    if (!run) {
      return Response.json({ ok: false, error: `알 수 없는 task예요: ${task}`, tasks: Object.keys(TASKS) }, { status: 400 });
    }
    return run(env, url);
  },
};