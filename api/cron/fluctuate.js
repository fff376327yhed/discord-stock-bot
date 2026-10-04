import { loadEnv, isAuthorizedCron } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";

// 평소 시세 변동: ±30%
// Vercel Hobby(무료) 플랜의 자체 Cron은 하루 1회까지만 무료라서,
// 15분마다 변동시키려면 cron-job.org 같은 무료 외부 스케줄러가 이 주소를 호출하게 해야 해요.
// (cron-job.org 스케줄: */15 * * * *)

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const changes = await fluctuatePrices(env, { minPct: -30, maxPct: 30 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, "평소 변동");
  await notifyPriceChanges(env, changes);

  return Response.json({ ok: true, announce, count: changes.length, changes });
}