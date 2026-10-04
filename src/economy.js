import { getDoc, setDoc, deleteDoc, listCollection } from "./firebase.js";

const STARTING_BALANCE = 1000; // 신규 유저 기본 지급 해정

export async function listStocks(env) {
  return listCollection(env, "stocks");
}

export async function getStock(env, name) {
  return getDoc(env, `stocks/${encodeURIComponent(name)}`);
}

export async function upsertStock(env, name, price) {
  await setDoc(env, `stocks/${encodeURIComponent(name)}`, {
    name,
    price,
    updatedAt: new Date(),
  });
}

export async function removeStock(env, name) {
  await deleteDoc(env, `stocks/${encodeURIComponent(name)}`);
}

export async function getUser(env, userId) {
  let user = await getDoc(env, `users/${userId}`);
  if (!user) {
    user = { balance: STARTING_BALANCE, holdings: {} };
    await setDoc(env, `users/${userId}`, user);
  }
  if (!user.holdings) user.holdings = {};
  return user;
}

export async function saveUser(env, userId, user) {
  await setDoc(env, `users/${userId}`, user);
}

export async function buyStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  const cost = stock.price * qty;
  if (user.balance < cost) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${cost.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  user.balance -= cost;
  user.holdings[stockName] = (user.holdings[stockName] || 0) + qty;
  await saveUser(env, userId, user);

  return { ok: true, message: `${stockName} ${qty}주 매수 완료 (-${cost.toLocaleString()}해정)`, user };
}

export async function sellStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  const held = user.holdings[stockName] || 0;
  if (held < qty) {
    return { ok: false, message: `보유 수량이 부족해요. (보유: ${held}주)` };
  }

  const earned = stock.price * qty;
  user.holdings[stockName] = held - qty;
  if (user.holdings[stockName] === 0) delete user.holdings[stockName];
  user.balance += earned;
  await saveUser(env, userId, user);

  return { ok: true, message: `${stockName} ${qty}주 매도 완료 (+${earned.toLocaleString()}해정)`, user };
}

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
