import { verifyKey } from "discord-interactions";
import { handlers, autocomplete } from "../src/commands.js";
import { loadEnv } from "../src/env.js";

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

// 여기에 적은 명령어는 예외로 모두에게 공개돼요. 예: new Set(["랭킹"])
const PUBLIC_COMMANDS = new Set([]);

export default { fetch: handler };

function reply(content, ephemeral = true) {
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: ephemeral ? { content, flags: EPHEMERAL } : { content },
  });
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
    const ephemeral = !PUBLIC_COMMANDS.has(commandName);

    if (!handlerFn) {
      return reply("알 수 없는 명령어예요.");
    }

    try {
      const content = await handlerFn(interaction, env);
      return reply(content, ephemeral);
    } catch (err) {
      return reply(`오류가 발생했어요: ${err.message}`);
    }
  }

  return new Response("지원하지 않는 요청입니다.", { status: 400 });
}