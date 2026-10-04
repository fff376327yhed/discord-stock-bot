// 로컬에서 한 번만 실행하면 됩니다: npm run register
// (슬래시 커맨드 목록을 바꿀 때마다 다시 실행)
//
// .env 파일에 아래 값을 채워두세요:
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN
//   DISCORD_GUILD_ID  — (선택) 내 서버 ID. 넣으면 "서버 전용"으로 등록해서 바로 반영돼요.
//                       비워두면 "전체 공개(글로벌)"로 등록하고, 반영에 시간이 걸릴 수 있어요.

import { commandDefinitions } from "../src/commands.js";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN 환경변수(.env)를 설정해주세요.");
  process.exit(1);
}

// PUT: 전체 커맨드 목록을 한 번에 덮어씀(bulk overwrite)
async function put(url, body, label) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`${label} 등록 실패 (${res.status}):`, await res.text());
    process.exit(1);
  }
  return res.json();
}

const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;

if (guildId) {
  // 서버 전용 등록: 거의 즉시 반영
  const saved = await put(
    `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
    commandDefinitions,
    "서버 전용"
  );
  // 예전에 글로벌로 등록한 명령어가 남아 있으면 목록에 같은 명령어가 두 번 보이므로 비워줌
  await put(globalUrl, [], "글로벌 정리");
  console.log(`서버 전용으로 ${saved.length}개 커맨드 등록 완료. (글로벌 등록은 비웠어요)`);
} else {
  const saved = await put(globalUrl, commandDefinitions, "글로벌");
  console.log(`글로벌로 ${saved.length}개 커맨드 등록 완료. (디스코드에 반영되기까지 시간이 걸릴 수 있어요)`);
}