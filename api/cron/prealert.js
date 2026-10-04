import { loadEnv, isAuthorizedCron } from "../../src/env.js";
import { announcePreAlert } from "../../src/notify.js";

// 급등락(±100%) 6분 전 예고
// cron-job.org 설정: 매일 17:54 / 20:54 / 23:54 (Asia/Seoul) 에 이 주소 호출
//   - 헤더: Authorization: Bearer <CRON_SECRET>

// 급등락 시각 (한국시간, 자정 기준 분)
const SLOTS = [
  { min: 18 * 60, label: "오후 6시 급등락" },
  { min: 21 * 60, label: "오후 9시 급등락" },
  { min: 0, label: "새벽 12시 급등락" },
];

// 몇 분 전에 알릴지 (5~6분 사이에 호출되면 예고)
const LEAD_MIN = 5;
const LEAD_MAX = 6;

export default { fetch: handler };

// 한국시간 기준 현재 분 (0~1439)
function kstNowMinutes() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = kstNowMinutes();

  // 다음 급등락까지 남은 분 (자정을 넘어가는 경우도 계산)
  let target = null;
  for (const slot of SLOTS) {
    const diff = (slot.min - now + 1440) % 1440;
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
