// 로컬에서 한 번만 실행하면 됩니다: node scripts/register-commands.js
// (슬래시 커맨드 목록을 바꿀 때마다 다시 실행)
//
// 실행 전 환경변수 설정 필요:
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN

import { commandDefinitions } from "../src/commands.js";

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!appId || !token) {
  console.error("DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN 환경변수를 설정해주세요.");
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT", // PUT: 전체 커맨드 목록을 한 번에 덮어씀(bulk overwrite)
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commandDefinitions),
});

if (!res.ok) {
  console.error("커맨드 등록 실패:", await res.text());
  process.exit(1);
}

console.log(`${commandDefinitions.length}개 커맨드 등록 완료.`);
