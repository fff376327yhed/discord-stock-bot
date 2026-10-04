import { getDoc, setDoc, deleteDoc, listCollection } from "./firebase.js";

const STARTING_BALANCE = 1000; // 신규 유저 기본 지급 해정

// ---------- 종목 ----------
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

// ---------- 상품 (장식 아이템 등) ----------
export async function listProducts(env) {
  return listCollection(env, "products");
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
    user = { balance: STARTING_BALANCE, holdings: {}, items: {} };
    await setDoc(env, `users/${userId}`, user);
  }
  if (!user.holdings) user.holdings = {};
  if (!user.items) user.items = {};
  return user;
}

export async function saveUser(env, userId, user) {
  await setDoc(env, `users/${userId}`, user);
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

// ---------- 상품 구입 ----------
// 구입 시점의 상품 가격만큼 잔고에서 차감하고, 보유 수량을 1 늘립니다.
export async function buyProduct(env, userId, productName) {
  const product = await getProduct(env, productName);
  if (!product) return { ok: false, message: `"${productName}" 상품을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  if (user.balance < product.price) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${product.price.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  user.balance -= product.price;
  user.items[productName] = (user.items[productName] || 0) + 1;
  await saveUser(env, userId, user);

  return { ok: true, message: `"${productName}" 구입 완료 (-${product.price.toLocaleString()}해정)` };
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
export async function getUserDetail(env, userId) {
  const [user, stocks, ranking] = await Promise.all([
    getUser(env, userId),
    listStocks(env),
    getRanking(env),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));

  const holdings = Object.entries(user.holdings).map(([name, qty]) => {
    const price = priceMap[name] || 0;
    return { name, qty, price, value: price * qty };
  });
  const holdingsValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const totalAsset = user.balance + holdingsValue;
  const rank = ranking.findIndex((r) => r.id === userId) + 1;

  return { balance: user.balance, holdings, holdingsValue, totalAsset, rank, totalUsers: ranking.length };
}

// ---------- 시세 변동 ----------
// 모든 종목 가격을 minPct~maxPct(%) 범위에서 무작위로 변동시킴 (최저가 1해정 보장)
export async function fluctuatePrices(env, { minPct, maxPct }) {
  const stocks = await listStocks(env);
  const changes = [];

  for (const stock of stocks) {
    const pct = minPct + Math.random() * (maxPct - minPct);
    const newPrice = Math.max(1, Math.round(stock.price * (1 + pct / 100)));
    await upsertStock(env, stock.name, newPrice);
    changes.push({ name: stock.name, before: stock.price, after: newPrice, pct });
  }

  return changes;
}