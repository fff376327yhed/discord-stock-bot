import { getDoc, setDoc, listCollection } from "./firebase.js";
import { listStocks, buyStock, sellStock, addHistory } from "./economy.js";
import { sendDM } from "./notify.js";

// ---------- 예약 매수/매도 (지정가 주문) ----------
// orders/{유저ID} 문서: { items: { [예약번호]: { stock, side, qty, price, at } } }
//  - side "buy" : 현재가가 price 이하가 되면 qty주 매수
//  - side "sell": 현재가가 price 이상이 되면 qty주 매도
//
// - 가격은 시세가 변동될 때(평소 변동, 급등락)에만 확인해요.
// - 체결가는 예약가가 아니라 그 순간의 현재가예요. (예약가보다 유리하게 움직였으면 더 유리한 가격으로 체결)
// - 예약할 때 돈이나 주식을 묶어두지 않아요. 체결 시점에 잔고/보유 수량이 모자라면 그 예약은 취소돼요.
// - 예약한 종목이 상장폐지되면 예약은 자동 취소돼요.

export const MAX_ORDERS_PER_USER = 5;

const ordersPath = (userId) => `orders/${userId}`;

// 유저의 예약 맵 { [id]: order }
export async function getOrderItems(env, userId) {
  const doc = await getDoc(env, ordersPath(userId));
  return { ...((doc && doc.items) || {}) };
}

export async function saveOrderItems(env, userId, items) {
  await setDoc(env, ordersPath(userId), { items });
}

// 오래된 예약부터: [{ id, stock, side, qty, price, at }]
export function orderList(items) {
  return Object.entries(items)
    .map(([id, o]) => ({ id, ...o }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

export async function getOrders(env, userId) {
  return orderList(await getOrderItems(env, userId));
}

// 겹치지 않는 4자리 예약번호
export function newOrderId(items) {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 6);
  } while (!id || items[id]);
  return id;
}

export const sideText = (side) => (side === "buy" ? "매수" : "매도");

// 예: **종목A** 800해정 이하가 되면 3주 매수
export function orderText(o) {
  const cond = o.side === "buy" ? "이하가 되면" : "이상이 되면";
  return `**${o.stock}** ${o.price.toLocaleString()}해정 ${cond} ${o.qty.toLocaleString()}주 ${sideText(o.side)}`;
}

// target: 예약번호 또는 "all". 취소된 예약 목록을 돌려줘요.
export async function cancelOrder(env, userId, target) {
  const items = await getOrderItems(env, userId);
  const ids = target === "all" ? Object.keys(items) : items[target] ? [target] : [];
  if (ids.length === 0) return [];

  const removed = ids.map((id) => ({ id, ...items[id] }));
  for (const id of ids) delete items[id];
  await saveOrderItems(env, userId, items);
  return removed;
}

async function safeDM(env, userId, content) {
  try {
    await sendDM(env, userId, content);
  } catch (err) {
    // DM이 막혀 있어도 체결 자체에는 영향 없음 (/내역에는 남아요)
    console.error(`예약 알림 전송 실패 (${userId}):`, err.message);
  }
}

// 시세 변동 직후에 호출: 조건이 맞는 예약을 체결하고 DM으로 알려줘요.
// 반환: { filled: 체결 수, cancelled: 취소 수 }
export async function processOrders(env) {
  const [docs, stocks] = await Promise.all([listCollection(env, "orders"), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const summary = { filled: 0, cancelled: 0 };

  await Promise.all(
    docs.map(async (doc) => {
      const userId = doc.id;
      const items = doc.items || {};

      // 1) 이번에 처리할 예약 고르기: 조건 충족 또는 상장폐지
      const hits = [];
      for (const [id, o] of Object.entries(items)) {
        const price = priceMap[o.stock];
        if (price === undefined) {
          hits.push({ id, o, gone: true });
        } else if (o.side === "buy" ? price <= o.price : price >= o.price) {
          hits.push({ id, o, price });
        }
      }
      if (hits.length === 0) return;

      // 2) 체결 전에 먼저 예약에서 지워서, 중간에 문제가 생겨도 같은 예약이 두 번 체결되지 않게 함
      try {
        const fresh = await getOrderItems(env, userId);
        for (const h of hits) delete fresh[h.id];
        await saveOrderItems(env, userId, fresh);
      } catch (err) {
        console.error(`예약 정리 실패 (${userId}):`, err.message);
        return;
      }

      // 3) 한 명의 예약은 순서대로 체결 (잔고/보유량이 이어지므로)
      for (const h of hits) {
        const label = `${h.o.stock} ${h.o.qty.toLocaleString()}주 ${sideText(h.o.side)}`;
        try {
          if (h.gone) {
            summary.cancelled++;
            await addHistory(env, userId, `예약 취소: ${label} (상장폐지)`);
            await safeDM(env, userId, `⚠️ **[예약 취소]** ${label} 예약이 취소됐어요.\n사유: 상장폐지된 종목이에요.`);
            continue;
          }

          const result =
            h.o.side === "buy"
              ? await buyStock(env, userId, h.o.stock, h.o.qty)
              : await sellStock(env, userId, h.o.stock, h.o.qty);

          if (result.ok) {
            summary.filled++;
            const cond = h.o.side === "buy" ? "이하" : "이상";
            await safeDM(
              env,
              userId,
              [
                `✅ **[예약 체결]** ${label}`,
                `예약가 ${h.o.price.toLocaleString()}해정 ${cond} → 체결가 ${h.price.toLocaleString()}해정`,
                result.message,
              ].join("\n")
            );
          } else {
            summary.cancelled++;
            await addHistory(env, userId, `예약 취소: ${label} (${result.message.split("\n")[0]})`);
            await safeDM(env, userId, `⚠️ **[예약 취소]** ${label} 예약이 조건에 도달했지만 체결하지 못했어요.\n사유: ${result.message}`);
          }
        } catch (err) {
          console.error(`예약 체결 실패 (${userId}, ${label}):`, err.message);
        }
      }
    })
  );

  return summary;
}
