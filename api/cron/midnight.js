import { loadEnv, isAuthorizedCron } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";

// 매일 자정(한국시간 00:00) 급등락: ±70%
// vercel.json의 crons 설정(UTC 15:00 = KST 00:00)에 의해 Vercel이 하루 1회 자동 호출해요.

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const changes = await fluctuatePrices(env, { minPct: -70, maxPct: 70 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, "자정 급등락");
  await notifyPriceChanges(env, changes);

  return Response.json({ ok: true, announce, count: changes.length, changes });
}