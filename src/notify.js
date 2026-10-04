import { getDoc, setDoc, listCollection } from "./firebase.js";

// ---------- 주식채널 가격 변동 공지 on/off (관리자 콘솔의 체크박스) ----------
// 유저별 DM 알림(/알림설정)과는 별개예요. 기본값은 켜짐입니다.
const ANNOUNCE_PATH = "config/announce";

// config/announce 문서: { enabled, messageIds, channelId }
// messageIds = 마지막으로 올린 공지 메시지 ID들(쉼표로 구분). 다음 변동 때 이 메시지들을 지우고 새로 올립니다.
async function readAnnounceDoc(env) {
  try {
    return (await getDoc(env, ANNOUNCE_PATH)) || {};
  } catch (err) {
    console.error("공지 설정 조회 실패:", err.message);
    return {};
  }
}

export async function getAnnounceConfig(env) {
  const saved = await readAnnounceDoc(env);
  return { enabled: saved.enabled ?? true };
}

export async function setAnnounceConfig(env, { enabled }) {
  const next = { enabled: Boolean(enabled) };
  await setDoc(env, ANNOUNCE_PATH, next);
  return next;
}

const DISCORD_API = "https://discord.com/api/v10";

async function discordRequest(env, method, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`Discord 요청 실패(${res.status}): ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const discordPost = (env, path, body) => discordRequest(env, "POST", path, body);

// 유저에게 DM 보내기 (DM 채널을 먼저 열고 메시지 전송)
async function sendDM(env, userId, content) {
  const channel = await discordPost(env, "/users/@me/channels", { recipient_id: userId });
  await discordPost(env, `/channels/${channel.id}/messages`, { content });
}

function formatLines(list) {
  return list
    .map((c) => {
      const pct = ((c.after - c.before) / c.before) * 100;
      const sign = pct > 0 ? "+" : "";
      return `• **${c.name}**: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 (${sign}${pct.toFixed(1)}%)`;
    })
    .join("\n");
}

// 한국시간 기준 현재 시(0~23)
function currentHourKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

// 한국시간 기준 "MM/DD HH:mm"
function formatNowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(5, 16)
    .replace("T", " ")
    .replace("-", "/");
}

// 알림 시간대 안인지 확인합니다.
// - start/end가 없거나 서로 같으면 하루 종일
// - start < end: start시 이상 end시 미만 (예: 9~22)
// - start > end: 자정을 넘기는 구간 (예: 22~6)
export function isWithinNotifyWindow(setting, hour = currentHourKST()) {
  const { start, end } = setting || {};
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// 공지용 한 줄: 🔺 상승 / 🔻 하락 / ➖ 변동 없음
function announceLine(c) {
  if (c.after === c.before) {
    return `➖ **${c.name}**: ${c.after.toLocaleString()}해정 (변동 없음)`;
  }
  const up = c.after > c.before;
  const pct = ((c.after - c.before) / c.before) * 100;
  return `${up ? "🔺" : "🔻"} **${c.name}**: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 (${up ? "+" : ""}${pct.toFixed(1)}%)`;
}

// 시세가 변동될 때마다 주식채널(ALLOWED_CHANNEL_ID)에 변동 내역을 공지합니다.
// 유저의 알림 설정과 상관없이 올라가요. (관리자 콘솔의 '가격 변동 알림' 체크를 끄면 올라가지 않음) 실패해도 시세 변동 자체는 막지 않습니다.
// 반환값: { sent: true, messages: 보낸 메시지 수 } 또는 { sent: false, reason: "이유" }
export async function announcePriceChanges(env, changes, label = "시세 변동") {
  if (!env.DISCORD_BOT_TOKEN) {
    return { sent: false, reason: "DISCORD_BOT_TOKEN 환경변수가 없어요" };
  }
  if (!env.ALLOWED_CHANNEL_ID) {
    return { sent: false, reason: "ALLOWED_CHANNEL_ID 환경변수가 없어요" };
  }
  if (changes.length === 0) {
    return { sent: false, reason: "변동 내역이 없어요" };
  }

  // 관리자 콘솔에서 체크를 끈 경우 공지를 보내지 않음
  const doc = await readAnnounceDoc(env);
  if (doc.enabled === false) {
    return { sent: false, reason: "가격 변동 공지가 꺼져 있어요" };
  }

  try {
    const header = `📊 **시세 변동** · ${label} · ${formatNowKST()}`;
    const chunks = [];
    let current = header;

    for (const c of changes) {
      const line = announceLine(c);
      // 디스코드 메시지 한도(2000자)를 넘지 않게 나눠서 보냄
      if (current.length + line.length + 1 > 1900) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n" : "") + line;
    }
    if (current) chunks.push(current);

    // 이전 공지는 지우고 새 메시지를 올림 (항상 채널 맨 아래에 최신 공지만 남음)
    const channel = env.ALLOWED_CHANNEL_ID;
    const oldIds = doc.channelId === channel ? String(doc.messageIds || "").split(",").filter(Boolean) : [];

    for (const id of oldIds) {
      try {
        await discordRequest(env, "DELETE", `/channels/${channel}/messages/${id}`);
      } catch (err) {
        console.error("이전 공지 삭제 실패:", err.message);
      }
    }

    const newIds = [];
    for (const content of chunks) {
      // flags 4096 = 무음 메시지(푸시 알림·소리 없음)
      const message = await discordPost(env, `/channels/${channel}/messages`, { content, flags: 4096 });
      newIds.push(message.id);
    }

    await setDoc(env, ANNOUNCE_PATH, { messageIds: newIds.join(","), channelId: channel });
    return { sent: true, messages: chunks.length, edited: 0 };
  } catch (err) {
    console.error("시세 변동 공지 실패:", err.message);
    return { sent: false, reason: err.message };
  }
}

// 시세 변동 목록을 받아 유저별 알림 설정에 맞춰 DM 전송
// changes: [{ name, before, after }]
export async function notifyPriceChanges(env, changes) {
  if (!env.DISCORD_BOT_TOKEN || changes.length === 0) return;

  const users = await listCollection(env, "users");
  const hour = currentHourKST();

  for (const user of users) {
    const setting = user.notify || {};
    if (!setting.all && !setting.up && !setting.down) continue;

    // 유저가 정한 알림 시간대 밖이면 건너뜀 (나중에 몰아서 보내지 않음)
    if (!isWithinNotifyWindow(setting, hour)) continue;

    const held = user.holdings || {};
    const buckets = { heldUp: [], heldDown: [], all: [] };

    for (const c of changes) {
      if (c.after === c.before) continue;
      const isUp = c.after > c.before;
      const isHeld = (held[c.name] || 0) > 0;

      // 한 변동당 하나의 알림만 배정 (중복 방지)
      if (isHeld && isUp && setting.up) buckets.heldUp.push(c);
      else if (isHeld && !isUp && setting.down) buckets.heldDown.push(c);
      else if (setting.all) buckets.all.push(c);
    }

    const messages = [];
    if (buckets.heldUp.length) {
      messages.push(
        `📈 **[보유 종목 상승]**\n내가 가진 종목 시세가 올랐어요!\n${formatLines(buckets.heldUp)}`
      );
    }
    if (buckets.heldDown.length) {
      messages.push(
        `📉 **[보유 종목 하락]**\n내가 가진 종목 시세가 떨어졌어요.\n${formatLines(buckets.heldDown)}`
      );
    }
    if (buckets.all.length) {
      messages.push(
        `🔔 **[시세 변동]**\n등록된 종목 시세가 바뀌었어요.\n${formatLines(buckets.all)}`
      );
    }

    for (const content of messages) {
      try {
        await sendDM(env, user.id, content);
      } catch (err) {
        // 특정 유저의 DM이 막혀 있어도 나머지 유저에게는 계속 보냅니다.
        console.error(`알림 전송 실패 (${user.id}):`, err.message);
      }
    }
  }
}