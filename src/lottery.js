// 해정 복권: 5/25 번호 추첨, 매주 토요일 20:45(KST) 추첨
//  - 티켓값의 50%가 당첨금 재원 (현실처럼 구매 수수료는 따로 없어요)
//  - 세금은 현실처럼 "당첨금이 기준선을 넘을 때만" 떼요 (taxOf 참고)
import { getUser, updateUserLocked, addHistory, sendDM, discordPost, getDoc, setDoc, getDocMeta, setDocIfUnchanged } from "./lib.js";

export const TICKET_PRICE = 100;
export const PICK = 5;
export const NUM_MAX = 25;
export const MAX_TICKETS = 20; // 1인 1회차 최대 장수
export const PAYOUT_RATE = 0.5; // 판매액의 50%가 당첨금
const FIXED = { 4: 5 * TICKET_PRICE, 5: 1 * TICKET_PRICE }; // 4·5등 고정금
const SHARE = { 1: 0.75, 2: 0.125, 3: 0.125 }; // 남은 재원 배분
const TAX_FREE_BELOW = 2000 * TICKET_PRICE; // 현실 200만 원 ↔ 티켓 1000원 = 2000배
const TAX_HIGH_ABOVE = 300000 * TICKET_PRICE; // 현실 3억 원 = 30만 배
const TAX_RATE = 0.22; // 소득세 20% + 지방세 2%
const TAX_RATE_HIGH = 0.33; // 3억 초과분 33%
const CLOSE_BEFORE_MS = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const KST = 9 * 60 * 60 * 1000;
const PATH = "config/lottery";
const num = (x) => Number(x).toLocaleString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 현실 규칙: 비과세 선 이하는 0, 넘으면 (당첨금 − 구입비)의 22%, 고액 초과분은 33%
export function taxOf(prize) {
  if (prize <= TAX_FREE_BELOW) return 0;
  const base = prize - TICKET_PRICE;
  if (prize <= TAX_HIGH_ABOVE) return Math.ceil(base * TAX_RATE);
  return Math.ceil((TAX_HIGH_ABOVE - TICKET_PRICE) * TAX_RATE + (prize - TAX_HIGH_ABOVE) * TAX_RATE_HIGH);
}

// 지금 이후 가장 가까운 토요일 20:45 (KST)
function nextDrawAt(now) {
  const dayStart = Math.floor((now + KST) / DAY) * DAY;
  const dow = new Date(dayStart).getUTCDay();
  let t = dayStart + ((6 - dow + 7) % 7) * DAY + (20 * 60 + 45) * 60000 - KST;
  if (t <= now) t += 7 * DAY;
  return t;
}

async function mutate(env, fn, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let meta = await getDocMeta(env, PATH);
    if (!meta) {
      await setDoc(env, PATH, { round: 1, drawAt: nextDrawAt(Date.now()), sales: 0, rollover: 0, tickets: {}, last: "" });
      meta = await getDocMeta(env, PATH);
    }
    const s = meta.data;
    if (!s.tickets) s.tickets = {};
    const out = fn(s);
    if (!out.save) return out.result;
    if (await setDocIfUnchanged(env, PATH, { round: s.round, drawAt: s.drawAt, sales: s.sales, rollover: s.rollover || 0, tickets: s.tickets, last: s.last || "" }, meta.updateTime)) return out.result;
    await sleep(40 + Math.random() * 80);
  }
  throw new Error("지금 요청이 몰려서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
}

const randomPick = () => {
  const pool = Array.from({ length: NUM_MAX }, (_, i) => i + 1);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, PICK).sort((a, b) => a - b);
};

function parsePick(text) {
  const nums = [...new Set(String(text).split(/[\s,]+/).filter(Boolean).map(Number))];
  if (nums.length !== PICK || nums.some((n) => !Number.isInteger(n) || n < 1 || n > NUM_MAX)) return null;
  return nums.sort((a, b) => a - b);
}

// ---------- 구매 ----------
export async function buyTickets(env, userId, { qty = 1, numbers }) {
  if (!Number.isSafeInteger(qty) || qty < 1) return "수량은 1 이상의 정수여야 해요.";
  let manual = null;
  if (numbers) {
    manual = parsePick(numbers);
    if (!manual) return `번호는 1~${NUM_MAX} 중 서로 다른 ${PICK}개를 띄어쓰기로 적어 주세요. (예: 3 8 12 19 25)`;
  }
  const state = (await getDoc(env, PATH)) || { drawAt: nextDrawAt(Date.now()), tickets: {} };
  if (Date.now() >= state.drawAt - CLOSE_BEFORE_MS) return "이번 회차 판매가 마감됐어요. 추첨 뒤 다음 회차부터 살 수 있어요.";
  const mine = Object.keys(state.tickets || {}).filter((k) => k.startsWith(`${userId}_`)).length;
  if (mine + qty > MAX_TICKETS) return `한 회차에 ${MAX_TICKETS}장까지 살 수 있어요. (지금 ${mine}장)`;

  const cost = TICKET_PRICE * qty;
  const paid = await updateUserLocked(env, userId, (u) => {
    if (u.balance < cost) return { save: false, result: { ok: false, message: `잔고가 부족해요. (필요: ${num(cost)}해정, 보유: ${num(u.balance)}해정)` } };
    const before = u.balance;
    u.balance -= cost;
    return { save: true, result: { ok: true, before, after: u.balance } };
  });
  if (!paid.ok) return paid.message;

  const picks = Array.from({ length: qty }, (_, i) => (i === 0 && manual ? manual : randomPick()));
  let round;
  try {
    round = await mutate(env, (s) => {
      if (Date.now() >= s.drawAt - CLOSE_BEFORE_MS) return { save: false, result: null };
      const have = Object.keys(s.tickets).filter((k) => k.startsWith(`${userId}_`)).length;
      if (have + qty > MAX_TICKETS) return { save: false, result: null };
      picks.forEach((p, i) => (s.tickets[`${userId}_${have + i + 1}`] = p.join(",")));
      s.sales += cost;
      return { save: true, result: s.round };
    });
  } catch {
    round = null;
  }
  if (!round) {
    await updateUserLocked(env, userId, (u) => { u.balance += cost; return { save: true, result: true }; }); // 환불
    return "그 사이 판매가 마감됐거나 한도를 넘어서 취소하고 돌려드렸어요.";
  }
  await addHistory(env, userId, `복권 구매: ${round}회차 ${qty}장 (-${num(cost)}해정)`);
  return [
    `🎟️ **${round}회차 복권 ${qty}장**을 샀어요! (-${num(cost)}해정)`,
    ...picks.slice(0, 10).map((p, i) => `• ${i + 1}번: ${p.join(" · ")}${i === 0 && manual ? " (직접 선택)" : " (자동)"}`),
    ...(picks.length > 10 ? [`…외 ${picks.length - 10}장`] : []),
    `💰 잔고: ${num(paid.before)} → **${num(paid.after)}해정**`,
    `⏰ 추첨 <t:${Math.floor(state.drawAt / 1000)}:f> (<t:${Math.floor(state.drawAt / 1000)}:R>)`,
  ].join("\n");
}

// ---------- 현황 ----------
export async function lotteryInfo(env, userId) {
  const s = (await getDoc(env, PATH)) || { round: 1, drawAt: nextDrawAt(Date.now()), sales: 0, rollover: 0, tickets: {}, last: "" };
  const mine = Object.entries(s.tickets || {}).filter(([k]) => k.startsWith(`${userId}_`)).map(([, v]) => v.split(",").join(" · "));
  const pool = Math.floor(s.sales * PAYOUT_RATE) + (s.rollover || 0);
  return [
    `🎟️ **해정 복권 ${s.round}회차**`,
    `• 규칙: 1~${NUM_MAX} 중 ${PICK}개 · 장당 ${num(TICKET_PRICE)}해정 · 1인 최대 ${MAX_TICKETS}장`,
    `• 지금 당첨금 재원: **${num(pool)}해정** (판매액의 ${PAYOUT_RATE * 100}% + 이월 ${num(s.rollover || 0)})`,
    `• 4등(3개) ${num(FIXED[4])}해정, 5등(2개) ${num(FIXED[5])}해정 고정 · 1~3등은 재원을 나눠요`,
    `• 세금: ${num(TAX_FREE_BELOW)}해정 이하 비과세, 초과하면 (당첨금−구입비)의 22%, 고액 초과분 33%`,
    `• 추첨: <t:${Math.floor(s.drawAt / 1000)}:f> (<t:${Math.floor(s.drawAt / 1000)}:R>)`,
    "",
    mine.length ? `**내 티켓 (${mine.length}장)**\n${mine.slice(0, 15).map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "아직 산 티켓이 없어요. `/복권구매`로 사 보세요!",
    ...(s.last ? ["", `**지난 회차**: ${s.last}`] : []),
  ].join("\n").slice(0, 1900);
}

// ---------- 추첨 (크론) ----------
function rankOf(pick, win, bonus) {
  const hit = pick.filter((n) => win.includes(n)).length;
  if (hit === 5) return 1;
  if (hit === 4) return pick.includes(bonus) ? 2 : 3;
  if (hit === 3) return 4;
  if (hit === 2) return 5;
  return 0;
}

export async function runLottery(env) {
  const now = Date.now();
  const doc = await getDoc(env, PATH);
  if (!doc) {
    await setDoc(env, PATH, { round: 1, drawAt: nextDrawAt(now), sales: 0, rollover: 0, tickets: {}, last: "" });
    return { ran: false, reason: "첫 실행이라 회차를 만들어 뒀어요" };
  }
  if (now < doc.drawAt) return { ran: false, reason: "아직 추첨 시각이 아니에요" };

  // 먼저 가져오면서 다음 회차로 넘겨요 (두 번 추첨 방지)
  const cur = await mutate(env, (s) => {
    if (Date.now() < s.drawAt) return { save: false, result: null };
    const snap = { round: s.round, sales: s.sales, rollover: s.rollover || 0, tickets: s.tickets };
    s.round += 1;
    s.drawAt = nextDrawAt(Date.now());
    s.sales = 0;
    s.tickets = {};
    return { save: true, result: snap };
  });
  if (!cur) return { ran: false, reason: "이미 추첨했어요" };

  const nums = randomPick();
  const pool0 = [...Array(NUM_MAX)].map((_, i) => i + 1).filter((n) => !nums.includes(n));
  const bonus = pool0[Math.floor(Math.random() * pool0.length)];

  const winners = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const [key, val] of Object.entries(cur.tickets)) {
    const r = rankOf(val.split(",").map(Number), nums, bonus);
    if (r) winners[r].push(key.split("_")[0]);
  }

  const total = Math.floor(cur.sales * PAYOUT_RATE) + cur.rollover;
  const fixedPaid = winners[4].length * FIXED[4] + winners[5].length * FIXED[5];
  const rest = Math.max(0, total - fixedPaid);
  let carry = 0;
  const prize = { 4: FIXED[4], 5: FIXED[5] };
  for (const r of [1, 2, 3]) {
    const part = Math.floor(rest * SHARE[r]);
    if (winners[r].length) prize[r] = Math.floor(part / winners[r].length);
    else carry += part;
  }
  carry += rest - Math.floor(rest * 0.75) - 2 * Math.floor(rest * 0.125); // 나머지 잔돈도 이월
  if (carry > 0) await mutate(env, (s) => { s.rollover = (s.rollover || 0) + carry; return { save: true, result: true }; }).catch((e) => console.error("이월 실패:", e.message));

  // 지급 (유저별로 합산, 장 단위로 세금 계산)
  const perUser = {};
  for (const r of [1, 2, 3, 4, 5]) {
    for (const uid of winners[r]) {
      const p = prize[r];
      const tax = taxOf(p);
      const o = (perUser[uid] ||= { gross: 0, tax: 0, lines: [] });
      o.gross += p;
      o.tax += tax;
      o.lines.push(`${r}등 ${num(p)}해정${tax ? ` (세금 ${num(tax)})` : ""}`);
    }
  }
  for (const [uid, o] of Object.entries(perUser)) {
    const net = o.gross - o.tax;
    try {
      await retryPay(env, uid, net);
      await addHistory(env, uid, `복권 당첨: ${cur.round}회차 +${num(net)}해정 (세전 ${num(o.gross)}, 세금 ${num(o.tax)})`);
      await sendDM(env, uid, `🎉 **복권 ${cur.round}회차 당첨!**\n${o.lines.join("\n")}\n세전 ${num(o.gross)}해정 − 세금 ${num(o.tax)}해정 = **+${num(net)}해정**`).catch(() => {});
    } catch (err) {
      console.error(`복권 지급 실패 (${uid}):`, err.message);
    }
  }

  const summary = `${cur.round}회차 · ${nums.join(" ")} + 보너스 ${bonus} · 1등 ${winners[1].length}명 / 2등 ${winners[2].length} / 3등 ${winners[3].length} / 4등 ${winners[4].length} / 5등 ${winners[5].length}`;
  await mutate(env, (s) => { s.last = summary; return { save: true, result: true }; }).catch(() => {});
  if (env.ALLOWED_CHANNEL_ID) {
    await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
      content: [
        `🎟️ **복권 ${cur.round}회차 추첨 결과**`,
        `당첨 번호: **${nums.join(" · ")}** + 보너스 **${bonus}**`,
        `1등 ${winners[1].length}명${winners[1].length ? ` (1인 ${num(prize[1])}해정)` : ""} · 2등 ${winners[2].length}명 · 3등 ${winners[3].length}명 · 4등 ${winners[4].length}명 · 5등 ${winners[5].length}명`,
        carry > 0 ? `💰 당첨자 없는 몫 ${num(carry)}해정은 다음 회차로 이월돼요!` : "",
      ].filter(Boolean).join("\n"),
      flags: 4096,
      allowed_mentions: { parse: [] },
    }).catch((e) => console.error("복권 공지 실패:", e.message));
  }
  return { ran: true, round: cur.round, nums, bonus, winners: Object.fromEntries(Object.entries(winners).map(([k, v]) => [k, v.length])) };
}

async function retryPay(env, uid, net) {
  for (let i = 0; i < 3; i++) {
    try {
      return await updateUserLocked(env, uid, (u) => { u.balance += net; return { save: true, result: true }; });
    } catch (e) {
      if (i === 2) throw e;
      await sleep(300 * (i + 1));
    }
  }
}

// ---------- 명령어 ----------
export const lotteryCommandDefinitions = [
  {
    name: "복권구매",
    description: `복권을 삽니다. 장당 ${TICKET_PRICE}해정, 매주 토요일 20:45 추첨 (자동 번호가 기본)`,
    options: [
      { name: "수량", description: `살 장수 (기본 1, 최대 ${MAX_TICKETS})`, type: 4, required: false, min_value: 1, max_value: MAX_TICKETS },
      { name: "번호", description: `직접 고를 번호 ${PICK}개 (예: 3 8 12 19 25, 첫 장에만 적용)`, type: 3, required: false, max_length: 30 },
    ],
  },
  { name: "복권현황", description: "이번 회차 당첨금 재원, 추첨 시각, 내 티켓과 지난 결과를 봅니다." },
];
export const LOTTERY_VIEW_ONLY = new Set(["복권현황"]);
const opt = (i, name) => i.data.options?.find((o) => o.name === name)?.value;
export const lotteryHandlers = {
  복권구매: (i, env) => buyTickets(env, i.member.user.id, { qty: opt(i, "수량") ?? 1, numbers: opt(i, "번호") }),
  복권현황: (i, env) => lotteryInfo(env, i.member.user.id),
};
