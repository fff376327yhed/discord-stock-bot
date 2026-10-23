import { verifyKey } from "discord-interactions";
import { handlers, autocomplete } from "../src/commands.js";
import { loadEnv } from "../src/env.js";
import { touchUsername } from "../src/economy.js";

// Node.js 런타임으로 동작 (Edge는 discord-interactions가 쓰는 Node crypto를 지원하지 않아 제외)
// Node.js 런타임도 요청이 올 때만 실행되고 평소엔 대기 상태인 서버리스예요.

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, APPLICATION_COMMAND_AUTOCOMPLETE: 4 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

// 응답을 "명령어를 친 본인에게만" 보이게 하는 플래그
const EPHEMERAL = 64;
// 응답을 "무음"(푸시 알림·소리 없음)으로 보내는 플래그
const SUPPRESS_NOTIFICATIONS = 4096;

// 여기에 적은 명령어는 예외로 모두에게 공개돼요. (알림도 평소처럼 감) 예: new Set(["랭킹"])
const PUBLIC_COMMANDS = new Set(["봇현황"]);

// 여기에 적은 명령어는 모두에게 공개되지만 "무음"이에요. (채널 사람들에게 알림이 안 가요)
const SILENT_PUBLIC_COMMANDS = new Set(["그래프"]);

export default { fetch: handler };

// content: 문자열, 또는 { content?, embeds? } 같은 객체(그래프처럼 이미지 임베드를 보낼 때)
// mode: "private"(나만 보임, 기본) | "public"(모두에게 보임) | "silent"(모두에게 보이지만 무음)
function reply(content, mode = "private") {
  const data = typeof content === "string" ? { content } : { ...content };
  if (mode === "private") data.flags = EPHEMERAL;
  else if (mode === "silent") data.flags = SUPPRESS_NOTIFICATIONS;
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  });
}

// 명령어 이름으로 공개 방식을 정해요.
function modeOf(commandName) {
  if (SILENT_PUBLIC_COMMANDS.has(commandName)) return "silent";
  if (PUBLIC_COMMANDS.has(commandName)) return "public";
  return "private";
}

async function handler(request) {
  if (request.method !== "POST") {
    return new Response("이 엔드포인트는 Discord Interactions 전용입니다.", { status: 405 });
  }

  const env = loadEnv();

  // ---- Discord 요청 서명 검증 (필수) ----
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();

  const isValid = signature && timestamp && (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValid) {
    return new Response("서명 검증 실패", { status: 401 });
  }

  const interaction = JSON.parse(body);

  // ---- PING: Discord가 엔드포인트 등록 시 헬스체크로 보냄 ----
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // ---- 자동완성: 종목/상품 이름을 입력할 때 목록을 돌려줌 ----
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    let choices = [];
    try {
      const allowed = !env.ALLOWED_CHANNEL_ID || interaction.channel_id === env.ALLOWED_CHANNEL_ID;
      if (allowed) choices = await autocomplete(interaction, env);
    } catch (err) {
      console.error("자동완성 오류:", err.message);
    }
    return Response.json({
      type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
      data: { choices },
    });
  }

  // ---- 슬래시 커맨드 처리 ----
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // 주식채널에서만 명령어 허용 (나만 보이는 메시지로 안내)
    if (env.ALLOWED_CHANNEL_ID && interaction.channel_id !== env.ALLOWED_CHANNEL_ID) {
      return reply(`이 명령어는 <#${env.ALLOWED_CHANNEL_ID}> 채널에서만 쓸 수 있어요.`);
    }

    const commandName = interaction.data.name;
    const handlerFn = handlers[commandName];
    const mode = modeOf(commandName);

    if (!handlerFn) {
      return reply("알 수 없는 명령어예요.");
    }

    // 관리자 패널에 ID와 같이 표시할 닉네임을 최신으로 저장해둠
    const userId = interaction.member?.user?.id;
    const displayName =
      interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username;
    if (userId) await touchUsername(env, userId, displayName);

    try {
      const content = await handlerFn(interaction, env);
      return reply(content, mode);
    } catch (err) {
      // 오류 메시지는 항상 나만 보이게
      return reply(`오류가 발생했어요: ${err.message}`);
    }
  }

  return new Response("지원하지 않는 요청입니다.", { status: 400 });
}