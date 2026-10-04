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