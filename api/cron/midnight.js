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

const SLOT_LABELS = {
  0: "새벽 12시 급등락",
  18: "오후 6시 급등락",
  21: "오후 9시 급등락",
};
const SLOT_TOLERANCE_MIN = 30; // 슬롯 시각 ±30분 안에서만 시각 이름을 써요

// cron-job.org 주소 뒤에 ?slot=18 / ?slot=21 / ?slot=0 을 붙이면 그 이름을 강제로 써요.
// 안 붙이면 현재 한국시간이 슬롯 시각 ±30분 안일 때만 이름을 붙이고, 아니면 그냥 "급등락"이에요.
function slotLabel(request) {
  const forced = new URL(request.url).searchParams.get("slot");
  if (forced !== null && SLOT_LABELS[Number(forced)]) return SLOT_LABELS[Number(forced)];

  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();

  for (const [hour, label] of Object.entries(SLOT_LABELS)) {
    const diff = Math.abs(nowMin - Number(hour) * 60);
    if (Math.min(diff, 1440 - diff) <= SLOT_TOLERANCE_MIN) return label;
  }
  return "급등락";
}

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const changes = await fluctuatePrices(env, { minPct: -100, maxPct: 100 });

  // 1) 주식채널에 변동 내역 공지 (알림 설정과 무관), 2) 알림을 켠 유저에게 DM
  const announce = await announcePriceChanges(env, changes, slotLabel(request));
  await notifyPriceChanges(env, changes);

  return Response.json({
    ok: true,
    announce,
    count: changes.length,
    delisted: changes.filter((c) => c.delisted).map((c) => c.name),
    changes,
  });
}