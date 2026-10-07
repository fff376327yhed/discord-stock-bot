import { loadEnv, isAuthorizedCron, currentSurgeSlot } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";
import { processOrders } from "../../src/orders.js";

// 급등락: -150% ~ +230% — 하루 딱 3번 (오후 6시, 오후 9시, 새벽 12시 / 한국시간)
//  - -100% 이하가 나오면 가격이 최저가로 떨어져 바로 상장폐지(100해정 이하)돼요.
//  - 이 범위는 슬롯 시각(18시/21시/0시) 10분 전 ~ 30분 후에 호출됐을 때만 적용돼요.
//    그 밖의 시각에 호출되면 급등락 대신 평소 변동(-50% ~ +75%)으로 처리해요.
//    (시간대를 잘못 등록하거나 이 주소를 평소 변동용으로 걸어둬도 공지가 끊기지 않고, 엉뚱한 때 급등락도 안 일어남)
//  - 새벽 12시: vercel.json의 crons 설정(UTC 15:00 = KST 00:00)이 자동 호출
//  - 오후 6시(UTC 09:00), 오후 9시(UTC 12:00): cron-job.org에서 이 주소를 호출하도록 등록
//    (cron-job.org 시간대를 Asia/Seoul로 두고 매일 18:00 / 21:00 에 호출)
//  - 평소 변동(-50% ~ +75%)은 fluctuate.js가 담당해요.

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 급등락 시각이면 -150%~+230%, 아니면 평소 변동(-50%~+75%)
  const slot = currentSurgeSlot();
  const range = slot ? { minPct: -150, maxPct: 230 } : { minPct: -50, maxPct: 75 };
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