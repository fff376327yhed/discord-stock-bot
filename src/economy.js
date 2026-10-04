import { getDoc, setDoc, deleteDoc, listCollection } from "./firebase.js";
import { ensureMinimumStocks } from "./listing.js";

const STARTING_BALANCE = 1000; // 신규 유저 기본 지급 해정
const HISTORY_LIMIT = 30; // 유저당 최근 N건만 보관

// 시세 변동 후 가격이 이 값 이하가 되면 자동 상장폐지 (100해정 이하 = 상장폐지)
export const DELIST_PRICE = 100;

// 상승/하락 표시 (한국식: 오름 = 빨강, 내림 = 파랑)
// 디스코드 서버에 올린 커스텀 이모지(빨간 네모 위 화살표 / 파란 네모 아래 화살표)를 쓰려면
// Vercel 환경변수 UP_EMOJI, DOWN_EMOJI에 `<:stock_up:123456789>` 형식으로 넣으세요.
// 환경변수가 없으면 기본 이모지(🔺 / 🔽)로 보여요.
export const UP_MARK = process.env.UP_EMOJI || "📈";
export const DOWN_MARK = process.env.DOWN_EMOJI || "📉";

// 자동완성 목록처럼 커스텀 이모지가 안 보이는 곳에서 쓰는 기본 이모지
const UP_PLAIN = "📈";
const DOWN_PLAIN = "📉";

// 상장폐지 위기: 폐지 기준(DELIST_PRICE)보다 높고 이 가격 이하일 때 ⚠️ 표시 (300해정 이하)
export const DANGER_PRICE = 300;
export const DANGER_MARK = process.env.DANGER_EMOJI || "⚠️";

export function isDelistDanger(price) {
  return price > DELIST_PRICE && price <= DANGER_PRICE;
}

// 종목 이름 바로 옆에 붙이는 위기 표시: " ⚠️" (위기가 아니면 빈 문자열)
// plain = true면 자동완성 목록용 기본 이모지 사용
export function dangerTag(price, plain = false) {
  if (!isDelistDanger(price)) return "";
  return ` ${plain ? "⚠️" : DANGER_MARK}`;
}

// 한글 가나다순 비교 (정렬용)
export const compareKo = (a, b) => String(a).localeCompare(String(b), "ko");

// ---------- 표시용 헬퍼 ----------
// 부호 붙은 숫자: +1,000 / -1,000 / 0
export function fmtSigned(n) {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toLocaleString()}`;
}

// 손익 문구: "🔺 이득 +2,500해정 (+25.0%)" / "🔽 손해 -500해정 (-5.0%)" / "➖ 본전 0해정 (0.0%)"
// cost = 기준이 되는 매수 원가 (퍼센트 계산용)
// plain = true면 커스텀 이모지 대신 기본 이모지 사용 (자동완성 목록용)
export function profitLabel(profit, cost, plain = false) {
  const UP = plain ? UP_PLAIN : UP_MARK;
  const DOWN = plain ? DOWN_PLAIN : DOWN_MARK;
  const pct = cost > 0 ? (profit / cost) * 100 : 0;
  const mark = profit > 0 ? `${UP} 이득` : profit < 0 ? `${DOWN} 손해` : "➖ 본전";
  const pctSign = pct > 0 ? "+" : "";
  return `${mark} ${fmtSigned(profit)}해정 (${pctSign}${pct.toFixed(1)}%)`;
}

// 보유 중인 종목의 "총 매수 원가".
// 매수 기록(costs)이 있으면 그 값을 쓰고, 이 기능이 생기기 전에 산 종목처럼 기록이 없으면
// 현재가를 매수가로 간주합니다. (그래서 그런 종목은 처음엔 손익이 0으로 보여요)
export function costOf(user, name, currentPrice) {
  const held = user.holdings[name] || 0;
  if (held <= 0) return 0;
  const saved = user.costs && user.costs[name];
  return Number.isFinite(saved) ? saved : held * currentPrice;
}

// 매수 미리보기 (저장 안 함): 명령어 입력 중 자동완성에서 사용
export function previewBuy(user, stock, qty) {
  const cost = stock.price * qty;
  return { ok: user.balance >= cost, cost, after: user.balance - cost };
}

// 매도 미리보기 (저장 안 함): 얼마 들어오고, 이득/손해가 얼마인지
export function previewSell(user, stock, qty) {
  const held = user.holdings[stock.name] || 0;
  if (held < qty) return { ok: false, held };
  const prevCost = costOf(user, stock.name, stock.price);
  const basis = Math.round((prevCost * qty) / held);
  const earned = stock.price * qty;
  return { ok: true, held, earned, basis, profit: earned - basis, after: user.balance + earned };
}

// ---------- 종목 ----------
// 이름순(가나다)으로 정렬해서 반환
export async function listStocks(env) {
  const stocks = await listCollection(env, "stocks");
  return stocks.sort((a, b) => compareKo(a.name, b.name));
}

export async function getStock(env, name) {
  return getDoc(env, `stocks/${encodeURIComponent(name)}`);
}

// 그래프용 시세 기록 최대 개수 (30분마다 변동 + 급등락 기준 약 2일치)
const PRICE_HISTORY_POINTS = 96;

// 종목 문서의 history 맵 -> 시간순 배열: [{ t(밀리초), p(가격) }]
export function getPriceHistory(stock) {
  return Object.entries((stock && stock.history) || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, p]) => ({ t: Number(k), p }));
}

// 종목 등록/가격 변경. 역대 최고가(maxPrice)와 그래프용 시세 기록(history)도 함께 저장해요.
// known: 이미 읽어둔 종목 문서 (시세 변동처럼 방금 읽어온 경우 넘기면 읽기를 아낄 수 있어요)
// 안 넘기면 기존 문서를 읽어서 확인합니다. (관리자 /시세설정, /종목추가 등)
export async function upsertStock(env, name, price, known) {
  const base = known || (await getStock(env, name)) || {};

  const prevMax = Number.isFinite(base.maxPrice) ? base.maxPrice : Number.isFinite(base.price) ? base.price : 0;
  const maxPrice = Math.max(prevMax, price);

  const history = { ...(base.history || {}) };
  // 기록이 없던 기존 종목은 이전 가격을 첫 점으로 넣어서, 바로 그래프를 그릴 수 있게 함
  if (Object.keys(history).length === 0 && Number.isFinite(base.price)) {
    const parsed = Date.parse(base.updatedAt);
    const seedAt = Number.isFinite(parsed) ? parsed : Date.now() - 1;
    history[String(seedAt).padStart(13, "0")] = base.price;
  }
  history[String(Date.now()).padStart(13, "0")] = price;

  const keys = Object.keys(history).sort();
  while (keys.length > PRICE_HISTORY_POINTS) delete history[keys.shift()];

  await setDoc(env, `stocks/${encodeURIComponent(name)}`, {
    name,
    price,
    maxPrice,
    history,
    updatedAt: new Date(),
  });
}

export async function removeStock(env, name) {
  await deleteDoc(env, `stocks/${encodeURIComponent(name)}`);
}

// ---------- 상품 (장식 아이템 등) ----------
// 가격 낮은 순으로 정렬해서 반환 (가격이 같으면 이름순)
export async function listProducts(env) {
  const products = await listCollection(env, "products");
  return products.sort((a, b) => a.price - b.price || compareKo(a.name, b.name));
}

export async function getProduct(env, name) {
  return getDoc(env, `products/${encodeURIComponent(name)}`);
}

export async function upsertProduct(env, name, price, description) {
  await setDoc(env, `products/${encodeURIComponent(name)}`, {
    name,
    price,
    description: description || "",
    updatedAt: new Date(),
  });
}

export async function removeProduct(env, name) {
  await deleteDoc(env, `products/${encodeURIComponent(name)}`);
}

// ---------- 유저 ----------
export async function getUser(env, userId) {
  let user = await getDoc(env, `users/${userId}`);
  if (!user) {
    user = { balance: STARTING_BALANCE, holdings: {}, items: {}, costs: {} };
    await setDoc(env, `users/${userId}`, user);
  }
  if (!user.holdings) user.holdings = {};
  if (!user.items) user.items = {};
  if (!user.costs) user.costs = {};
  return user;
}

export async function saveUser(env, userId, user) {
  await setDoc(env, `users/${userId}`, user);
}

// 관리자 패널에 ID와 같이 표시할 닉네임/이름을 최신으로 저장해둠.
// 명령어를 쓸 때마다 호출하고, 실패해도 명령어 자체는 막지 않음.
export async function touchUsername(env, userId, username) {
  if (!username) return;
  try {
    const existing = await getDoc(env, `users/${userId}`);
    if (!existing) {
      // 신규 유저면 getUser와 동일한 기본값으로 생성
      await setDoc(env, `users/${userId}`, {
        balance: STARTING_BALANCE,
        holdings: {},
        items: {},
        costs: {},
        username,
      });
    } else if (existing.username !== username) {
      await setDoc(env, `users/${userId}`, { username });
    }
  } catch (err) {
    console.error(`유저 이름 저장 실패 (${userId}):`, err.message);
  }
}

// ---------- 거래 기록 ----------
// history/{userId} 문서의 entries 맵에 최근 기록을 저장합니다.
// 키는 "시각_랜덤"이라 정렬하면 시간순이 됩니다. 기록 저장이 실패해도 거래 자체는 막지 않아요.
export async function addHistory(env, userId, text) {
  try {
    const doc = await getDoc(env, `history/${userId}`);
    const entries = (doc && doc.entries) || {};
    const now = Date.now();
    const key = `${String(now).padStart(13, "0")}_${Math.random().toString(36).slice(2, 6)}`;
    entries[key] = { t: now, text };

    const keys = Object.keys(entries).sort();
    while (keys.length > HISTORY_LIMIT) {
      delete entries[keys.shift()];
    }

    await setDoc(env, `history/${userId}`, { entries });
  } catch (err) {
    console.error(`기록 저장 실패 (${userId}):`, err.message);
  }
}

// 최신순으로 limit건 반환: [{ t, text }]
export async function getHistory(env, userId, limit = 10) {
  const doc = await getDoc(env, `history/${userId}`);
  const entries = (doc && doc.entries) || {};
  return Object.entries(entries)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, limit)
    .map(([, v]) => v);
}

// 거래 후 정산된 잔고 문구: 💰 잔고: 10,000 → 12,500해정 (+2,500)
function balanceLine(before, after) {
  const diff = after - before;
  return `💰 잔고: ${before.toLocaleString()} → **${after.toLocaleString()}해정** (${fmtSigned(diff)})`;
}

// ---------- 주식 매수/매도 ----------
export async function buyStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  const cost = stock.price * qty;
  if (user.balance < cost) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${cost.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  // 기존 보유분의 원가를 먼저 구한 뒤(수량 늘리기 전에) 이번 매수 금액을 더함
  const prevCost = costOf(user, stockName, stock.price);
  const balanceBefore = user.balance;

  user.balance -= cost;
  user.holdings[stockName] = (user.holdings[stockName] || 0) + qty;
  user.costs[stockName] = prevCost + cost;

  const totalQty = user.holdings[stockName];
  const avg = Math.round(user.costs[stockName] / totalQty);

  const summary = `${stockName} ${qty}주 매수 완료 (-${cost.toLocaleString()}해정)`;
  // 저장과 기록을 동시에 처리해서 응답 시간을 늘리지 않음
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `매수: ${summary} → 잔고 ${user.balance.toLocaleString()}해정`),
  ]);

  return {
    ok: true,
    message: [
      summary,
      balanceLine(balanceBefore, user.balance),
      `📊 평균 매수가: ${avg.toLocaleString()}해정 (보유 ${totalQty.toLocaleString()}주)`,
    ].join("\n"),
    user,
  };
}

export async function sellStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  const held = user.holdings[stockName] || 0;
  if (held < qty) {
    return { ok: false, message: `보유 수량이 부족해요. (보유: ${held}주)` };
  }

  // 팔 수량만큼의 매수 원가(평균 매수가 기준)를 계산해서 이득/손해를 구함
  const prevCost = costOf(user, stockName, stock.price);
  const basis = Math.round((prevCost * qty) / held);
  const earned = stock.price * qty;
  const profit = earned - basis;
  const balanceBefore = user.balance;

  user.holdings[stockName] = held - qty;
  if (user.holdings[stockName] === 0) {
    delete user.holdings[stockName];
    delete user.costs[stockName];
  } else {
    user.costs[stockName] = prevCost - basis;
  }
  user.balance += earned;
  user.realizedProfit = (user.realizedProfit || 0) + profit;

  const summary = `${stockName} ${qty}주 매도 완료 (+${earned.toLocaleString()}해정)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      `매도: ${summary} · ${profitLabel(profit, basis)} → 잔고 ${user.balance.toLocaleString()}해정`
    ),
  ]);

  return {
    ok: true,
    message: [
      summary,
      balanceLine(balanceBefore, user.balance),
      `📊 이번 매도 손익: ${profitLabel(profit, basis)}`,
    ].join("\n"),
    user,
  };
}

// ---------- 상품 구입 ----------
// 구입 시점의 상품 가격만큼 잔고에서 차감하고, 보유 수량을 1 늘립니다.
export async function buyProduct(env, userId, productName) {
  const product = await getProduct(env, productName);
  if (!product) return { ok: false, message: `"${productName}" 상품을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  if (user.balance < product.price) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${product.price.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  const balanceBefore = user.balance;
  user.balance -= product.price;
  user.items[productName] = (user.items[productName] || 0) + 1;

  const summary = `"${productName}" 구입 완료 (-${product.price.toLocaleString()}해정)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `구입: ${summary} → 잔고 ${user.balance.toLocaleString()}해정`),
  ]);

  return { ok: true, message: `${summary}\n${balanceLine(balanceBefore, user.balance)}` };
}

// 관리자용: 보유 수량을 직접 설정 (0이면 목록에서 제거)
export async function setUserItem(env, userId, productName, count) {
  const user = await getUser(env, userId);
  if (count <= 0) {
    delete user.items[productName];
  } else {
    user.items[productName] = count;
  }
  await saveUser(env, userId, user);
}

// ---------- 랭킹 / 상세 ----------
// 총 자산(해정 잔고 + 보유 종목 평가액) 기준 랭킹
export async function getRanking(env) {
  const [users, stocks] = await Promise.all([
    listCollection(env, "users"),
    listCollection(env, "stocks"),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));

  return users
    .map((u) => {
      const holdingsValue = Object.entries(u.holdings || {}).reduce(
        (sum, [name, qty]) => sum + (priceMap[name] || 0) * qty,
        0
      );
      return { id: u.id, total: (u.balance || 0) + holdingsValue };
    })
    .sort((a, b) => b.total - a.total);
}

// 유저 한 명의 잔고/보유종목/총자산/순위를 한 번에 계산 (/내정보 용)
// 보유 종목은 이름순으로 정렬. 종목별 평가손익, 지난 조회 대비 총자산 증감도 함께 돌려줘요.
// 조회할 때마다 현재 총자산을 저장해 두었다가 다음 조회 때 비교합니다.
export async function getUserDetail(env, userId) {
  const [user, stocks, ranking] = await Promise.all([
    getUser(env, userId),
    listStocks(env),
    getRanking(env),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));

  const holdings = Object.entries(user.holdings)
    .map(([name, qty]) => {
      const price = priceMap[name] || 0;
      const cost = costOf(user, name, price);
      // 매수 기록이 없던 기존 보유분은 이때 현재가 기준으로 기록해 둠
      if (!Number.isFinite(user.costs[name])) user.costs[name] = cost;
      const value = price * qty;
      return { name, qty, price, value, cost, avg: Math.round(cost / qty), profit: value - cost };
    })
    .sort((a, b) => compareKo(a.name, b.name));
  const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const holdingsCost = holdings.reduce((sum, h) => sum + h.cost, 0);
  const totalAsset = user.balance + holdingsValue;
  const rank = ranking.findIndex((r) => r.id === userId) + 1;

  const prevAsset = Number.isFinite(user.lastAsset) ? user.lastAsset : null;
  const prevAssetAt = Number.isFinite(user.lastAssetAt) ? user.lastAssetAt : null;

  user.lastAsset = totalAsset;
  user.lastAssetAt = Date.now();
  await saveUser(env, userId, user);

  return {
    balance: user.balance,
    holdings,
    holdingsValue,
    holdingsCost,
    holdingsProfit: holdingsValue - holdingsCost,
    realizedProfit: user.realizedProfit || 0,
    totalAsset,
    prevAsset,
    prevAssetAt,
    assetChange: prevAsset === null ? null : totalAsset - prevAsset,
    rank,
    totalUsers: ranking.length,
  };
}

// ---------- 상장폐지 ----------
// 종목을 삭제하고, 이 종목을 가진 모든 유저의 보유분을 휴지조각으로 만듭니다.
// 매수 원가 전액을 실현 손실(realizedProfit)로 반영하고, 거래 기록에도 남겨요.
// 폐지 내역(언제, 최고가, 폐지 직전/최종 가격)은 delisted 컬렉션에 저장돼 /상장폐지종류로 볼 수 있어요.
// info: { lastPrice: 폐지 직전 가격, finalPrice: 폐지를 일으킨 변동 후 가격, maxPrice: 역대 최고가, history: 시세 기록 맵 }
// 반환값: 영향받은 유저 ID 목록 (알림 DM용)
export async function delistStock(env, stockName, info) {
  const { lastPrice, finalPrice, maxPrice, history } = info;
  await removeStock(env, stockName);

  const users = await listCollection(env, "users");
  const holders = [];

  for (const u of users) {
    const held = (u.holdings && u.holdings[stockName]) || 0;
    if (held <= 0) continue;

    const holdings = { ...(u.holdings || {}) };
    const costs = { ...(u.costs || {}) };

    // 매수 기록이 없는 보유분은 폐지 직전 가격을 원가로 간주
    const cost = Number.isFinite(costs[stockName]) ? costs[stockName] : held * lastPrice;
    delete holdings[stockName];
    delete costs[stockName];
    const realizedProfit = (u.realizedProfit || 0) - cost;

    try {
      await Promise.all([
        setDoc(env, `users/${u.id}`, { holdings, costs, realizedProfit }),
        addHistory(
          env,
          u.id,
          `상장폐지: ${stockName} ${held.toLocaleString()}주 소멸 (손실 -${cost.toLocaleString()}해정)`
        ),
      ]);
      holders.push(u.id);
    } catch (err) {
      console.error(`상장폐지 정산 실패 (${u.id}, ${stockName}):`, err.message);
    }
  }

  // 폐지 내역 저장 (실패해도 폐지 자체는 막지 않음)
  // 문서 ID 앞부분을 "큰 수 - 현재시각"으로 만들어서, 목록을 불러오면 최신 폐지 종목이 먼저 나와요.
  try {
    const delistedAt = Date.now();
    const key = `${String(9999999999999 - delistedAt).padStart(13, "0")}_${encodeURIComponent(stockName)}`;
    const peak = Math.max(maxPrice || 0, lastPrice);

    // 그래프용 시세 기록: 폐지를 일으킨 마지막 가격까지 포함해서 저장
    const savedHistory = { ...(history || {}) };
    if (Object.keys(savedHistory).length === 0) {
      savedHistory[String(delistedAt - 1).padStart(13, "0")] = lastPrice;
    }
    savedHistory[String(delistedAt).padStart(13, "0")] = finalPrice;

    await setDoc(env, `delisted/${key}`, {
      name: stockName,
      delistedAt,
      lastPrice,
      finalPrice,
      maxPrice: peak,
      holders: holders.length,
      dropPct: dropPctOf(lastPrice, finalPrice), // 폐지된 변동의 하락률(%)
      peakDropPct: dropPctOf(peak, finalPrice), // 역대 최고가 대비 하락률(%)
      maxDropPct: biggestDropPct(savedHistory), // 기록 중 한 번에 가장 크게 떨어진 하락률(%)
      history: savedHistory,
    });
  } catch (err) {
    console.error(`폐지 내역 저장 실패 (${stockName}):`, err.message);
  }

  return holders;
}

// 하락률(%) 계산: from -> to (오른 경우는 0). 소수 첫째 자리까지
export function dropPctOf(from, to) {
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round(((from - to) / from) * 1000) / 10);
}

// 시세 기록(history 맵)에서 한 번에 가장 크게 떨어진 하락률(%)
function biggestDropPct(history) {
  const prices = Object.keys(history || {}).sort().map((k) => history[k]);
  let worst = 0;
  for (let i = 1; i < prices.length; i++) {
    worst = Math.max(worst, dropPctOf(prices[i - 1], prices[i]));
  }
  return worst;
}

// 상장폐지된 종목 목록 (최신 폐지순)
// [{ name, delistedAt, lastPrice, finalPrice, maxPrice, holders, dropPct, peakDropPct, maxDropPct, history }]
// 하락률 필드가 없는 예전 폐지 기록은 저장된 가격으로 다시 계산해서 채워줘요.
export async function listDelisted(env, limit = 10) {
  const list = await listCollection(env, "delisted");
  return list
    .sort((a, b) => (b.delistedAt || 0) - (a.delistedAt || 0))
    .slice(0, limit)
    .map((d) => ({
      ...d,
      dropPct: Number.isFinite(d.dropPct) ? d.dropPct : dropPctOf(d.lastPrice, d.finalPrice),
      peakDropPct: Number.isFinite(d.peakDropPct) ? d.peakDropPct : dropPctOf(d.maxPrice, d.finalPrice),
      maxDropPct: Number.isFinite(d.maxDropPct) ? d.maxDropPct : dropPctOf(d.lastPrice, d.finalPrice),
    }));
}

// 폐지 종목의 그래프용 시세 기록 -> [{ t, p }]
// 기록이 없는 예전 폐지 종목은 (폐지 직전 → 폐지 가격) 두 점만 그려요.
export function getDelistedHistory(d) {
  const points = getPriceHistory(d);
  if (points.length >= 2) return points;
  const at = d.delistedAt || Date.now();
  return [
    { t: at - 1, p: d.lastPrice || 0 },
    { t: at, p: d.finalPrice || 0 },
  ];
}

// ---------- 시세 변동 ----------
// 모든 종목 가격을 minPct~maxPct(%) 범위에서 무작위로 변동시킴 (최저가 1해정 보장)
// 변동 후 가격이 DELIST_PRICE 이하이면 상장폐지 처리합니다.
// 반환: [{ name, before, after, pct, delisted, holders }]
//   - delisted: 상장폐지 여부
//   - holders: 상장폐지된 종목을 보유 중이던 유저 ID 목록 (아니면 빈 배열)
export async function fluctuatePrices(env, { minPct, maxPct }) {
  const stocks = await listStocks(env);
  const changes = [];

  for (const stock of stocks) {
    const pct = minPct + Math.random() * (maxPct - minPct);
    const newPrice = Math.max(1, Math.round(stock.price * (1 + pct / 100)));
    // 최고가 기록이 없던 기존 종목은 지금 가격을 최고가로 시작
    const maxPrice = Math.max(Number.isFinite(stock.maxPrice) ? stock.maxPrice : stock.price, stock.price);

    if (newPrice <= DELIST_PRICE) {
      const holders = await delistStock(env, stock.name, {
        lastPrice: stock.price,
        finalPrice: newPrice,
        maxPrice,
        history: stock.history,
      });
      changes.push({ name: stock.name, before: stock.price, after: newPrice, pct, delisted: true, holders });
      continue;
    }

    await upsertStock(env, stock.name, newPrice, stock);
    changes.push({ name: stock.name, before: stock.price, after: newPrice, pct, delisted: false, holders: [] });
  }

  // 종목 수가 기준 이하로 줄었으면 자동 상장
  await ensureMinimumStocks(env);
  return changes;
}

// ---------- 알림 설정 ----------
export async function setNotify(env, userId, notify) {
  const user = await getUser(env, userId);
  user.notify = notify;
  await saveUser(env, userId, user);
}