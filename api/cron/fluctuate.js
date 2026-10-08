import { loadEnv, isAuthorizedCron, isSurgeMoment } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";
import { processOrders } from "../../src/orders.js";

// 평소 시세 변동: -20% ~ +20%
// Vercel Hobby(무료) 플랜의 자체 Cron은 하루 1회까지만 무료라서,
// 15분마다 변동시키려면 cron-job.org 같은 무료 외부 스케줄러가 이 주소를 호출하게 해야 해요.
// (cron-job.org 스케줄: */15 * * * *)
// 변동 후 가격이 상장폐지 기준가(economy.js의 DELIST_PRICE, 100해정) 이하면 자동으로 상장폐지돼요.

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 급등락 시각(18시/21시/0시) 직전·직후에는 평소 변동을 쉬어서 급등락과 겹치지 않게 함
  if (isSurgeMoment()) {
    return Response.json({ ok: true, skipped: true, reason: "급등락 시각이라 평소 변동은 건너뛰었어요." });
  }

  const changes = await fluctuatePrices(env, { minPct: -20, maxPct: 20 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, "평소 변동");

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
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}