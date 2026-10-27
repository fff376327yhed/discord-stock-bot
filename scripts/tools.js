// 로컬에서 쓰는 디스코드 도구 3개를 합친 스크립트예요.
//   node scripts/tools.js register       슬래시 커맨드 등록 (목록을 바꿀 때마다 실행)
//   node scripts/tools.js list           디스코드에 실제 등록된 명령어 확인
//   node scripts/tools.js slowmode       주식채널 슬로우모드 설정
//
// .env 값:
//   DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN   (register / list)
//   DISCORD_GUILD_ID     (선택) 있으면 "서버 전용"으로 등록/조회 → 바로 반영돼요. 없으면 글로벌.
//   CHANNEL_ID           (slowmode) 슬로우모드를 걸 채널 ID
//   SLOWMODE_SECONDS     (slowmode, 선택) 기본 3

import { commandDefinitions } from "../src/lib.js";

const API = "https://discord.com/api/v10";
const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

function need(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`${missing.join(", ")} 환경변수(.env)를 설정해주세요.`);
    process.exit(1);
  }
}

// ---------- register ----------
// PUT: 전체 커맨드 목록을 한 번에 덮어씀(bulk overwrite)
async function put(url, body, label) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`${label} 등록 실패 (${res.status}):`, await res.text());
    process.exit(1);
  }
  return res.json();
}

async function register() {
  need("DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN");
  const globalUrl = `${API}/applications/${appId}/commands`;
  if (guildId) {
    const saved = await put(`${API}/applications/${appId}/guilds/${guildId}/commands`, commandDefinitions, "서버 전용");
    // 예전에 글로벌로 등록한 명령어가 남아 있으면 같은 명령어가 두 번 보이므로 비워줌
    await put(globalUrl, [], "글로벌 정리");
    console.log(`서버 전용으로 ${saved.length}개 커맨드 등록 완료. (글로벌 등록은 비웠어요)`);
  } else {
    const saved = await put(globalUrl, commandDefinitions, "글로벌");
    console.log(`글로벌로 ${saved.length}개 커맨드 등록 완료. (디스코드에 반영되기까지 시간이 걸릴 수 있어요)`);
  }
}

// ---------- list ----------
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

async function list() {
  need("DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN");
  await show(`${API}/applications/${appId}/commands`, "글로벌");
  if (guildId) await show(`${API}/applications/${appId}/guilds/${guildId}/commands`, "서버 전용");
}

// ---------- slowmode ----------
async function slowmode() {
  need("DISCORD_BOT_TOKEN", "CHANNEL_ID");
  const seconds = Number(process.env.SLOWMODE_SECONDS ?? 3);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
    console.error("SLOWMODE_SECONDS는 0~21600 사이의 정수여야 해요.");
    process.exit(1);
  }
  const res = await fetch(`${API}/channels/${process.env.CHANNEL_ID}`, {
    method: "PATCH",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rate_limit_per_user: seconds }),
  });
  if (!res.ok) {
    console.error(`설정 실패 (${res.status}):`, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  console.log(`#${data.name} 슬로우모드를 ${data.rate_limit_per_user}초로 설정했어요.`);
}

const COMMANDS = { register, list, slowmode };
const cmd = process.argv[2];
if (!COMMANDS[cmd]) {
  console.error(`사용법: node scripts/tools.js <${Object.keys(COMMANDS).join("|")}>`);
  process.exit(1);
}
await COMMANDS[cmd]();
