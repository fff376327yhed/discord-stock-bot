import { loadEnv, isAuthorizedCron } from "../../src/env.js";
import { fluctuatePrices } from "../../src/economy.js";

// 매일 자정(한국시간 00:00) 급등락: ±70%
// vercel.json의 crons 설정(UTC 15:00 = KST 00:00)에 의해 Vercel이 하루 1회 자동 호출해요.
// Hobby 플랜은 정시 호출을 보장하지 않고 "그 시간대 안 어딘가"에 실행될 수 있어요.

export default { fetch: handler };

async function handler(request) {
  const env = loadEnv();

  if (!isAuthorizedCron(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const changes = await fluctuatePrices(env, { minPct: -70, maxPct: 70 });
  return Response.json({ ok: true, count: changes.length, changes });
}
