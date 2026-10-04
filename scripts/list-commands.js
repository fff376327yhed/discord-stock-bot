// 디스코드에 "실제로 등록된" 명령어 목록을 확인합니다: npm run commands
// (등록은 됐는데 안 보이는 건지, 등록 자체가 안 된 건지 구분할 때 써요)
//
// .env 의 DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN (선택: DISCORD_GUILD_ID) 를 사용해요.

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

async function show(url, label) {
  const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) {
    console.error(`[${label}] 조회 실패 (${res.status}):`, await res.text());
    return;
  }
  const list = await res.json();
  console.log(`[${label}] ${list.length}개`);
  console.log(list.length ? list.map((c) => `/${c.name}`).join("  ") : "(없음)");
  console.log(`  → /그래프 ${list.some((c) => c.name === "그래프") ? "등록되어 있어요 ✅" : "없어요 ❌"}\n`);
}

await show(`https://discord.com/api/v10/applications/${appId}/commands`, "글로벌");
if (guildId) {
  await show(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, "서버 전용");
}