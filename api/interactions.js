import {
  marketHandlers, marketAutocomplete, marketCommandDefinitions,
  MARKET_VIEW_ONLY, MARKET_SILENT, processMarket, marketStake,
} from "../src/market.js";

import { verifyKey } from "discord-interactions";
import { waitUntil } from "@vercel/functions";
import {
  handlers, autocomplete, loadEnv, touchUsername,
  logAction, summarizeOptions, firstLine, VIEW_ONLY, flattenInteraction,
  getBans, // ← 추가
} from "../src/lib.js";

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

// 멘션(<@유저ID>)이 글자로는 보이지만 알림은 보내지 않게 하는 설정 (랭킹처럼 멘션이 들어간 응답용)
const NO_PING = { parse: [] };

// 핸들러가 거래 금액을 로그에 남기고 싶을 때 { message, amount } 형태로 반환해요.
// 디스코드에는 message만 보내고, amount는 로그용으로만 떼어내요.
function splitAmount(raw) {
  if (raw && typeof raw === "object" && "message" in raw && "amount" in raw) {
    return { content: raw.message, amount: raw.amount };
  }
  return { content: raw, amount: undefined };
}

// 기본값은 "나만 보기"예요. 아래 목록들은 예외로 쓰는 거예요.

// 여기에 적은 명령어는 "나만 보기"로 보내요. 예: new Set(["잔고", "내역"])
const PRIVATE_COMMANDS = new Set([]);

// 여기에 적은 명령어는 모두에게 공개 + 알림도 평소처럼 가요. 예: new Set(["랭킹"])
const PUBLIC_COMMANDS = new Set([]);

// 기본값은 "나만 보기"예요. 여기에 적은 명령어만 채널에 모두에게 보이게(무음) 보내요.
const SILENT_COMMANDS = new Set(["도움말", "랭킹", "채굴랭킹", "광물", "지수", "종목정보", "그래프", "봇현황", "매수", "매도", "상장폐지종류", "보유종목", "주식상점", "선물", "선물목록", "선물청산", "선물설명", "은행설명", "예금", "출금", "대출", "상환", "환율", "환전", "주식질문"]);

// 이 시간(ms) 안에 처리가 끝나면 바로 응답하고, 넘기면 "처리 중…"(지연 응답)으로 먼저 답한 뒤
// 끝나는 대로 결과를 채워요. (디스코드는 3초 안에 첫 응답이 없으면 "응답하지 않았어요"를 띄워요)
const DEFER_AFTER_MS = 1200; // 콜드 스타트 여유를 두려고 줄였어요

export const config = { maxDuration: 60 };

export default { fetch: handler };

// content: 문자열, 또는 { content?, embeds? } 같은 객체(그래프처럼 이미지 임베드를 보낼 때)
// mode: "private"(나만 보임) | "public"(모두에게 보임) | "silent"(모두에게 보이지만 무음, 기본)
function flagsOf(mode) {
  if (mode === "private") return EPHEMERAL;
  if (mode === "silent") return SUPPRESS_NOTIFICATIONS;
  return undefined;
}

function reply(content, mode = "silent") {
  const data = typeof content === "string" ? { content } : { ...content };
  const flags = flagsOf(mode);
  if (flags !== undefined) data.flags = flags;
  data.allowed_mentions = NO_PING; // 메시지 안의 <@유저> 멘션이 실제 알림을 보내지 않게 함
  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data,
  });
}

// 지연 응답: 먼저 "처리 중…"을 띄움. 나만 보기/무음 여부는 이 첫 응답에서 정해지고, 나중에 바꿀 수 없어요.
function deferReply(mode) {
  // 디스코드의 "생각 중…" 지연 응답(type 5)은 무음 표시가 적용되지 않아요.
  // 그래서 무음 명령어는 지연 응답 대신 "처리 중" 메시지를 무음으로 바로 보내고, 나중에 결과로 바꿔요.
  if (mode === "silent") return reply("⏳ 처리 중이에요…", "silent");

  const flags = flagsOf(mode);
  return Response.json({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: flags !== undefined ? { flags } : {},
  });
}

// 지연 응답으로 띄운 "처리 중…" 메시지를 결과로 바꿈
async function editOriginal(interaction, content, env, mode) {
  const data = typeof content === "string" ? { content } : { ...content };
  delete data.flags; // 공개 방식은 첫 응답에서 이미 정해졌어요
  data.allowed_mentions = NO_PING;
  if (data.content === undefined) data.content = ""; // 임베드만 보낼 때 "처리 중" 글자를 지움
  const res = await fetch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }
  );
  if (res.ok) return;

  const errText = await res.text().catch(() => "");
  console.error(`지연 응답 수정 실패(${res.status}):`, errText);

  // 404 "Unknown Webhook"은 인터랙션 토큰이 만료(15분 초과)됐거나 원본 메시지가 사라진 경우예요.
  // 이러면 webhook으로는 더 이상 손쓸 수 없으니, 봇 토큰으로 채널에 새 메시지로라도 보내요.
  // (나만 보기(ephemeral) 응답이었다면 원래 보이던 사람에게만 보일 수 없어 공개로 나가는 점은 감안해 주세요.)
  // 나만 보기(private) 응답은 공개로 새어 나가면 안 되니까 폴백하지 않아요.
  // 나만 보기(private) 응답은 채널에 올리면 안 되니, 대신 그 유저에게 DM으로 보내요. (DM이 막혀 있으면 포기)
  if (res.status === 404 && mode === "private") {
    const uid = interaction.member?.user?.id;
    if (uid && env?.DISCORD_BOT_TOKEN) {
      try {
        const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
        const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
          method: "POST",
          headers,
          body: JSON.stringify({ recipient_id: uid }),
        });
        if (dmRes.ok) {
          const dm = await dmRes.json();
          const dmData = { ...data, content: `⏳ 응답이 늦어서 DM으로 보내요.\n${data.content || ""}`.slice(0, 2000) };
          const sent = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, { method: "POST", headers, body: JSON.stringify(dmData) });
          if (!sent.ok) console.error(`DM 전송 실패(${sent.status}):`, await sent.text());
        } else {
          console.error(`DM 채널 열기 실패(${dmRes.status}):`, await dmRes.text());
        }
      } catch (err) {
        console.error("DM 전송 중 오류:", err.message);
      }
    }
    return;
  }

  if (res.status === 404 && mode !== "private" && env?.DISCORD_BOT_TOKEN && interaction.channel_id) {
    try {
      const fallbackRes = await fetch(`https://discord.com/api/v10/channels/${interaction.channel_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!fallbackRes.ok) console.error(`지연 응답 채널 전송 실패(${fallbackRes.status}):`, await fallbackRes.text());
    } catch (err) {
      console.error("지연 응답 채널 전송 중 오류:", err.message);
    }
  }
}

// 명령어 이름으로 공개 방식을 정해요. 기본값은 "나만 보기"예요.
function modeOf(commandName) {
  if (PUBLIC_COMMANDS.has(commandName)) return "public"; // 모두에게 공개 + 알림도 평소처럼
  if (SILENT_COMMANDS.has(commandName) || MARKET_SILENT.has(commandName)) return "silent"; // 모두에게 공개, 무음
  return "private"; // 나머지는 나에게만 보임
}

async function handler(request) {
  const t0 = Date.now(); // 요청이 들어온 시각 (타이머를 여기서부터 재요)
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

  // /주식 은행업무 예금 처럼 들어온 요청을 예전 모양(name="예금")으로 풀어줘요. 아래 코드는 그대로 써도 돼요.
  const interaction = flattenInteraction(JSON.parse(body));

  // ---- PING: Discord가 엔드포인트 등록 시 헬스체크로 보냄 ----
  if (interaction.type === InteractionType.PING) {
    return Response.json({ type: InteractionResponseType.PONG });
  }

  // ---- 자동완성: 종목/상품 이름을 입력할 때 목록을 돌려줌 ----
  if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
    let choices = [];
    try {
      const allowed = !env.ALLOWED_CHANNEL_ID || interaction.channel_id === env.ALLOWED_CHANNEL_ID;
      if (allowed) choices = (await marketAutocomplete(interaction, env)) ?? (await autocomplete(interaction, env));
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
      return reply(`이 명령어는 <#${env.ALLOWED_CHANNEL_ID}> 채널에서만 쓸 수 있어요.`, "private");
    }

    const commandName = interaction.data.name;
    const handlerFn = handlers[commandName] || marketHandlers[commandName];
    const mode = modeOf(commandName);

    if (!handlerFn) {
      return reply("알 수 없는 명령어예요.", "private");
    }

    const userId = interaction.member?.user?.id;
    const displayName =
      interaction.member?.nick || interaction.member?.user?.global_name || interaction.member?.user?.username;

    const work = (async () => {
      try {
        // 차단된 유저는 명령어를 쓸 수 없어요. (관리자는 통과, 확인이 실패하면 막지 않고 진행)
        if (userId && userId !== env.ADMIN_DISCORD_ID) {
          try {
            const ban = (await getBans(env))[userId];
            if (ban) {
              return { content: `🚫 관리자가 이 계정의 봇 사용을 막았어요.${ban.reason ? `\n사유: ${ban.reason}` : ""}`, mode: "private" };
            }
          } catch (err) {
            console.error("차단 목록 확인 실패:", err.message);
          }
        }
        if (userId) await touchUsername(env, userId, displayName);
        // 장터에 맡겨 둔 주식·입찰금은 순자산에 안 잡혀서, 파산으로 빚만 지우고 되찾는 꼼수를 막아요
        if (commandName === "파산신청" && userId) {
          const stake = await marketStake(env, userId);
          if (stake) {
            const list = stake.slice(0, 5).map((i) => `\`#${i.id}\``).join(" ");
            return {
              content: `🚫 장터에 올려 둔 물건이나 입찰 중인 경매가 있어서 파산을 신청할 수 없어요. (${list}${stake.length > 5 ? " 외" : ""})\n\`/거래취소\` \`/경매취소\`로 정리하거나 끝날 때까지 기다린 뒤 다시 신청해 주세요.`,
              mode: "private",
            };
          }
        }
        const { content, amount } = splitAmount(await handlerFn(interaction, env));
        // 활동 로그 (응답을 늦추지 않게 뒤에서 저장)
        if (userId && !VIEW_ONLY.has(commandName) && !MARKET_VIEW_ONLY.has(commandName)) {
          waitUntil(
            logAction(env, {
              u: userId,
              n: displayName,
              cmd: commandName,
              a: summarizeOptions(interaction.data.options),
              r: firstLine(content),
              amt: amount,
            })
          );
        }
        return { content, mode };
      } catch (err) {
        // 오류 메시지는 항상 나만 보이게
        console.error(`명령어 오류 (${commandName}):`, err.message);
        if (userId) {
          waitUntil(
            logAction(env, {
              u: userId,
              n: displayName,
              cmd: commandName,
              a: summarizeOptions(interaction.data.options),
              r: `오류: ${err.message}`.slice(0, 160),
            })
          );
        }
        return { content: `오류가 발생했어요: ${err.message}`, mode: "private", failed: true };
      }
    })();

    // 2초 안에 끝나면 평소처럼 바로 응답
    const wait = Math.max(0, DEFER_AFTER_MS - (Date.now() - t0));
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), wait));
    const quick = await Promise.race([work, timeout]);
    if (quick) return reply(quick.content, quick.mode);

    // 오래 걸리면 먼저 "처리 중…"으로 응답하고, 끝나면 결과로 바꿔요.
    // waitUntil: 응답을 보낸 뒤에도 서버리스 함수가 작업이 끝날 때까지 살아 있게 해요.
    waitUntil(
      work.then(async (result) => {
        try {
          await editOriginal(interaction, result.content, env, result.mode);
        } catch (err) {
          console.error("지연 응답 전송 실패:", err.message);
        }
      })
    );
    return deferReply(mode);
  }

  return new Response("지원하지 않는 요청입니다.", { status: 400 });
}