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
export function taxOf(prize, cost = TICKET_PRICE) {
  if (prize <= TAX_FREE_BELOW) return 0;
  if (prize <= TAX_HIGH_ABOVE) return Math.ceil((prize - cost) * TAX_RATE);
  return Math.ceil((TAX_HIGH_ABOVE - cost) * TAX_RATE + (prize - TAX_HIGH_ABOVE) * TAX_RATE_HIGH);
}

// 지금 이후 가장 가까운 (요일, 시:분) KST. weekday: 0=일 … 6=토
function nextWeekly(now, weekday, hour, minute) {
  const dayStart = Math.floor((now + KST) / DAY) * DAY;
  const dow = new Date(dayStart).getUTCDay();
  let t = dayStart + ((weekday - dow + 7) % 7) * DAY + (hour * 60 + minute) * 60000 - KST;
  if (t <= now) t += 7 * DAY;
  return t;
}
const nextDrawAt = (now) => nextWeekly(now, 6, 20, 45); // 로또형: 토요일 20:45
const nextPensionAt = (now) => nextWeekly(now, 4, 19, 5); // 연금복권: 목요일 19:05

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

async function runLotto(env) {
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

// 크론이 부르는 진입점: 로또형 추첨과 연금복권 추첨을 둘 다 확인해요.
export async function runLottery(env) {
  const lotto = await runLotto(env).catch((e) => { console.error("복권 추첨 실패:", e.message); return { ran: false, error: e.message }; });
  const pension = await runPension(env).catch((e) => { console.error("연금복권 추첨 실패:", e.message); return { ran: false, error: e.message }; });
  return { ...lotto, pension };
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

// ---------- 즉석복권 (사면 바로 결과) ----------
// 현실 스크래치 복권처럼 구매 수수료는 없고, 당첨금 세금은 taxOf 규칙을 그대로 써요.
// 종류마다 기대 환수율이 약 60%예요. (배수 × 확률의 합. 현실 즉석복권도 60% 안팎)
export const MAX_SCRATCH = 20; // 한 번에 살 수 있는 장수
const BIG_PRIZE = 100 * TICKET_PRICE; // 이 이상 당첨되면 채널에 한 줄 공지
const SCRATCH_KINDS = {
  // tiers: [등수, 티켓값의 몇 배, 확률]
  mini: { label: "미니", price: 10, tiers: [[1, 1000, 1 / 10000], [2, 100, 1 / 1000], [3, 20, 1 / 200], [4, 5, 0.02], [5, 2, 0.05], [6, 1, 0.1]] },
  normal: { label: "일반", price: TICKET_PRICE, tiers: [[1, 3000, 1 / 20000], [2, 300, 3 / 10000], [3, 50, 1 / 1000], [4, 10, 1 / 100], [5, 3, 0.035], [6, 1, 0.1]] },
  gold: { label: "골드", price: 10 * TICKET_PRICE, tiers: [[1, 500, 1 / 5000], [2, 100, 1 / 1000], [3, 30, 1 / 300], [4, 10, 1 / 100], [5, 3, 1 / 30], [6, 1, 0.1]] },
};

function scratchOnce(kind) {
  let r = Math.random();
  for (const [rank, mult, p] of kind.tiers) {
    if (r < p) return { rank, prize: mult * kind.price };
    r -= p;
  }
  return { rank: 0, prize: 0 };
}

export async function buyScratch(env, userId, qty = 1, kindKey = "normal") {
  const kind = SCRATCH_KINDS[kindKey];
  if (!kind) return "없는 복권 종류예요.";
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_SCRATCH) return `수량은 1~${MAX_SCRATCH} 사이로 적어 주세요.`;
  const cost = kind.price * qty;
  const results = Array.from({ length: qty }, () => {
    const t = scratchOnce(kind);
    return { ...t, tax: taxOf(t.prize, kind.price) };
  });
  const gross = results.reduce((a, r) => a + r.prize, 0);
  const tax = results.reduce((a, r) => a + r.tax, 0);
  const net = gross - tax;

  const paid = await updateUserLocked(env, userId, (u) => {
    if (u.balance < cost) return { save: false, result: { ok: false, message: `잔고가 부족해요. (필요: ${num(cost)}해정, 보유: ${num(u.balance)}해정)` } };
    const before = u.balance;
    u.balance += net - cost;
    return { save: true, result: { ok: true, before, after: u.balance } };
  });
  if (!paid.ok) return paid.message;

  const profit = net - cost;
  await addHistory(env, userId, `즉석복권(${kind.label}): ${qty}장 (${profit >= 0 ? "+" : ""}${num(profit)}해정)`).catch(() => {});

  const wins = results.filter((r) => r.rank);
  const big = wins.filter((r) => r.prize >= BIG_PRIZE);
  if (big.length && env.ALLOWED_CHANNEL_ID) {
    await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
      content: `🎰 <@${userId}>님이 ${kind.label} 즉석복권 ${big.map((r) => `${r.rank}등(${num(r.prize)}해정)`).join(", ")}에 당첨됐어요!`,
      flags: 4096,
      allowed_mentions: { parse: [] },
    }).catch((e) => console.error("즉석복권 공지 실패:", e.message));
  }

  const line = (r, i) => (r.rank ? `• ${i + 1}번: 🎉 ${r.rank}등 ${num(r.prize)}해정${r.tax ? ` (세금 ${num(r.tax)})` : ""}` : `• ${i + 1}번: ❌ 꽝`);
  const shown = qty <= 5 ? results.map(line) : [...results.map((r, i) => (r.rank ? line(r, i) : null)).filter(Boolean).slice(0, 10), `❌ 꽝 ${qty - wins.length}장`];
  return [
    `🎰 **${kind.label} 즉석복권 ${qty}장** (-${num(cost)}해정)`,
    ...shown,
    `당첨금 ${num(gross)}${tax ? ` − 세금 ${num(tax)}` : ""} = ${num(net)}해정 · 손익 **${profit >= 0 ? "+" : ""}${num(profit)}해정**`,
    `💰 잔고: ${num(paid.before)} → **${num(paid.after)}해정**`,
  ].join("\n");
}

// ---------- 연금복권 (조 + 3자리 번호, 매주 목요일 19:05 추첨) ----------
// 현실 연금복권처럼 1·2등은 한 번에 주지 않고 매주 나눠서 줘요. 3·4등은 한 번에 지급해요.
//  1등: 조·번호 모두 일치 → 매주 1,000해정 × 52주
//  2등: 번호 3자리 일치(조는 다름) → 매주 300해정 × 26주
//  3등: 끝 2자리 일치 → 2,000해정 / 4등: 끝 1자리 일치 → 100해정
// 지급액이 정해진 표라서 재원 없이 봇이 지급해요. (기대 환수율 약 50%)
// 세금은 한 번 받을 때마다 taxOf로 계산해요. (지금 금액은 모두 비과세 선 아래예요)
export const PENSION_GROUPS = 3;
export const PENSION_MAX = 10; // 1인 1회차 최대 장수
const PENSION_PATH = "config/pension";
const PENSION_PRIZE = {
  1: { amount: 10 * TICKET_PRICE, weeks: 52 },
  2: { amount: 3 * TICKET_PRICE, weeks: 26 },
  3: { amount: 20 * TICKET_PRICE },
  4: { amount: TICKET_PRICE },
};
const pensionInit = (now) => ({ round: 1, drawAt: nextPensionAt(now), tickets: {}, annuities: {}, last: "" });

async function pensionMutate(env, fn, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let meta = await getDocMeta(env, PENSION_PATH);
    if (!meta) {
      await setDoc(env, PENSION_PATH, pensionInit(Date.now()));
      meta = await getDocMeta(env, PENSION_PATH);
    }
    const s = meta.data;
    if (!s.tickets) s.tickets = {};
    if (!s.annuities) s.annuities = {};
    const out = fn(s);
    if (!out.save) return out.result;
    if (await setDocIfUnchanged(env, PENSION_PATH, { round: s.round, drawAt: s.drawAt, tickets: s.tickets, annuities: s.annuities, last: s.last || "" }, meta.updateTime)) return out.result;
    await sleep(40 + Math.random() * 80);
  }
  throw new Error("지금 요청이 몰려서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
}

const pensionLabel = (t) => {
  const [g, d] = t.split("-");
  return `${g}조 ${d}`;
};
const randomPensionTicket = () => `${1 + Math.floor(Math.random() * PENSION_GROUPS)}-${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
function parsePension(text) {
  const m = String(text).match(/^\s*([1-9])\s*조?[\s,-]*(\d{3})\s*$/);
  if (!m || Number(m[1]) > PENSION_GROUPS) return null;
  return `${m[1]}-${m[2]}`;
}
function pensionRank(ticket, win) {
  const [g, d] = ticket.split("-");
  const [wg, wd] = win.split("-");
  if (d === wd) return g === wg ? 1 : 2;
  if (d.slice(1) === wd.slice(1)) return 3;
  if (d[2] === wd[2]) return 4;
  return 0;
}

export async function buyPension(env, userId, { qty = 1, numbers }) {
  if (!Number.isSafeInteger(qty) || qty < 1) return "수량은 1 이상의 정수여야 해요.";
  let manual = null;
  if (numbers) {
    manual = parsePension(numbers);
    if (!manual) return `번호는 1~${PENSION_GROUPS}조와 3자리 숫자로 적어 주세요. (예: 2 345)`;
  }
  const state = (await getDoc(env, PENSION_PATH)) || pensionInit(Date.now());
  if (Date.now() >= state.drawAt - CLOSE_BEFORE_MS) return "이번 회차 판매가 마감됐어요. 추첨 뒤 다음 회차부터 살 수 있어요.";
  const mine = Object.keys(state.tickets || {}).filter((k) => k.startsWith(`${userId}_`)).length;
  if (mine + qty > PENSION_MAX) return `한 회차에 ${PENSION_MAX}장까지 살 수 있어요. (지금 ${mine}장)`;

  const cost = TICKET_PRICE * qty;
  const paid = await updateUserLocked(env, userId, (u) => {
    if (u.balance < cost) return { save: false, result: { ok: false, message: `잔고가 부족해요. (필요: ${num(cost)}해정, 보유: ${num(u.balance)}해정)` } };
    const before = u.balance;
    u.balance -= cost;
    return { save: true, result: { ok: true, before, after: u.balance } };
  });
  if (!paid.ok) return paid.message;

  const picks = Array.from({ length: qty }, (_, i) => (i === 0 && manual ? manual : randomPensionTicket()));
  let round;
  try {
    round = await pensionMutate(env, (s) => {
      if (Date.now() >= s.drawAt - CLOSE_BEFORE_MS) return { save: false, result: null };
      const have = Object.keys(s.tickets).filter((k) => k.startsWith(`${userId}_`)).length;
      if (have + qty > PENSION_MAX) return { save: false, result: null };
      picks.forEach((p, i) => (s.tickets[`${userId}_${have + i + 1}`] = p));
      return { save: true, result: s.round };
    });
  } catch {
    round = null;
  }
  if (!round) {
    await updateUserLocked(env, userId, (u) => { u.balance += cost; return { save: true, result: true }; }); // 환불
    return "그 사이 판매가 마감됐거나 한도를 넘어서 취소하고 돌려드렸어요.";
  }
  await addHistory(env, userId, `연금복권 구매: ${round}회차 ${qty}장 (-${num(cost)}해정)`);
  return [
    `🎫 **연금복권 ${round}회차 ${qty}장**을 샀어요! (-${num(cost)}해정)`,
    ...picks.slice(0, 10).map((p, i) => `• ${i + 1}번: ${pensionLabel(p)}${i === 0 && manual ? " (직접 선택)" : " (자동)"}`),
    `💰 잔고: ${num(paid.before)} → **${num(paid.after)}해정**`,
    `⏰ 추첨 <t:${Math.floor(state.drawAt / 1000)}:f> (<t:${Math.floor(state.drawAt / 1000)}:R>)`,
  ].join("\n");
}

export async function pensionInfo(env, userId) {
  const s = (await getDoc(env, PENSION_PATH)) || pensionInit(Date.now());
  const mine = Object.entries(s.tickets || {}).filter(([k]) => k.startsWith(`${userId}_`)).map(([, v]) => pensionLabel(v));
  const myAnn = Object.values(s.annuities || {}).filter((a) => a.uid === userId);
  const P = PENSION_PRIZE;
  return [
    `🎫 **해정 연금복권 ${s.round}회차**`,
    `• 규칙: 1~${PENSION_GROUPS}조 + 3자리 숫자 · 장당 ${num(TICKET_PRICE)}해정 · 1인 최대 ${PENSION_MAX}장`,
    `• 1등(조·번호 일치): 매주 ${num(P[1].amount)}해정 × ${P[1].weeks}주`,
    `• 2등(번호 일치): 매주 ${num(P[2].amount)}해정 × ${P[2].weeks}주`,
    `• 3등(끝 2자리) ${num(P[3].amount)}해정 · 4등(끝 1자리) ${num(P[4].amount)}해정 (한 번에 지급)`,
    `• 추첨: <t:${Math.floor(s.drawAt / 1000)}:f> (<t:${Math.floor(s.drawAt / 1000)}:R>)`,
    "",
    mine.length ? `**내 티켓 (${mine.length}장)**\n${mine.slice(0, 10).map((t, i) => `${i + 1}. ${t}`).join("\n")}` : "아직 산 티켓이 없어요. `/연금복권`으로 사 보세요!",
    ...(myAnn.length ? ["", "**받고 있는 연금**", ...myAnn.slice(0, 10).map((a) => `• ${a.rank}등 (${a.round}회차) 매주 ${num(a.amount)}해정 · ${a.total - a.left}/${a.total}회 받음`)] : []),
    ...(s.last ? ["", `**지난 회차**: ${s.last}`] : []),
  ].join("\n").slice(0, 1900);
}

async function runPension(env) {
  const now = Date.now();
  const doc = await getDoc(env, PENSION_PATH);
  if (!doc) {
    await setDoc(env, PENSION_PATH, pensionInit(now));
    return { ran: false, reason: "첫 실행이라 회차를 만들어 뒀어요" };
  }
  if (now < doc.drawAt) return { ran: false, reason: "아직 추첨 시각이 아니에요" };

  // 먼저 가져오면서 다음 회차로 넘겨요 (두 번 추첨 방지)
  const cur = await pensionMutate(env, (s) => {
    if (Date.now() < s.drawAt) return { save: false, result: null };
    const snap = { round: s.round, tickets: s.tickets };
    s.round += 1;
    s.drawAt = nextPensionAt(Date.now());
    s.tickets = {};
    return { save: true, result: snap };
  });
  if (!cur) return { ran: false, reason: "이미 추첨했어요" };

  const win = randomPensionTicket();
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const fresh = {};
  const lumps = [];
  for (const [key, val] of Object.entries(cur.tickets)) {
    const r = pensionRank(val, win);
    if (!r) continue;
    counts[r] += 1;
    const uid = key.split("_")[0];
    const p = PENSION_PRIZE[r];
    if (p.weeks) fresh[`${cur.round}_${key}`] = { uid, rank: r, amount: p.amount, total: p.weeks, left: p.weeks, round: cur.round };
    else lumps.push({ uid, rank: r, amount: p.amount, round: cur.round, total: 0, n: 0 });
  }
  const summary = `${cur.round}회차 · ${pensionLabel(win)} · 1등 ${counts[1]}명 / 2등 ${counts[2]} / 3등 ${counts[3]} / 4등 ${counts[4]}`;

  // 이번 주에 줄 연금 (새 당첨분 + 받고 있던 연금). 먼저 남은 횟수를 깎아 두 번 지급되는 걸 막아요.
  const installments = await pensionMutate(env, (s) => {
    Object.assign(s.annuities, fresh);
    const out = [];
    for (const [id, a] of Object.entries(s.annuities)) {
      a.left -= 1;
      out.push({ uid: a.uid, rank: a.rank, amount: a.amount, round: a.round, total: a.total, n: a.total - a.left });
      if (a.left <= 0) delete s.annuities[id];
    }
    s.last = summary;
    return { save: true, result: out };
  });

  const perUser = {};
  for (const it of [...lumps, ...installments]) {
    const tax = taxOf(it.amount);
    const o = (perUser[it.uid] ||= { gross: 0, tax: 0, lines: [] });
    o.gross += it.amount;
    o.tax += tax;
    o.lines.push(it.total ? `${it.rank}등 연금 ${it.n}/${it.total}회 ${num(it.amount)}해정${tax ? ` (세금 ${num(tax)})` : ""}` : `${it.rank}등 ${num(it.amount)}해정${tax ? ` (세금 ${num(tax)})` : ""}`);
  }
  for (const [uid, o] of Object.entries(perUser)) {
    const net = o.gross - o.tax;
    try {
      await retryPay(env, uid, net);
      await addHistory(env, uid, `연금복권: ${cur.round}회차 추첨 주간 +${num(net)}해정 (세전 ${num(o.gross)}, 세금 ${num(o.tax)})`);
      await sendDM(env, uid, `🎫 **연금복권 지급**\n${o.lines.join("\n")}\n세전 ${num(o.gross)}해정 − 세금 ${num(o.tax)}해정 = **+${num(net)}해정**`).catch(() => {});
    } catch (err) {
      console.error(`연금복권 지급 실패 (${uid}):`, err.message);
    }
  }

  if (env.ALLOWED_CHANNEL_ID) {
    await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
      content: [
        `🎫 **연금복권 ${cur.round}회차 추첨 결과**`,
        `당첨 번호: **${pensionLabel(win)}**`,
        `1등 ${counts[1]}명 · 2등 ${counts[2]}명 · 3등 ${counts[3]}명 · 4등 ${counts[4]}명`,
      ].join("\n"),
      flags: 4096,
      allowed_mentions: { parse: [] },
    }).catch((e) => console.error("연금복권 공지 실패:", e.message));
  }
  return { ran: true, round: cur.round, win, counts, paid: Object.keys(perUser).length };
}

// ---------- 파산신청 막기용: 걸려 있는 복권·받고 있는 연금이 있는지 ----------
// (복권 티켓과 앞으로 받을 연금은 순자산에 안 잡혀서, 빚만 지우고 나중에 당첨금을 챙기는 꼼수를 막아요)
export async function lotteryStake(env, userId) {
  const [lotto, pen] = await Promise.all([getDoc(env, PATH), getDoc(env, PENSION_PATH)]);
  const count = (m) => Object.keys(m || {}).filter((k) => k.startsWith(`${userId}_`)).length;
  const out = [];
  if (count(lotto?.tickets)) out.push(`이번 회차 복권 ${count(lotto.tickets)}장`);
  if (count(pen?.tickets)) out.push(`이번 회차 연금복권 ${count(pen.tickets)}장`);
  const ann = Object.values(pen?.annuities || {}).filter((a) => a.uid === userId);
  if (ann.length) out.push(`받고 있는 연금복권 ${ann.length}건`);
  return out.length ? out : null;
}

// ---------- 명령어 ----------
export const lotteryCommandDefinitions = [
  {
    name: "복권구매",
    description: `복권을 삽니다. 장당 ${TICKET_PRICE}해정, 매주 토요일 20:45 추첨 (자동 번호가 기본)`,
    options: [
      { name: "수량", description: `살 장수 (기본 1, 최대 ${MAX_TICKETS} · 칸을 누르면 살 수 있는 장수가 떠요)`, type: 4, required: false, autocomplete: true, min_value: 1, max_value: MAX_TICKETS },
      { name: "번호", description: `직접 고를 번호 ${PICK}개 (예: 3 8 12 19 25, 첫 장에만 적용)`, type: 3, required: false, max_length: 30 },
    ],
  },
  {
    name: "즉석복권",
    description: `즉석복권을 삽니다. 사면 바로 결과가 나와요. (미니 10 / 일반 ${TICKET_PRICE} / 골드 ${10 * TICKET_PRICE}해정)`,
    options: [
      {
        name: "종류",
        description: "복권 종류 (기본: 일반)",
        type: 3,
        required: false,
        choices: Object.entries(SCRATCH_KINDS).map(([value, k]) => ({ name: `${k.label} (${num(k.price)}해정 · 1등 ${num(k.tiers[0][1] * k.price)}해정)`, value })),
      },
      { name: "수량", description: `살 장수 (기본 1, 최대 ${MAX_SCRATCH} · 칸을 누르면 살 수 있는 장수가 떠요)`, type: 4, required: false, autocomplete: true, min_value: 1, max_value: MAX_SCRATCH },
    ],
  },
  {
    name: "연금복권",
    description: `연금복권을 삽니다. 장당 ${TICKET_PRICE}해정, 1·2등은 매주 나눠 받아요. 매주 목요일 19:05 추첨`,
    options: [
      { name: "수량", description: `살 장수 (기본 1, 최대 ${PENSION_MAX} · 칸을 누르면 살 수 있는 장수가 떠요)`, type: 4, required: false, autocomplete: true, min_value: 1, max_value: PENSION_MAX },
      { name: "번호", description: `직접 고를 조와 3자리 (예: 2 345, 첫 장에만 적용)`, type: 3, required: false, max_length: 10 },
    ],
  },
  { name: "연금복권현황", description: "이번 회차 연금복권 정보와 내 티켓, 받고 있는 연금을 봅니다." },
  { name: "복권현황", description: "이번 회차 당첨금 재원, 추첨 시각, 내 티켓과 지난 결과를 봅니다." },
];
// ---------- 자동완성: 수량 칸에 "지금 살 수 있는 장수"와 구매 후 잔고를 보여줘요 ----------
// (내 담당이 아니면 null을 돌려줘서 다음 자동완성이 처리해요)
const BUY_COMMANDS = new Set(["복권구매", "즉석복권", "연금복권"]);
export async function lotteryAutocomplete(interaction, env) {
  const cmd = interaction.data.name;
  if (!BUY_COMMANDS.has(cmd)) return null;
  const focused = interaction.data.options?.find((o) => o.focused);
  if (!focused || focused.name !== "수량") return [];
  const userId = interaction.member?.user?.id;
  if (!userId) return [];
  const val = (name) => interaction.data.options?.find((o) => o.name === name)?.value;
  const keyword = String(focused.value ?? "").trim();

  let price = TICKET_PRICE;
  let cap = MAX_SCRATCH;
  let path = null;
  if (cmd === "복권구매") { cap = MAX_TICKETS; path = PATH; }
  else if (cmd === "연금복권") { cap = PENSION_MAX; path = PENSION_PATH; }
  else price = (SCRATCH_KINDS[val("종류") ?? "normal"] || SCRATCH_KINDS.normal).price;

  const [user, state] = await Promise.all([getUser(env, userId), path ? getDoc(env, path) : null]);
  const balance = user.balance || 0;
  const mine = path ? Object.keys(state?.tickets || {}).filter((k) => k.startsWith(`${userId}_`)).length : 0;
  const closed = !!state?.drawAt && Date.now() >= state.drawAt - CLOSE_BEFORE_MS;
  const max = closed ? 0 : Math.max(0, Math.min(cap - mine, Math.floor(balance / price)));

  if (max <= 0) {
    const why = closed ? "이번 회차 판매 마감" : cap - mine <= 0 ? `이번 회차 ${cap}장을 다 샀어요` : `잔고 부족 (장당 ${num(price)}해정 · 잔고 ${num(balance)})`;
    return [{ name: `더 살 수 없어요 · ${why}`.slice(0, 100), value: 1 }];
  }
  const labelFor = (q) => {
    const cost = price * q;
    if (q > cap - mine) return `${num(q)}장 불가 (최대 ${num(cap - mine)}장 · 지금 ${mine}장)`;
    if (cost > balance) return `${num(q)}장 불가 (필요 ${num(cost)} / 잔고 ${num(balance)}해정)`;
    return `${num(q)}장 → -${num(cost)}해정 · 잔고 ${num(balance - cost)}해정`;
  };
  const out = [];
  const seen = new Set();
  const push = (q, label) => { if (!seen.has(q)) { seen.add(q); out.push({ name: label.slice(0, 100), value: q }); } };
  const typed = Number(keyword);
  if (/^\d+$/.test(keyword) && Number.isSafeInteger(typed) && typed >= 1) push(typed, labelFor(typed));
  for (const q of [...[1, 2, 5, 10].filter((n) => n < max), max]) if (!keyword || String(q).startsWith(keyword)) push(q, (q === max ? "최대 " : "") + labelFor(q));
  return out.slice(0, 25);
}

export const LOTTERY_VIEW_ONLY = new Set(["복권현황", "연금복권현황"]);
const opt = (i, name) => i.data.options?.find((o) => o.name === name)?.value;
export const lotteryHandlers = {
  복권구매: (i, env) => buyTickets(env, i.member.user.id, { qty: opt(i, "수량") ?? 1, numbers: opt(i, "번호") }),
  즉석복권: (i, env) => buyScratch(env, i.member.user.id, opt(i, "수량") ?? 1, opt(i, "종류") ?? "normal"),
  연금복권: (i, env) => buyPension(env, i.member.user.id, { qty: opt(i, "수량") ?? 1, numbers: opt(i, "번호") }),
  연금복권현황: (i, env) => pensionInfo(env, i.member.user.id),
  복권현황: (i, env) => lotteryInfo(env, i.member.user.id),
};