// 로컬에서 한 번만 실행: node scripts/set-slowmode.js
//
// 실행 전 환경변수 설정 필요:
//   DISCORD_BOT_TOKEN  — 봇 토큰
//   CHANNEL_ID         — 슬로우모드를 걸 채널 ID (주식채널)
//   SLOWMODE_SECONDS   — (선택) 기본값 3

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.CHANNEL_ID;
const seconds = Number(process.env.SLOWMODE_SECONDS ?? 3);

if (!token || !channelId) {
  console.error("DISCORD_BOT_TOKEN, CHANNEL_ID 환경변수를 설정해주세요.");
  process.exit(1);
}

if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
  console.error("SLOWMODE_SECONDS는 0~21600 사이의 정수여야 해요.");
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ rate_limit_per_user: seconds }),
});

if (!res.ok) {
  console.error(`설정 실패 (${res.status}):`, await res.text());
  process.exit(1);
}

const data = await res.json();
console.log(`#${data.name} 슬로우모드를 ${data.rate_limit_per_user}초로 설정했어요.`);