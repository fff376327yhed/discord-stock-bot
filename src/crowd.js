// 봇 군중(crowd): 봇 수천 명을 문서 몇 개에 몰아서 저장하고, 매 시세 변동 때 메모리에서만 거래시켜요.
// - 봇은 users 컬렉션에 없어서 /랭킹, 알림 DM, 전체 유저 조회에 전혀 섞이지 않아요.
// - 봇의 순매수 압력이 종목 변동률에 더해져 시세에 영향을 줘요. (CROWD_INFLUENCE=0 이면 영향 없음)
//
// 환경변수 (Vercel):
//   CROWD_BOTS       봇 수 (기본 200, 0이면 꺼짐)
//   CROWD_INFLUENCE  시세 영향 계수 (기본 0). 봇 전체가 한 종목을 100% 순매수하면 +이 값(%p)만큼 더해져요. 상한 ±IMPACT_CAP

import { listStocks, getPriceHistory, DANGER_PRICE, compareKo } from "./economy.js";
import { getDoc, setDoc } from "./firebase.js";

const BOTS_PER_DOC = 1700; // 문서 1개당 봇 수 (5000명이면 문서 3개)
const START_CASH = 1000; // 봇 시작/재지급 해정 (유저 시작 잔고와 동일)
const ACT_RATE = 0.3; // 한 번 변동 때 행동하는 봇 비율
const IMPACT_CAP = 10; // 봇이 한 번에 줄 수 있는 최대 영향 (%p)

const docPath = (i) => `bots/crowd_${i + 1}`;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function num(v, d) {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
}

export function crowdConfig() {
  return {
    total: Math.max(0, Math.floor(num(process.env.CROWD_BOTS, 200))),
    influence: num(process.env.CROWD_INFLUENCE, 0),
  };
}

// 봇 1명: c=현금, h=보유 {종목: 수량}, s=성격(0 모멘텀 / 1 줍줍 / 2 랜덤), k=민감도(0.5~1.5, 임계값 배율)
function makeBot() {
  return { c: START_CASH, h: {}, s: Math.floor(Math.random() * 3), k: Math.round((0.5 + Math.random()) * 100) / 100 };
}

// 봇 문서들을 읽어 [[bot...], [bot...]] 로 돌려줘요. 부족하면 새로 만들고, 넘치면 자름
async function loadBots(env, total) {
  const chunks = Math.ceil(total / BOTS_PER_DOC);
  const docs = await Promise.all(Array.from({ length: chunks }, (_, i) => getDoc(env, docPath(i))));
  return docs.map((doc, i) => {
    let bots = [];
    try {
      bots = JSON.parse((doc && doc.data) || "[]");
    } catch {
      bots = [];
    }
    const want = Math.min(BOTS_PER_DOC, total - i * BOTS_PER_DOC);
    while (bots.length < want) bots.push(makeBot());
    bots.length = want;
    return bots;
  });
}

// 필드가 수천 개가 되면 요청 주소가 너무 길어지니, 문서당 문자열 필드 1개(data)로 저장해요
async function saveBots(env, docs) {
  await Promise.all(docs.map((bots, i) => setDoc(env, docPath(i), { data: JSON.stringify(bots) })));
}

// 직전 시세 대비 변동률(%)
function changeOf(s) {
  const pts = getPriceHistory(s);
  const prev = pts.length >= 2 ? pts[pts.length - 2].p : s.price;
  return prev > 0 ? ((s.price - prev) / prev) * 100 : 0;
}

// 봇 1명의 행동 (메모리에서만 체결, 체결가 = 변동 전 현재가)
function act(bot, ctx, tally) {
  if (Math.random() > ACT_RATE) return;
  const { byName, tradable, byUp, byDown } = ctx;
  const held = Object.keys(bot.h);
  let sell = null;
  let buy = null;

  if (bot.s === 0) {
    // 모멘텀: 떨어진 보유 종목은 손절, 오르는 종목(상위 3개 중 랜덤)을 매수
    sell = held.find((n) => byName[n].pct < -10 * bot.k) || null;
    const c = pick(byUp.slice(0, 3));
    if (c && c.pct > 3 * bot.k) buy = c;
  } else if (bot.s === 1) {
    // 줍줍: 오른 보유 종목은 익절, 많이 떨어진 종목(하위 3개 중 랜덤)을 매수
    sell = held.find((n) => byName[n].pct > 15 * bot.k) || null;
    const c = pick(byDown.slice(0, 3));
    if (c && c.pct < -10 * bot.k) buy = c;
  } else {
    // 랜덤
    if (held.length && Math.random() < 0.5) sell = pick(held);
    else buy = pick(tradable) || null;
  }

  if (sell) {
    const have = bot.h[sell];
    const qty = Math.random() < 0.5 ? have : Math.ceil(have / 2);
    bot.c += qty * byName[sell].price;
    if (qty >= have) delete bot.h[sell];
    else bot.h[sell] = have - qty;
    tally[sell].sell++;
  }

  if (buy && buy.name !== sell) {
    const qty = Math.floor((bot.c * (0.1 + Math.random() * 0.3)) / buy.price);
    if (qty >= 1) {
      bot.c -= qty * buy.price;
      bot.h[buy.name] = (bot.h[buy.name] || 0) + qty;
      tally[buy.name].buy++;
    }
  }
}

// ---------- 시세 변동 "전"에 호출 ----------
// 봇 주문을 모아 체결하고, 종목별 시세 영향(impact: { 종목: %p })을 계산해요.
// 꺼져 있으면(봇 0명) null 을 돌려줘요.
export async function prepareCrowd(env) {
  const { total, influence } = crowdConfig();
  if (total <= 0) return null;

  const [docs, stocks] = await Promise.all([loadBots(env, total), listStocks(env)]);
  if (stocks.length === 0) return null;

  const rows = stocks.map((s) => ({ name: s.name, price: s.price, pct: changeOf(s) }));
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const tradable = rows.filter((r) => r.price > DANGER_PRICE); // 폐지 위기 종목은 안 삼
  const ctx = {
    byName,
    tradable,
    byUp: [...tradable].sort((a, b) => b.pct - a.pct),
    byDown: [...tradable].sort((a, b) => a.pct - b.pct),
  };
  const tally = Object.fromEntries(rows.map((r) => [r.name, { buy: 0, sell: 0 }]));

  for (const bots of docs) {
    for (const bot of bots) {
      // 사라진 종목(관리자 삭제 등) 보유분 정리
      for (const n of Object.keys(bot.h)) if (!byName[n]) delete bot.h[n];
      // 빈털터리 봇은 재지급
      if (bot.c < 100 && Object.keys(bot.h).length === 0) bot.c = START_CASH;
      act(bot, ctx, tally);
    }
  }

  const impact = {};
  let trades = 0;
  for (const [name, t] of Object.entries(tally)) {
    trades += t.buy + t.sell;
    if (influence === 0) continue;
    const pressure = (t.buy - t.sell) / total; // -1 ~ 1
    impact[name] = Math.max(-IMPACT_CAP, Math.min(IMPACT_CAP, pressure * influence));
  }

  return { docs, impact, summary: { bots: total, trades, influence } };
}

// ---------- 시세 변동 "후"에 호출 ----------
// 상장폐지된 종목을 봇 보유분에서 지우고 저장해요.
export async function finishCrowd(env, crowd, changes) {
  const delisted = changes.filter((c) => c.delisted).map((c) => c.name);
  if (delisted.length) {
    for (const bots of crowd.docs) for (const bot of bots) for (const n of delisted) delete bot.h[n];
  }
  await saveBots(env, crowd.docs);
}

// ---------- /봇현황 ----------
export async function getCrowdStats(env) {
  const { total, influence } = crowdConfig();
  if (total <= 0) return "지금은 AI 봇이 꺼져 있어요.";

  const [docs, stocks] = await Promise.all([loadBots(env, total), listStocks(env)]);
  const price = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const held = {};
  let sum = 0;
  let n = 0;
  for (const bots of docs) {
    for (const bot of bots) {
      let v = bot.c;
      for (const [name, qty] of Object.entries(bot.h)) {
        v += (price[name] || 0) * qty;
        held[name] = (held[name] || 0) + qty;
      }
      sum += v;
      n++;
    }
  }
  const top = Object.entries(held)
    .filter(([name]) => price[name] !== undefined)
    .sort((a, b) => b[1] - a[1] || compareKo(a[0], b[0]))
    .slice(0, 5)
    .map(([name, qty], i) => `${i + 1}. ${name} (${qty.toLocaleString()}주)`);

  return [
    "**🤖 AI 봇 현황**",
    `참여 봇: ${n.toLocaleString()}명 · 시세 영향 계수 ${influence}`,
    `봇 평균 총자산: ${Math.round(sum / Math.max(n, 1)).toLocaleString()}해정`,
    "봇이 많이 들고 있는 종목:",
    ...(top.length ? top : ["(아직 없음)"]),
  ].join("\n");
}