import { loadEnv, isAuthorizedCron, currentSurgeSlot } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";
import { announcePriceChanges, notifyPriceChanges } from "../../src/notify.js";

// 급등락: ±100% — 하루 딱 3번 (오후 6시, 오후 9시, 새벽 12시 / 한국시간)
//  - -100%가 나오면 가격이 최저가로 떨어져 바로 상장폐지(100해정 이하)돼요.
//  - 이 주소는 슬롯 시각(6시/9시/12시) 10분 전 ~ 30분 후에만 실제로 변동시켜요.
//    그 밖의 시각에 호출되면 아무것도 바꾸지 않고 건너뛰어요. (시간대를 잘못 등록해도 엉뚱한 때 급등락이 안 일어남)
//  - 새벽 12시: vercel.json의 crons 설정(UTC 15:00 = KST 00:00)이 자동 호출
//  - 오후 6시(UTC 09:00), 오후 9시(UTC 12:00): cron-job.org에서 이 주소를 호출하도록 등록
//    (cron-job.org 시간대를 Asia/Seoul로 두고 매일 18:00 / 21:00 에 호출)
//  - 평소 변동(±50%)은 fluctuate.js가 담당해요.

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 급등락 시각이 아니면 실행하지 않음
  const slot = currentSurgeSlot();
  if (!slot) {
    return Response.json({
      ok: true,
      skipped: true,
      reason: "급등락 시각(한국시간 18시/21시/0시)이 아니라서 건너뛰었어요. cron-job.org 시간대를 확인하세요.",
    });
  }

  const changes = await fluctuatePrices(env, { minPct: -100, maxPct: 100 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, slot.label);
  await notifyPriceChanges(env, changes);

  return Response.json({
    ok: true,
    announce,
    slot: slot.label,
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}
