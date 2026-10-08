// Vercel 프로젝트에 등록해둔 환경변수를 한 곳에서 모아줍니다.
export function loadEnv() {
  return {
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    ADMIN_DISCORD_ID: process.env.ADMIN_DISCORD_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    ADMIN_PANEL_PASSWORD: process.env.ADMIN_PANEL_PASSWORD,
    ALLOWED_CHANNEL_ID: process.env.ALLOWED_CHANNEL_ID,
  };
}

// Cron 엔드포인트는 외부에 공개된 URL이라, 아무나 호출 못 하도록
// Authorization: Bearer <CRON_SECRET> 헤더를 확인합니다.
// (Vercel 자체 Cron은 이 헤더를 자동으로 붙여서 보내줍니다.)
export function isAuthorizedCron(request, env) {
  if (!env.CRON_SECRET) return false;
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${env.CRON_SECRET}`;
}
// ---------- 급등락 시각 ----------
// 하루 딱 3번: 새벽 12시(0시), 오후 6시, 오후 9시 (한국시간)
const SURGE_SLOTS = [
  { hour: 0, label: "새벽 12시 급등락" },
  { hour: 18, label: "오후 6시 급등락" },
  { hour: 21, label: "오후 9시 급등락" },
];

// 현재 한국시간이 슬롯 시각에서 몇 분 떨어져 있는지 (음수 = 슬롯 전, 양수 = 슬롯 후)
function minutesFromSlot(hour, now) {
  const d = new Date(now + 9 * 60 * 60 * 1000);
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((nowMin - hour * 60 + 1440 + 720) % 1440) - 720;
}

// 지금이 급등락 시각이면 { hour, label }, 아니면 null
// 급등락은 슬롯 1분 전 ~ 30분 후 사이에 호출됐을 때만 실행돼요. (외부 스케줄러가 조금 늦거나 빨라도 허용)
// 주의: 시작을 너무 일찍(예: 10분 전) 잡으면 5분 간격 호출 시 정각보다 먼저 급등락이 터져요.
export function currentSurgeSlot(now = Date.now()) {
  for (const s of SURGE_SLOTS) {
    const diff = minutesFromSlot(s.hour, now);
    if (diff >= -1 && diff <= 30) return s;
  }
  return null;
}

// 평소 변동(±50%)을 건너뛸지: 급등락 시각 3분 전 ~ 5분 후에는 평소 변동을 쉬어서 겹치지 않게 해요.
export function isSurgeMoment(now = Date.now()) {
  return SURGE_SLOTS.some((s) => {
    const diff = minutesFromSlot(s.hour, now);
    return diff >= -3 && diff <= 5;
  });
}

// 급등락 슬롯의 "그날 몇 시 슬롯" 고유 키. 예: "2026-10-08-18"
// 새벽 12시 슬롯은 23:50~00:30에 걸쳐 있어서 날짜가 바뀌어도 같은 키가 나오도록 계산해요.
export function surgeSlotKey(slot, now = Date.now()) {
  const shifted = new Date(now + 9 * 60 * 60 * 1000 - slot.hour * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 10)}-${slot.hour}`;
}