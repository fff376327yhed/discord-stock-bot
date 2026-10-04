import { loadEnv, isAuthorizedCron } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";

// 급등락: ±100% (하루 3번 — 오후 6시, 오후 9시, 새벽 12시 / 한국시간)
//  - -100%가 나오면 가격이 최저가로 떨어져 바로 상장폐지(100해정 이하)돼요.
//  - 새벽 12시: vercel.json의 crons 설정(UTC 15:00 = KST 00:00)이 자동 호출
//  - 오후 6시(UTC 09:00), 오후 9시(UTC 12:00): Vercel Hobby는 하루 1번만 가능해서
//    cron-job.org에서 이 주소를 호출하도록 따로 등록해야 해요. (README/답변 참고)
// 호출된 시각(한국시간)에 가장 가까운 슬롯 이름을 공지 제목에 써요. (Hobby 플랜은 정시 보장이 안 됨)

export default { fetch: handler };

// 슬롯: 0시(자정), 18시, 21시 중 현재 시각과 가장 가까운 것
function slotLabel() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const t = now.getUTCHours() + now.getUTCMinutes() / 60;
  const slots = [
    { at: 0, label: "새벽 12시 급등락" },
    { at: 18, label: "오후 6시 급등락" },
    { at: 21, label: "오후 9시 급등락" },
    { at: 24, label: "새벽 12시 급등락" },
  ];
  let best = slots[0];
  for (const s of slots) {
    if (Math.abs(s.at - t) < Math.abs(best.at - t)) best = s;
  }
  return best.label;
}

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const changes = await fluctuatePrices(env, { minPct: -100, maxPct: 100 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, slotLabel());
  await notifyPriceChanges(env, changes);

  return Response.json({
    ok: true,
    announce,
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}