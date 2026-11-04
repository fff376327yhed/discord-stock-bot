// 해정 장터: 유저끼리 주식을 사고파는 기능 (직접 거래 제안 + 경매)
//  - 일반 종목(해정으로 사는 종목)만 돼요. 코인·해외주식은 안 돼요.
//  - 수수료 5%는 "파는 사람"이 받는 돈에서 떼요. (사라져요)
//  - 거래 가치(합의가와 시세 중 큰 값)는 7일 송금·거래 한도(weekly.js)에 같이 쌓여요.
//  - 파는 주식은 올리는 순간 "보관"으로 빠지고, 입찰금도 입찰하는 순간 "보관"으로 빠져요. (취소·기한이 지나면 돌려받아요)
//  - 유저 간 거래는 시세에 영향을 주지 않아요. (거래 압력에 안 잡혀요)
//  - 저장: config/market 문서 하나에 { nextId, items: { 번호: 거래제안 또는 경매 } } 로 모아요. (읽기 아끼려고)
// 이 파일은 lib.js를 가져다 쓰기만 해요. (lib.js는 이 파일을 가져오지 않아요)

import {
  getUser, updateUserLocked, addHistory, sendDM, getStock, haltNotice, costOf,
  listStocksForAutocomplete, getDoc, setDoc, getDocMeta, setDocIfUnchanged, recordShareChange, discordPost,
} from "./lib.js";
import { isForeign } from "./foreign.js";
import { weeklyBlockText, weeklyAdd } from "./weekly.js";

// ---------- 숫자만 바꾸면 되는 설정 ----------
export const MARKET_FEE_RATE = 0.05; // 수수료 5% (올림, 최소 1해정)
export const OFFER_TTL_MS = 24 * 60 * 60 * 1000; // 거래 제안 유효 시간 24시간
export const AUCTION_HOURS = [1, 3, 6, 12, 24]; // 경매 기간 선택지
export const MIN_RAISE_RATE = 0.05; // 입찰은 지금 최고가보다 5% 이상 높게
export const SNIPE_MS = 5 * 60 * 1000; // 끝나기 5분 안에 입찰하면 종료가 5분 뒤로 밀려요
const MAX_PER_USER = 3; // 한 사람이 동시에 올릴 수 있는 제안+경매 수
const MAX_ITEMS = 40; // 장터 전체 동시 개수 (문서 하나에 모으니까 너무 커지지 않게)

const PATH = "config/market";
const num = (x) => Number(x).toLocaleString();
const when = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const marketFee = (amount) => Math.max(1, Math.ceil(amount * MARKET_FEE_RATE));
const isInt = (x, min = 1) => Number.isSafeInteger(x) && x >= min;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const feeText = `${Math.round(MARKET_FEE_RATE * 1000) / 10}%`;

// ---------- 작은 도우미 ----------
async function retry(fn, label, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      console.error(`${label} 재시도 ${i + 1}/${tries}:`, err.message);
      await sleep(300 * (i + 1));
    }
  }
  throw last;
}

const dm = (env, userId, text) => sendDM(env, userId, text).catch((err) => console.error("장터 DM 실패:", err.message));

async function announce(env, content) {
  if (!env.ALLOWED_CHANNEL_ID) return;
  try {
    await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
      content: content.slice(0, 1900),
      flags: 4096, // 무음
      allowed_mentions: { parse: [] },
    });
  } catch (err) {
    console.error("장터 공지 실패:", err.message);
  }
}

// 액면분할이 올린 뒤에 있었으면, 보관 중인 수량도 같은 비율로 늘려요 (원가는 그대로)
function effQty(item, stock) {
  return stock && stock.splitAt > item.at && stock.splitRatio >= 2 ? item.qty * stock.splitRatio : item.qty;
}

// 거래할 수 있는 종목인지 확인 (있는지 / 일반 종목인지 / 거래정지 아닌지)
async function tradableStock(env, name) {
  const stock = await getStock(env, name);
  if (!stock) return { error: `"${name}" 종목을 찾을 수 없어요. (상장폐지됐을 수 있어요)` };
  if (isForeign(stock)) return { error: "코인·해외주식은 유저끼리 거래할 수 없어요. 일반 종목만 돼요." };
  const halted = haltNotice([stock]);
  if (halted) return { error: halted };
  return { stock };
}

// ---------- 장터 문서: 동시에 건드려도 안 꼬이게 (낙관적 잠금) ----------
// mutate(state) -> { save, result }   save가 true면 저장해요. (mutate 안에서는 저장·전송 같은 일을 하면 안 돼요)
async function mutateMarket(env, mutate, tries = 6) {
  for (let i = 0; i < tries; i++) {
    let meta = await getDocMeta(env, PATH);
    if (!meta) {
      await setDoc(env, PATH, { nextId: 1, items: {} });
      meta = await getDocMeta(env, PATH);
      if (!meta) throw new Error("장터 정보를 만들지 못했어요.");
    }
    const state = meta.data;
    if (!state.items || typeof state.items !== "object") state.items = {};
    if (!Number.isFinite(state.nextId)) state.nextId = 1;
    const out = mutate(state);
    if (!out.save) return out.result;
    if (await setDocIfUnchanged(env, PATH, { nextId: state.nextId, items: state.items }, meta.updateTime)) return out.result;
    await sleep(40 + Math.random() * 80);
  }
  throw new Error("지금 요청이 한꺼번에 몰려서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
}

const readMarket = async (env) => {
  const doc = await getDoc(env, PATH);
  return doc && doc.items ? doc : { nextId: 1, items: {} };
};

// 번호로 항목을 지우면서 가져와요 (= 내가 처리하기로 "찜"하는 거예요. 지운 사람만 이어서 처리해요)
const claim = (env, id, check) =>
  mutateMarket(env, (s) => {
    const cur = s.items[String(id)];
    if (!cur || !check(cur)) return { save: false, result: null };
    delete s.items[String(id)];
    return { save: true, result: cur };
  });

// ---------- 주식·돈을 옮기는 작은 단계들 ----------
// 파는 사람의 주식을 "보관"으로 빼요. (원가도 같이 떼어 둬요)
function escrowShares(env, userId, name, qty, price) {
  return updateUserLocked(env, userId, (u) => {
    const held = u.holdings[name] || 0;
    if (held < qty) return { save: false, result: { ok: false, message: `보유 수량이 부족해요. (보유: ${num(held)}주)` } };
    const prevCost = costOf(u, name, price);
    const basis = Math.round((prevCost * qty) / held);
    u.holdings[name] = held - qty;
    if (u.holdings[name] === 0) {
      delete u.holdings[name];
      delete u.costs[name];
    } else {
      u.costs[name] = prevCost - basis;
    }
    return { save: true, result: { ok: true, basis, closed: held - qty === 0 } };
  });
}

// 보관한 주식을 판 사람에게 돌려줘요 (취소·기한 지남·낙찰자 없음)
async function refundItem(env, item) {
  const stock = await getStock(env, item.name);
  if (!stock) return { gone: true, qty: item.qty }; // 상장폐지: 주식이 같이 사라졌어요
  const qty = effQty(item, stock);
  const r = await retry(
    () =>
      updateUserLocked(env, item.seller, (u) => {
        const before = u.holdings[item.name] || 0;
        const prevCost = costOf(u, item.name, stock.price);
        u.holdings[item.name] = before + qty;
        u.costs[item.name] = prevCost + item.basis;
        return { save: true, result: { opened: before === 0 } };
      }),
    "장터 주식 반환"
  );
  if (r.opened) await recordShareChange(env, [{ name: item.name, qty: 0, newHolder: true }]);
  return { gone: false, qty };
}

const refundMoney = (env, userId, amount) =>
  retry(
    () =>
      updateUserLocked(env, userId, (u) => {
        u.balance += amount;
        return { save: true, result: u.balance };
      }),
    "장터 입찰금 반환"
  );

// ---------- 거래 제안 ----------
export async function createOffer(env, sellerId, { toId, toIsBot, name, qty, price }) {
  if (!toId) return "받는 사람을 골라 주세요.";
  if (toIsBot) return "봇에게는 팔 수 없어요.";
  if (toId === sellerId) return "자기 자신에게는 제안할 수 없어요.";
  if (!isInt(qty)) return "수량은 1 이상의 정수여야 해요.";
  if (!isInt(price)) return "가격은 1해정 이상의 정수여야 해요.";
  if (!(await getDoc(env, `users/${toId}`))) return "받는 사람이 아직 해정 봇을 쓴 적이 없어요. 먼저 명령어를 한 번 써보라고 알려주세요.";

  const chk = await tradableStock(env, name);
  if (chk.error) return chk.error;
  const { stock } = chk;

  const seller = await getUser(env, sellerId);
  if ((seller.holdings[name] || 0) < qty) return `보유 수량이 부족해요. (보유: ${num(seller.holdings[name] || 0)}주)`;
  const value = Math.max(price, stock.price * qty);
  const blocked = weeklyBlockText(seller, value);
  if (blocked) return blocked;

  const esc = await escrowShares(env, sellerId, name, qty, stock.price);
  if (!esc.ok) return esc.message;
  if (esc.closed) await recordShareChange(env, [{ name, qty: 0, closedHolder: true }]);

  const now = Date.now();
  let placed;
  try {
    placed = await mutateMarket(env, (s) => {
      const items = Object.values(s.items);
      if (items.length >= MAX_ITEMS) return { save: false, result: { ok: false, message: "장터가 꽉 찼어요. 잠시 뒤에 다시 시도해 주세요." } };
      if (items.filter((i) => i.seller === sellerId).length >= MAX_PER_USER) {
        return { save: false, result: { ok: false, message: `한 번에 올릴 수 있는 건 ${MAX_PER_USER}개까지예요. (제안+경매 합쳐서)` } };
      }
      const id = s.nextId++;
      s.items[String(id)] = { id, type: "offer", seller: sellerId, to: toId, name, qty, basis: esc.basis, price, at: now, exp: now + OFFER_TTL_MS };
      return { save: true, result: { ok: true, id } };
    });
  } catch (err) {
    placed = { ok: false, message: err.message };
  }
  if (!placed.ok) {
    await refundItem(env, { seller: sellerId, name, qty, basis: esc.basis, at: now }); // 보관한 주식 되돌리기
    return placed.message;
  }

  const fee = marketFee(price);
  await addHistory(env, sellerId, `거래제안 #${placed.id}: <@${toId}>에게 ${name} ${num(qty)}주를 ${num(price)}해정에 제안`);
  await dm(
    env,
    toId,
    `📨 <@${sellerId}>님이 **${name} ${num(qty)}주**를 **${num(price)}해정**에 팔겠다고 제안했어요! (시세 합계 ${num(stock.price * qty)}해정)\n\`/거래수락 번호:${placed.id}\` 로 사거나 \`/거래거절 번호:${placed.id}\` 로 거절해요. ${when(now + OFFER_TTL_MS)} 까지예요.`
  );
  return [
    `📨 **거래 제안 #${placed.id}**을 <@${toId}>님께 보냈어요.`,
    `• ${name} ${num(qty)}주 → ${num(price)}해정 (지금 시세 합계 ${num(stock.price * qty)}해정)`,
    `• 팔리면 수수료 ${feeText}(${num(fee)}해정)를 떼고 **${num(price - fee)}해정**을 받아요.`,
    `• 주식은 보관 중이에요. 상대가 안 사거나 ${when(now + OFFER_TTL_MS)} 지나면 돌아와요. (\`/거래취소 번호:${placed.id}\`로 직접 취소도 돼요)`,
  ].join("\n");
}

export async function acceptOffer(env, buyerId, id) {
  const state = await readMarket(env);
  const it = state.items[String(id)];
  if (!it || it.type !== "offer") return "그 번호의 거래 제안이 없어요. (이미 끝났거나 취소됐을 수 있어요)";
  if (it.to !== buyerId) return "이 제안은 다른 사람에게 온 거예요.";
  if (it.exp <= Date.now()) {
    await processMarket(env);
    return "기한이 지난 제안이에요. 주식은 판매자에게 돌아갔어요.";
  }
  const chk = await tradableStock(env, it.name);
  if (chk.error) return chk.error;
  const { stock } = chk;
  const qty = effQty(it, stock);

  const buyer = await getUser(env, buyerId);
  if (buyer.balance < it.price) return `잔고가 부족해요. (필요: ${num(it.price)}해정, 보유: ${num(buyer.balance)}해정)`;
  const value = Math.max(it.price, stock.price * qty);
  const blocked = weeklyBlockText(buyer, value);
  if (blocked) return blocked;

  // 1) 제안을 내가 가져와요 (이 순간부터 다른 사람은 못 건드려요)
  const c = await claim(env, id, (cur) => cur.type === "offer" && cur.to === buyerId && cur.exp > Date.now());
  if (!c) return "그 사이에 취소되었거나 기한이 지나서 처리하지 못했어요.";

  // 2) 구매자: 결제 + 주식 받기
  const pay = await updateUserLocked(env, buyerId, (u) => {
    if (u.balance < c.price) return { save: false, result: { ok: false, message: `잔고가 부족해요. (필요: ${num(c.price)}해정, 보유: ${num(u.balance)}해정)` } };
    const blockedNow = weeklyBlockText(u, value);
    if (blockedNow) return { save: false, result: { ok: false, message: blockedNow } };
    const before = u.holdings[c.name] || 0;
    const prevCost = costOf(u, c.name, stock.price);
    const balBefore = u.balance;
    u.balance -= c.price;
    u.holdings[c.name] = before + qty;
    u.costs[c.name] = prevCost + c.price;
    weeklyAdd(u, value);
    return { save: true, result: { ok: true, opened: before === 0, balBefore, balAfter: u.balance, total: before + qty, avg: Math.round(u.costs[c.name] / (before + qty)) } };
  });
  if (!pay.ok) {
    // 못 샀으니 제안을 다시 올려 둬요 (그것도 안 되면 판 사람에게 바로 돌려줘요)
    await mutateMarket(env, (s) => {
      s.items[String(c.id)] = c;
      return { save: true, result: true };
    }).catch(() => refundItem(env, c));
    return pay.message;
  }
  if (pay.opened) await recordShareChange(env, [{ name: c.name, qty: 0, newHolder: true }]);

  // 3) 판매자: 수수료를 떼고 받기
  const fee = marketFee(c.price);
  const get = c.price - fee;
  await retry(
    () =>
      updateUserLocked(env, c.seller, (u) => {
        u.balance += get;
        u.realizedProfit = (u.realizedProfit || 0) + (get - c.basis);
        weeklyAdd(u, value);
        return { save: true, result: true };
      }),
    "거래 판매자 정산"
  );

  await Promise.all([
    addHistory(env, buyerId, `거래수락 #${c.id}: <@${c.seller}>에게서 ${c.name} ${num(qty)}주를 ${num(c.price)}해정에 매수 → 잔고 ${num(pay.balAfter)}해정`),
    addHistory(env, c.seller, `거래성사 #${c.id}: <@${buyerId}>에게 ${c.name} ${num(qty)}주를 ${num(c.price)}해정에 매도 (수수료 ${num(fee)}) → +${num(get)}해정`),
  ]);
  await dm(env, c.seller, `✅ 거래 제안 #${c.id}이 성사됐어요! <@${buyerId}>님이 **${c.name} ${num(qty)}주**를 샀어요.\n💰 수수료 ${num(fee)}해정을 떼고 **+${num(get)}해정** 받았어요.`);
  return [
    `✅ **거래 성사 #${c.id}** <@${c.seller}>님에게서 **${c.name} ${num(qty)}주**를 샀어요.`,
    `💰 잔고: ${num(pay.balBefore)} → **${num(pay.balAfter)}해정** (-${num(c.price)})`,
    `📊 평균 매수가: ${num(pay.avg)}해정 (보유 ${num(pay.total)}주)`,
  ].join("\n");
}

// 보낸 사람이 취소하거나, 받은 사람이 거절해요. who: "seller" | "buyer"
export async function cancelOffer(env, userId, id, who) {
  const state = await readMarket(env);
  const it = state.items[String(id)];
  if (!it || it.type !== "offer") return "그 번호의 거래 제안이 없어요.";
  if (who === "seller" && it.seller !== userId) return "내가 보낸 제안이 아니에요. (받은 제안은 `/거래거절`로 거절해요)";
  if (who === "buyer" && it.to !== userId) return "내가 받은 제안이 아니에요. (보낸 제안은 `/거래취소`로 취소해요)";

  const c = await claim(env, id, (cur) => cur.type === "offer" && (who === "seller" ? cur.seller === userId : cur.to === userId));
  if (!c) return "그 사이에 이미 처리된 제안이에요.";
  const back = await refundItem(env, c);
  const text = back.gone ? "그 종목이 상장폐지돼서 주식은 사라졌어요." : `보관했던 ${c.name} ${num(back.qty)}주는 판매자에게 돌아갔어요.`;
  await addHistory(env, c.seller, `거래제안 #${c.id} ${who === "seller" ? "취소" : "거절당함"}: ${c.name} ${num(c.qty)}주`);
  if (who === "buyer") await dm(env, c.seller, `❌ <@${userId}>님이 거래 제안 #${c.id}(${c.name} ${num(c.qty)}주)를 거절했어요. ${text}`);
  return who === "seller" ? `🗑️ 거래 제안 #${c.id}을 취소했어요. ${text}` : `🙅 거래 제안 #${c.id}을 거절했어요.`;
}

// ---------- 경매 ----------
export async function createAuction(env, sellerId, { name, qty, start, hours }) {
  if (!isInt(qty)) return "수량은 1 이상의 정수여야 해요.";
  if (!isInt(start)) return "시작가는 1해정 이상의 정수여야 해요.";
  if (!AUCTION_HOURS.includes(hours)) return `경매 기간은 ${AUCTION_HOURS.join(" / ")}시간 중에서 골라 주세요.`;

  const chk = await tradableStock(env, name);
  if (chk.error) return chk.error;
  const { stock } = chk;

  const seller = await getUser(env, sellerId);
  if ((seller.holdings[name] || 0) < qty) return `보유 수량이 부족해요. (보유: ${num(seller.holdings[name] || 0)}주)`;
  const blocked = weeklyBlockText(seller, Math.max(start, stock.price * qty));
  if (blocked) return blocked;

  const esc = await escrowShares(env, sellerId, name, qty, stock.price);
  if (!esc.ok) return esc.message;
  if (esc.closed) await recordShareChange(env, [{ name, qty: 0, closedHolder: true }]);

  const now = Date.now();
  const end = now + hours * 60 * 60 * 1000;
  let placed;
  try {
    placed = await mutateMarket(env, (s) => {
      const items = Object.values(s.items);
      if (items.length >= MAX_ITEMS) return { save: false, result: { ok: false, message: "장터가 꽉 찼어요. 잠시 뒤에 다시 시도해 주세요." } };
      if (items.filter((i) => i.seller === sellerId).length >= MAX_PER_USER) {
        return { save: false, result: { ok: false, message: `한 번에 올릴 수 있는 건 ${MAX_PER_USER}개까지예요. (제안+경매 합쳐서)` } };
      }
      const id = s.nextId++;
      s.items[String(id)] = { id, type: "auction", seller: sellerId, name, qty, basis: esc.basis, start, bid: 0, bidder: "", at: now, end };
      return { save: true, result: { ok: true, id } };
    });
  } catch (err) {
    placed = { ok: false, message: err.message };
  }
  if (!placed.ok) {
    await refundItem(env, { seller: sellerId, name, qty, basis: esc.basis, at: now });
    return placed.message;
  }

  await addHistory(env, sellerId, `경매등록 #${placed.id}: ${name} ${num(qty)}주 · 시작가 ${num(start)}해정 · ${hours}시간`);
  return [
    `🔨 **경매 #${placed.id}** 시작! <@${sellerId}>님이 **${name} ${num(qty)}주**를 내놨어요.`,
    `• 시작가 ${num(start)}해정 (지금 시세 합계 ${num(stock.price * qty)}해정)`,
    `• 종료 ${when(end)} · 새 입찰은 최고가보다 ${Math.round(MIN_RAISE_RATE * 100)}% 이상 높게`,
    `• 끝나기 ${SNIPE_MS / 60000}분 안에 입찰이 들어오면 ${SNIPE_MS / 60000}분 더 연장돼요.`,
    `• 입찰: \`/입찰 번호:${placed.id} 금액\` · 낙찰되면 수수료 ${feeText}는 판매자가 내요.`,
  ].join("\n");
}

const minBidOf = (a) => (a.bid > 0 ? Math.max(a.bid + 1, Math.ceil(a.bid * (1 + MIN_RAISE_RATE))) : a.start);

export async function placeBid(env, bidderId, id, amount) {
  if (!isInt(amount)) return "입찰 금액은 1해정 이상의 정수여야 해요.";
  const state = await readMarket(env);
  const a = state.items[String(id)];
  if (!a || a.type !== "auction") return "그 번호의 경매가 없어요. (이미 끝났을 수 있어요)";
  if (a.end <= Date.now()) {
    await processMarket(env);
    return "이미 끝난 경매예요. 결과를 정리하고 있어요.";
  }
  if (a.seller === bidderId) return "내가 올린 경매에는 입찰할 수 없어요.";
  if (a.bidder === bidderId) return `이미 내가 최고 입찰자예요. (현재 ${num(a.bid)}해정)`;
  const min = minBidOf(a);
  if (amount < min) return `입찰이 너무 낮아요. 지금은 **${num(min)}해정 이상**이어야 해요. (현재 최고가 ${a.bid > 0 ? `${num(a.bid)}해정` : "없음 · 시작가 " + num(a.start) + "해정"})`;

  const chk = await tradableStock(env, a.name);
  if (chk.error) return chk.error;
  const { stock } = chk;
  const value = Math.max(amount, stock.price * effQty(a, stock));

  // 1) 입찰금을 보관으로 빼요 (한도·잔고 확인 포함)
  const hold = await updateUserLocked(env, bidderId, (u) => {
    if (u.balance < amount) return { save: false, result: { ok: false, message: `잔고가 부족해요. (필요: ${num(amount)}해정, 보유: ${num(u.balance)}해정)` } };
    const blockedNow = weeklyBlockText(u, value);
    if (blockedNow) return { save: false, result: { ok: false, message: blockedNow } };
    const before = u.balance;
    u.balance -= amount;
    return { save: true, result: { ok: true, before, after: u.balance } };
  });
  if (!hold.ok) return hold.message;

  // 2) 경매에 입찰을 올려요
  let res;
  try {
    res = await mutateMarket(env, (s) => {
      const cur = s.items[String(id)];
      if (!cur || cur.type !== "auction" || cur.end <= Date.now()) return { save: false, result: { ok: false, message: "그 사이에 경매가 끝났어요." } };
      const minNow = minBidOf(cur);
      if (amount < minNow) return { save: false, result: { ok: false, message: `방금 다른 사람이 먼저 입찰했어요. 지금은 **${num(minNow)}해정 이상**이어야 해요.` } };
      const prev = { bidder: cur.bidder, bid: cur.bid };
      cur.bid = amount;
      cur.bidder = bidderId;
      const now = Date.now();
      if (cur.end - now < SNIPE_MS) cur.end = now + SNIPE_MS;
      return { save: true, result: { ok: true, prev, end: cur.end } };
    });
  } catch (err) {
    res = { ok: false, message: err.message };
  }
  if (!res.ok) {
    await refundMoney(env, bidderId, amount); // 못 올렸으니 입찰금 돌려받기
    return res.message;
  }

  // 3) 앞 최고 입찰자에게 입찰금 돌려주기
  if (res.prev.bidder) {
    await refundMoney(env, res.prev.bidder, res.prev.bid).catch((err) => console.error("앞 입찰자 환불 실패:", err.message));
    await dm(env, res.prev.bidder, `⚠️ 경매 #${id} (${a.name} ${num(a.qty)}주)에서 더 높은 입찰이 들어왔어요. 입찰금 **${num(res.prev.bid)}해정**은 돌려받았어요. 새 최고가 ${num(amount)}해정`);
  }
  await addHistory(env, bidderId, `입찰 #${id}: ${a.name} ${num(a.qty)}주에 ${num(amount)}해정 → 잔고 ${num(hold.after)}해정`);
  await dm(env, a.seller, `🔔 경매 #${id} (${a.name} ${num(a.qty)}주)에 **${num(amount)}해정** 입찰이 들어왔어요!`);
  return [
    `🔨 **경매 #${id}** 최고 입찰자가 됐어요! <@${bidderId}>님 **${num(amount)}해정** (${a.name} ${num(a.qty)}주)`,
    `💰 잔고: ${num(hold.before)} → ${num(hold.after)}해정 (입찰금은 보관 중이에요. 밀리거나 유찰되면 돌려받아요)`,
    `⏰ 종료 ${when(res.end)}`,
  ].join("\n");
}

export async function cancelAuction(env, userId, id) {
  const state = await readMarket(env);
  const a = state.items[String(id)];
  if (!a || a.type !== "auction") return "그 번호의 경매가 없어요.";
  if (a.seller !== userId) return "내가 올린 경매가 아니에요.";
  if (a.bidder) return "이미 입찰이 있어서 취소할 수 없어요. (끝날 때까지 기다려 주세요)";
  const c = await claim(env, id, (cur) => cur.type === "auction" && cur.seller === userId && !cur.bidder);
  if (!c) return "그 사이에 입찰이 들어왔거나 이미 끝나서 취소하지 못했어요.";
  const back = await refundItem(env, c);
  await addHistory(env, userId, `경매취소 #${c.id}: ${c.name} ${num(c.qty)}주`);
  return `🗑️ 경매 #${c.id}을 취소했어요. ${back.gone ? "그 종목이 상장폐지돼서 주식은 사라졌어요." : `보관했던 ${c.name} ${num(back.qty)}주가 돌아왔어요.`}`;
}

// ---------- 기한이 지난 것 정리 (크론에서 5분마다, 장터를 볼 때도 불러요) ----------
async function finishAuction(env, a) {
  const stock = await getStock(env, a.name);
  if (!stock) {
    await refundMoney(env, a.bidder, a.bid);
    await dm(env, a.bidder, `🚫 경매 #${a.id}의 ${a.name}이(가) 상장폐지돼서 낙찰이 취소됐어요. 입찰금 ${num(a.bid)}해정은 돌려받았어요.`);
    await dm(env, a.seller, `🚫 경매 #${a.id}의 ${a.name}이(가) 상장폐지돼서 주식이 사라졌어요.`);
    return;
  }
  const qty = effQty(a, stock);
  const value = Math.max(a.bid, stock.price * qty);
  const fee = marketFee(a.bid);
  const get = a.bid - fee;

  const win = await retry(
    () =>
      updateUserLocked(env, a.bidder, (u) => {
        const before = u.holdings[a.name] || 0;
        const prevCost = costOf(u, a.name, stock.price);
        u.holdings[a.name] = before + qty;
        u.costs[a.name] = prevCost + a.bid;
        weeklyAdd(u, value);
        return { save: true, result: { opened: before === 0 } };
      }),
    "경매 낙찰자 지급"
  );
  if (win.opened) await recordShareChange(env, [{ name: a.name, qty: 0, newHolder: true }]);
  await retry(
    () =>
      updateUserLocked(env, a.seller, (u) => {
        u.balance += get;
        u.realizedProfit = (u.realizedProfit || 0) + (get - a.basis);
        weeklyAdd(u, value);
        return { save: true, result: true };
      }),
    "경매 판매자 정산"
  );

  await Promise.all([
    addHistory(env, a.bidder, `낙찰 #${a.id}: ${a.name} ${num(qty)}주를 ${num(a.bid)}해정에 매수`),
    addHistory(env, a.seller, `경매성사 #${a.id}: ${a.name} ${num(qty)}주 ${num(a.bid)}해정 (수수료 ${num(fee)}) → +${num(get)}해정`),
  ]);
  await dm(env, a.bidder, `🎉 경매 #${a.id} 낙찰! **${a.name} ${num(qty)}주**를 ${num(a.bid)}해정에 샀어요.`);
  await dm(env, a.seller, `🔨 경매 #${a.id} 낙찰! <@${a.bidder}>님이 ${num(a.bid)}해정에 샀어요. 수수료 ${num(fee)}해정을 떼고 **+${num(get)}해정** 받았어요.`);
  await announce(env, `🔨 **경매 #${a.id} 종료** · <@${a.bidder}>님이 **${a.name} ${num(qty)}주**를 **${num(a.bid)}해정**에 낙찰받았어요! (판매 <@${a.seller}>)`);
}

export async function processMarket(env) {
  const state = await getDoc(env, PATH);
  if (!state || !state.items) return { settled: 0 };
  const now = Date.now();
  const due = Object.values(state.items).filter((i) => (i.type === "offer" ? i.exp : i.end) <= now);
  let settled = 0;
  for (const it of due) {
    const c = await claim(env, it.id, (cur) => (cur.type === "offer" ? cur.exp : cur.end) <= Date.now());
    if (!c) continue;
    try {
      if (c.type === "auction" && c.bidder) {
        await finishAuction(env, c);
      } else {
        const back = await refundItem(env, c);
        const what = c.type === "offer" ? `거래 제안 #${c.id}` : `경매 #${c.id}`;
        const why = c.type === "offer" ? "받는 사람이 사지 않아서" : "입찰이 없어서";
        await dm(env, c.seller, `⌛ ${what}이(가) ${why} 끝났어요. ${back.gone ? "그 종목이 상장폐지돼서 주식은 사라졌어요." : `보관했던 ${c.name} ${num(back.qty)}주가 돌아왔어요.`}`);
      }
      settled++;
    } catch (err) {
      console.error(`장터 정리 실패 (#${c.id}):`, err.message);
    }
  }
  return { settled };
}

// ---------- /장터 보기 ----------
export async function marketView(env, userId) {
  await processMarket(env).catch((err) => console.error("장터 정리 실패:", err.message));
  const state = await readMarket(env);
  const items = Object.values(state.items);
  if (!items.length) return "🏪 지금 장터가 비어 있어요.\n`/경매등록` 으로 경매를 열거나 `/거래제안` 으로 친구에게 주식을 팔아 보세요!";

  const price = new Map((await listStocksForAutocomplete(env)).map((s) => [s.name, s.price]));
  const worth = (i) => (price.has(i.name) ? ` (시세 ${num(price.get(i.name) * i.qty)})` : "");
  const auctions = items.filter((i) => i.type === "auction").sort((a, b) => a.end - b.end);
  const mineIn = items.filter((i) => i.type === "offer" && i.to === userId);
  const mineOut = items.filter((i) => i.type === "offer" && i.seller === userId);

  const lines = ["🏪 **해정 장터**"];
  if (auctions.length) {
    lines.push("", `🔨 **진행 중인 경매** (${auctions.length})`);
    for (const a of auctions.slice(0, 10)) {
      const top = a.bid > 0 ? `최고가 **${num(a.bid)}** (<@${a.bidder}>)` : `시작가 ${num(a.start)} · 입찰 없음`;
      lines.push(`• \`#${a.id}\` **${a.name} ${num(a.qty)}주**${worth(a)} · ${top} · 다음 입찰 ${num(minBidOf(a))}↑ · 종료 ${when(a.end)} · 판매 <@${a.seller}>`);
    }
  }
  if (mineIn.length) {
    lines.push("", `📨 **나에게 온 거래 제안** (${mineIn.length})`);
    for (const o of mineIn) lines.push(`• \`#${o.id}\` <@${o.seller}> → **${o.name} ${num(o.qty)}주**${worth(o)} **${num(o.price)}해정** · ${when(o.exp)} 까지 · \`/거래수락\` \`/거래거절\``);
  }
  if (mineOut.length) {
    lines.push("", `📤 **내가 보낸 거래 제안** (${mineOut.length})`);
    for (const o of mineOut) lines.push(`• \`#${o.id}\` <@${o.to}>에게 **${o.name} ${num(o.qty)}주**${worth(o)} **${num(o.price)}해정** · ${when(o.exp)} 까지 · \`/거래취소\``);
  }
  lines.push("", `수수료 ${feeText}(파는 사람) · 7일 송금·거래 한도에 합쳐져요`);
  return lines.join("\n").slice(0, 1990);
}

// ---------- 파산신청 막기용: 보관 중인 주식·입찰금이 있는지 ----------
// (보관 중인 자산은 순자산에 안 잡혀서, 파산으로 빚만 지우고 나중에 되찾는 꼼수를 막아요)
export async function marketStake(env, userId) {
  const state = await readMarket(env);
  const mine = Object.values(state.items).filter((i) => i.seller === userId || (i.type === "auction" && i.bidder === userId));
  return mine.length ? mine : null;
}

// ---------- 디스코드 명령어 정의 ----------
export const marketCommandDefinitions = [
  {
    name: "거래제안",
    description: `다른 유저에게 내 주식을 팔겠다고 제안해요. (수수료 ${feeText}는 파는 사람이 내요)`,
    options: [
      { name: "받는사람", description: "주식을 살 유저", type: 6, required: true },
      { name: "종목", description: "팔 종목 (내 보유 종목, 일반 종목만)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "팔 수량", type: 4, required: true, min_value: 1 },
      { name: "가격", description: "받고 싶은 전체 가격 (해정)", type: 4, required: true, autocomplete: true, min_value: 1 },
    ],
  },
  {
    name: "거래수락",
    description: "나에게 온 거래 제안을 받아들여 주식을 사요.",
    options: [{ name: "번호", description: "거래 제안 번호", type: 4, required: true, autocomplete: true, min_value: 1 }],
  },
  {
    name: "거래거절",
    description: "나에게 온 거래 제안을 거절해요.",
    options: [{ name: "번호", description: "거래 제안 번호", type: 4, required: true, autocomplete: true, min_value: 1 }],
  },
  {
    name: "거래취소",
    description: "내가 보낸 거래 제안을 취소하고 주식을 돌려받아요.",
    options: [{ name: "번호", description: "거래 제안 번호", type: 4, required: true, autocomplete: true, min_value: 1 }],
  },
  {
    name: "경매등록",
    description: `내 주식을 경매에 올려요. (낙찰되면 수수료 ${feeText}는 파는 사람이 내요)`,
    options: [
      { name: "종목", description: "경매에 올릴 종목 (내 보유 종목, 일반 종목만)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "올릴 수량", type: 4, required: true, min_value: 1 },
      { name: "시작가", description: "시작 가격 (해정, 전체 가격)", type: 4, required: true, autocomplete: true, min_value: 1 },
      { name: "시간", description: "경매 기간", type: 4, required: true, choices: AUCTION_HOURS.map((h) => ({ name: `${h}시간`, value: h })) },
    ],
  },
  {
    name: "입찰",
    description: "진행 중인 경매에 입찰해요. (입찰금은 바로 빠져나가고, 밀리면 돌려받아요)",
    options: [
      { name: "번호", description: "경매 번호", type: 4, required: true, autocomplete: true, min_value: 1 },
      { name: "금액", description: "입찰 금액 (해정)", type: 4, required: true, autocomplete: true, min_value: 1 },
    ],
  },
  {
    name: "경매취소",
    description: "입찰이 아직 없는 내 경매를 취소하고 주식을 돌려받아요.",
    options: [{ name: "번호", description: "경매 번호", type: 4, required: true, autocomplete: true, min_value: 1 }],
  },
  { name: "장터", description: "진행 중인 경매와 나에게 온/내가 보낸 거래 제안을 봐요." },
];

export const MARKET_COMMANDS = new Set(marketCommandDefinitions.map((d) => d.name));
export const MARKET_VIEW_ONLY = new Set(["장터"]); // 활동 로그에 안 남기는 명령어
export const MARKET_SILENT = new Set(["경매등록", "입찰"]); // 모두에게 보이는(무음) 명령어. 나머지(장터 포함)는 나만 봐요.

// ---------- 명령어 처리 ----------
const opt = (i, name) => i.data.options?.find((o) => o.name === name)?.value;
const uid = (i) => i.member.user.id;

export const marketHandlers = {
  거래제안: (i, env) => {
    const toId = opt(i, "받는사람");
    return createOffer(env, uid(i), {
      toId,
      toIsBot: !!i.data.resolved?.users?.[toId]?.bot,
      name: String(opt(i, "종목") ?? "").trim(),
      qty: opt(i, "수량"),
      price: opt(i, "가격"),
    });
  },
  거래수락: (i, env) => acceptOffer(env, uid(i), opt(i, "번호")),
  거래거절: (i, env) => cancelOffer(env, uid(i), opt(i, "번호"), "buyer"),
  거래취소: (i, env) => cancelOffer(env, uid(i), opt(i, "번호"), "seller"),
  경매등록: (i, env) => createAuction(env, uid(i), { name: String(opt(i, "종목") ?? "").trim(), qty: opt(i, "수량"), start: opt(i, "시작가"), hours: opt(i, "시간") }),
  입찰: (i, env) => placeBid(env, uid(i), opt(i, "번호"), opt(i, "금액")),
  경매취소: (i, env) => cancelAuction(env, uid(i), opt(i, "번호")),
  장터: (i, env) => marketView(env, uid(i)),
};

// ---------- 자동완성 (내 담당이 아니면 null을 돌려줘서 기존 자동완성이 처리해요) ----------
const pick = (list, keyword) => {
  const k = keyword.toLowerCase();
  return list
    .filter((c) => !k || String(c.label).toLowerCase().includes(k) || String(c.value).toLowerCase().includes(k))
    .slice(0, 25)
    .map((c) => ({ name: String(c.label).slice(0, 100), value: c.value }));
};

export async function marketAutocomplete(interaction, env) {
  const cmd = interaction.data.name;
  if (!MARKET_COMMANDS.has(cmd)) return null;
  const focused = interaction.data.options?.find((o) => o.focused);
  if (!focused) return [];
  const keyword = String(focused.value ?? "").trim();
  const userId = interaction.member?.user?.id;
  if (!userId) return [];
  const val = (name) => interaction.data.options?.find((o) => o.name === name)?.value;

  // 종목: 내 보유 종목 (일반 종목만)
  if (focused.name === "종목") {
    const [user, stocks] = await Promise.all([getUser(env, userId), listStocksForAutocomplete(env)]);
    const byName = new Map(stocks.map((s) => [s.name, s]));
    const list = Object.entries(user.holdings)
      .filter(([name, q]) => q > 0 && byName.has(name) && !isForeign(byName.get(name)))
      .map(([name, q]) => ({ label: `${name} · 보유 ${num(q)}주 · 현재가 ${num(byName.get(name).price)}`, value: name }));
    return pick(list, keyword);
  }

  // 가격/시작가: 시세 합계를 기준으로 예시
  if (focused.name === "가격" || focused.name === "시작가") {
    const name = String(val("종목") ?? "").trim();
    const qty = Number(val("수량")) || 1;
    const stocks = await listStocksForAutocomplete(env);
    const s = stocks.find((x) => x.name === name);
    if (!s) return [];
    const base = s.price * qty;
    const rates = focused.name === "시작가" ? [0.5, 0.8, 1] : [0.9, 1, 1.1, 1.3];
    const list = rates.map((r) => {
      const v = Math.max(1, Math.round(base * r));
      return { label: `${num(v)}해정 (시세 합계 ${num(base)}의 ${Math.round(r * 100)}%)`, value: v };
    });
    return pick(list, keyword);
  }

  // 번호: 명령어에 맞는 항목만
  if (focused.name === "번호") {
    const items = Object.values((await readMarket(env)).items);
    const now = Date.now();
    let list = [];
    if (cmd === "거래수락" || cmd === "거래거절") list = items.filter((i) => i.type === "offer" && i.to === userId);
    else if (cmd === "거래취소") list = items.filter((i) => i.type === "offer" && i.seller === userId);
    else if (cmd === "입찰") list = items.filter((i) => i.type === "auction" && i.seller !== userId && i.end > now);
    else if (cmd === "경매취소") list = items.filter((i) => i.type === "auction" && i.seller === userId && !i.bidder);
    return pick(
      list.map((i) => ({
        label:
          i.type === "offer"
            ? `#${i.id} ${i.name} ${num(i.qty)}주 · ${num(i.price)}해정`
            : `#${i.id} ${i.name} ${num(i.qty)}주 · ${i.bid > 0 ? `최고가 ${num(i.bid)}` : `시작가 ${num(i.start)}`}`,
        value: i.id,
      })),
      keyword
    );
  }

  // 입찰 금액: 지금 낼 수 있는 최소 금액부터 예시
  if (cmd === "입찰" && focused.name === "금액") {
    const id = val("번호");
    const a = id ? (await readMarket(env)).items[String(id)] : null;
    if (!a || a.type !== "auction") return [];
    const min = minBidOf(a);
    const list = [1, 1.1, 1.3, 1.5].map((r, idx) => {
      const v = idx === 0 ? min : Math.ceil(min * r);
      return { label: idx === 0 ? `${num(v)}해정 (최소 입찰)` : `${num(v)}해정`, value: v };
    });
    return pick(list, keyword);
  }
  return [];
}