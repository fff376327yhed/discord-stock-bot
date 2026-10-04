import { listCollection } from "./firebase.js";

const DISCORD_API = "https://discord.com/api/v10";

async function discordPost(env, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord 전송 실패(${res.status}): ${await res.text()}`);
  return res.json();
}

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

// 시세 변동 목록을 받아 유저별 알림 설정에 맞춰 DM 전송
// changes: [{ name, before, after }]
export async function notifyPriceChanges(env, changes) {
  if (!env.DISCORD_BOT_TOKEN || changes.length === 0) return;

  const users = await listCollection(env, "users");

  for (const user of users) {
    const setting = user.notify || {};
    if (!setting.all && !setting.up && !setting.down) continue;

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