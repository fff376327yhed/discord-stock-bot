import { verifyKey } from "discord-interactions";
import { handlers } from "../src/commands.js";

// Vercel Edge Function으로 동작 — 요청이 올 때만 실행되고 평소엔 대기 상태
export const config = { runtime: "edge" };

const InteractionType = { PING: 1, APPLICATION_COMMAND: 2 };
const InteractionResponseType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4 };

// Vercel 프로젝트에 등록해둔 환경변수를 다른 파일(firebase.js 등)이 쓰던
// env 객체 형태 그대로 모아줍니다. (Workers -> Vercel 전환 시 다른 파일은 수정 불필요)
function loadEnv() {
  return {
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    ADMIN_DISCORD_ID: process.env.ADMIN_DISCORD_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  };
}

export default async function handler(request) {
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

  // ---- 슬래시 커맨드 처리 ----
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data.name;
    const handlerFn = handlers[commandName];

    if (!handlerFn) {
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "알 수 없는 명령어예요." },
      });
    }

    try {
      const content = await handlerFn(interaction, env);
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content },
      });
    } catch (err) {
      return Response.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `오류가 발생했어요: ${err.message}` },
      });
    }
  }

  return new Response("지원하지 않는 요청입니다.", { status: 400 });
}
