import { loadEnv, isAuthorizedCron, currentSurgeSlot, surgeSlotKey } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";
import { processOrders } from "../../src/orders.js";
import { getDoc, setDoc } from "../../src/firebase.js";

// 급등락: -80% ~ +120% (+ 종목마다 0.5% 확률로 -100%) — 하루 딱 3번 (오후 6시, 오후 9시, 새벽 12시 / 한국시간)
//  - -100%가 나오면 가격이 최저가로 떨어져 바로 상장폐지(100해정 이하)돼요.
//  - 이 범위는 슬롯 시각(18시/21시/0시) 10분 전 ~ 30분 후에 호출됐을 때만 적용돼요.
//    그 밖의 시각에 호출되면 급등락 대신 평소 변동(-20% ~ +20%)으로 처리해요.
//  - 슬롯마다 딱 1번만 실행돼요. (실행 기록을 Firebase config/surge 에 남기고, 같은 슬롯에서 또 호출되면 건너뜀)
//  - 새벽 12시: vercel.json의 crons 설정(UTC 15:00 = KST 00:00)이 자동 호출
//  - 오후 6시(UTC 09:00), 오후 9시(UTC 12:00): cron-job.org에서 이 주소를 호출하도록 등록
//    (cron-job.org 시간대를 Asia/Seoul로 두고 매일 18:00 / 21:00 에 호출)
//  - 평소 변동(-20% ~ +20%)은 fluctuate.js가 담당해요.

// 급등락: -80% ~ +120%, 종목마다 0.5% 확률로 -100%
const SURGE_RANGE = { minPct: -80, maxPct: 120, crashChance: 0.005, crashPct: -100 };
// 평소 변동: -20% ~ +20%
const NORMAL_RANGE = { minPct: -20, maxPct: 20 };

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 급등락 시각이면 슬롯당 딱 1번만 실행, 아니면 평소 변동
  const slot = currentSurgeSlot();
  if (slot) {
    const key = surgeSlotKey(slot);
    const state = await getDoc(env, "config/surge");
    if (state?.lastKey === key) {
      return Response.json({ ok: true, skipped: true, reason: "이 시간대 급등락은 이미 실행했어요." });
    }
    // 실행 전에 먼저 기록해서, 5분 간격 호출이 겹쳐도 두 번 실행되지 않게 함
    await setDoc(env, "config/surge", { lastKey: key });
  }
  const range = slot ? SURGE_RANGE : NORMAL_RANGE;
  const label = slot ? slot.label : "평소 변동";

  const changes = await fluctuatePrices(env, range);

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, label);

  // 3) 예약 매수/매도 체결 (실패해도 시세 변동 결과는 그대로 응답)
  let orders = null;
  try {
    orders = await processOrders(env);
  } catch (err) {
    console.error("예약 주문 처리 실패:", err.message);
  }

  await notifyPriceChanges(env, changes);

  return Response.json({
    ok: true,
    announce,
    orders,
    mode: label,
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}