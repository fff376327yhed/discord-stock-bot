import {
  loadEnv, isAuthorizedCron, currentSurgeSlot, surgeSlotKey, isSurgeMoment,
  fluctuatePrices, announcePriceChanges, notifyPriceChanges, announcePreAlert,
  processOrders, processFutures, prepareCrowd, finishCrowd, getDoc, setDoc,
} from "../src/lib.js";

// 크론 엔드포인트 3개(fluctuate / midnight / prealert)를 한 함수로 합친 파일이에요.
// 호출: /api/cron?task=fluctuate | midnight | prealert
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

  const changes = await fluctuatePrices(env, { ...range, impact: crowd?.impact });

  // 상장폐지 종목을 봇 보유분에서 지우고 봇 저장
  try {
    if (crowd) await finishCrowd(env, crowd, changes);
  } catch (err) {
    console.error("봇 저장 실패:", err.message);
  }

  // 1) 주식채널 공지 (알림 설정과 무관)
  const announce = await announcePriceChanges(env, changes, label);

  // 2) 예약 매수/매도 체결 (실패해도 시세 변동 결과는 그대로 응답)
  let orders = null;
  try {
    orders = await processOrders(env);
  } catch (err) {
    console.error("예약 주문 처리 실패:", err.message);
  }

  // 2-2) 선물 강제청산/폐지 정산 (실패해도 시세 변동 결과는 그대로 응답)
  let futures = null;
  try {
    futures = await processFutures(env, changes);
  } catch (err) {
    console.error("선물 정산 실패:", err.message);
  }

  // 3) 알림을 켠 유저에게 DM
  await notifyPriceChanges(env, changes);

  return Response.json({
    ok: true,
    announce,
    orders,
    futures,
    crowd: crowd?.summary,
    mode: label,
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}

// ---------- 1) 평소 변동: -20% ~ +20% (15분마다, cron-job.org: */15 * * * *) ----------
const NORMAL_RANGE = { minPct: -20, maxPct: 20 };

async function fluctuateTask(env) {
  // 급등락 시각 직전·직후에는 평소 변동을 쉬어서 겹치지 않게 함
  if (isSurgeMoment()) {
    return Response.json({ ok: true, skipped: true, reason: "급등락 시각이라 평소 변동은 건너뛰었어요." });
  }
  return runFluctuation(env, NORMAL_RANGE, "평소 변동");
}

// ---------- 2) 급등락: -80% ~ +120% (+ 종목마다 0.5% 확률로 -100%) ----------
// 하루 3번(18시/21시/0시 KST), 슬롯마다 딱 1번만 실행. 실행 기록은 Firebase config/surge 에 남겨요.
// 슬롯 시각이 아니면 평소 변동으로 처리해요.
const SURGE_RANGE = { minPct: -80, maxPct: 120, crashChance: 0.005, crashPct: -100 };

async function midnightTask(env) {
  let surge = false;
  const slot = currentSurgeSlot();
  if (slot) {
    const key = surgeSlotKey(slot);
    const state = await getDoc(env, "config/surge");
    if (state?.lastKey !== key) {
      // 실행 전에 먼저 기록해서, 5분 간격 호출이 겹쳐도 두 번 실행되지 않게 함
      await setDoc(env, "config/surge", { lastKey: key });
      surge = true;
    }
  }

  // 급등락이 아닌데 급등락 직전·직후라면 평소 변동만 쉼
  if (!surge && isSurgeMoment()) {
    return Response.json({ ok: true, skipped: true, reason: "급등락 시각 전후라 평소 변동은 건너뛰었어요." });
  }

  return runFluctuation(env, surge ? SURGE_RANGE : NORMAL_RANGE, surge ? slot.label : "평소 변동");
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
const TASKS = { fluctuate: fluctuateTask, midnight: midnightTask, prealert: prealertTask };

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
    return run(env);
  },
};