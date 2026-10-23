import { verifyKey } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import { handlers, autocomplete } from "../src/commands.js";
import { loadEnv } from "../src/env.js";
import { touchUsername } from "../src/economy.js";

// Node.js 런타임으로 동작 (Edge는 discord-interactions가 쓰는 Node crypto를 지원하지 않아 제외)
// Node.js 런타임도 요청이 올 때만 실행되고 평소엔 대기 상태인 서버리스예요.

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, APPLICATION_COMMAND_AUTOCOMPLETE: 4 };
const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

// 응답을 "명령어를 친 본인에게만" 보이게 하는 플래그
const EPHEMERAL = 64;
// 응답을 "무음"(푸시 알림·소리 없음)으로 보내는 플래그
const SUPPRESS_NOTIFICATIONS = 4096;

// 여기에 적은 명령어는 예외로 모두에게 공개돼요. (알림도 평소처럼 감) 예: new Set(["랭킹"])
const PUBLIC_COMMANDS = new Set([]);

// 여기에 적은 명령어는 모두에게 공개되지만 "무음"이에요. (채널 사람들에게 알림이 안 가요)
const SILENT_PUBLIC_COMMANDS = new Set(["그래프", "봇현황"]);

// 이 시간(ms) 안에 처리가 끝나면 바로 응답하고, 넘기면 "처리 중…"(지연 응답)으로 먼저 답한 뒤
// 끝나는 대로 결과를 채워요. (디스코드는 3초 안에 첫 응답이 없으면 "응답하지 않았어요"를 띄워요)
const DEFER_AFTER_MS = 2000;

export default { fetch: handler };

// content: 문자열, 또는 { content?, embeds? } 같은 객체(그래프처럼 이미지 임베드를 보낼 때)
// mode: "private"(나만 보임, 기본) | "public"(모두에게 보임) | "silent"(모두에게 보이지만 무음)
function flagsOf(mode) {
  if (mode === "private") return EPHEMERAL;
  if (mode === "silent") return SUPPRESS_NOTIFICATIONS;
  return undefined;
}

function reply(content, mode = "private") {
  const data = typeof content === "string" ? { content } : { ...content };
  const flags = flagsOf(mode);
  if (flags !== undefined) data.flags = flags;
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  });
}

// 지연 응답: 먼저 "처리 중…"을 띄움. 나만 보기/무음 여부는 이 첫 응답에서 정해지고, 나중에 바꿀 수 없어요.
function deferReply(mode) {
  const flags = flagsOf(mode);
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: flags !== undefined ? { flags } : {},
  });
}

// 지연 응답으로 띄운 "처리 중…" 메시지를 결과로 바꿈
async function editOriginal(interaction, content) {
  const data = typeof content === "string" ? { content } : { ...content };
  delete data.flags; // 공개 방식은 첫 응답에서 이미 정해졌어요
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (!res.ok) console.error(`지연 응답 수정 실패(${res.status}):`, await res.text());
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

    // 닉네임 저장 + 명령어 처리를 하나의 작업으로 묶어요.
    // (닉네임 저장이 먼저 끝나야 신규 유저 문서가 겹쳐 쓰이지 않아서 순서는 그대로 유지)
    const userId = interaction.member?.user?.id;
    const displayName =
      interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username;

    const work = (async () => {
      try {
        if (userId) await touchUsername(env, userId, displayName);
        return { content: await handlerFn(interaction, env), mode };
      } catch (err) {
        // 오류 메시지는 항상 나만 보이게
        console.error(`명령어 오류 (${commandName}):`, err.message);
        return { content: `오류가 발생했어요: ${err.message}`, mode: "private", failed: true };
      }
    })();

    // 2초 안에 끝나면 평소처럼 바로 응답
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DEFER_AFTER_MS));
    const quick = await Promise.race([work, timeout]);
    if (quick) return reply(quick.content, quick.mode);

    // 오래 걸리면 먼저 "처리 중…"으로 응답하고, 끝나면 결과로 바꿔요.
    // waitUntil: 응답을 보낸 뒤에도 서버리스 함수가 작업이 끝날 때까지 살아 있게 해요.
    waitUntil(
      work.then(async (result) => {
        try {
          await editOriginal(interaction, result.content);
        } catch (err) {
          console.error("지연 응답 전송 실패:", err.message);
        }
      })
    );
    return deferReply(mode);
  }

  return new Response("지원하지 않는 요청입니다.", { status: 400 });
}