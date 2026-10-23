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
const ACT_RATE = 0.3; // 한 번 변동 때 행동하는 봇 비율 (성격별로 이 값에 배율을 곱해요)
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

// ---------- 봇 성격 ----------
// 실제 사람들이 할 법한 다양한 투자 패턴을 흉내내요. 성격마다 "한 번 변동 때 행동할 확률"도 달라서
// 어떤 성격은 자주 거래하고, 어떤 성격은 거의 안 움직여요.
// 0 모멘텀      : 오르는 종목(상위권)을 쫓아 사고, 많이 떨어진 보유 종목은 손절
// 1 역추세/줍줍 : 많이 떨어진 종목을 저가 매수하고, 많이 오른 보유 종목은 적당히 익절
// 2 랜덤        : 별 생각 없이 아무 종목이나 사고팔아요
// 3 존버(장기)  : 아주 가끔만 움직이고, 어지간해선 안 팔아요. 가끔 소액만 추가 매수
// 4 공포매도    : 보유 종목이 조금만 떨어져도 바로 전부 손절 (패닉셀)
// 5 추격매수(FOMO): 오르는 종목이면 상승폭이 작아도 크게 질러요. 과감하고 비합리적인 추격매수
// 6 분산투자    : 아직 안 가진 종목 위주로 골고루 조금씩 사 모아요
// 7 익절러      : 보유 종목이 조금만 올라도 바로 일부를 팔아 이익 실현
const PERSONALITY_COUNT = 8;
const PERSONALITY_NAMES = [
  "모멘텀",
  "줍줍",
  "랜덤",
  "존버",
  "공포매도",
  "추격매수",
  "분산투자",
  "익절러",
];
// 성격별 "행동 확률" 배율 (ACT_RATE에 곱해짐). 1보다 크면 더 자주, 작으면 덜 자주 움직여요.
const ACT_RATE_MULT = [1, 1, 1, 0.25, 1.3, 1.4, 0.9, 1.2];

// 봇 1명: c=현금, h=보유 {종목: 수량}, s=성격, k=민감도(0.5~1.5, 임계값 배율)
function makeBot() {
  return {
    c: START_CASH,
    h: {},
    s: Math.floor(Math.random() * PERSONALITY_COUNT),
    k: Math.round((0.5 + Math.random()) * 100) / 100,
  };
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
    // 예전에 저장된 봇(성격 필드가 옛 범위인 0~2)도 자연스럽게 새 성격을 섞어 쓰도록 둠
    for (const b of bots) {
      if (!Number.isInteger(b.s) || b.s < 0 || b.s >= PERSONALITY_COUNT) {
        b.s = Math.floor(Math.random() * PERSONALITY_COUNT);
      }
      if (!Number.isFinite(b.k)) b.k = 1;
    }
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

// 보유분 중 qty주를 팔고 tally에 기록
function doSell(bot, name, qty, ctx, tally) {
  const have = bot.h[name];
  const amount = Math.min(have, qty);
  if (amount <= 0) return;
  bot.c += amount * ctx.byName[name].price;
  if (amount >= have) delete bot.h[name];
  else bot.h[name] = have - amount;
  tally[name].sell++;
}

// cashFraction 만큼의 현금으로 매수하고 tally에 기록
function doBuy(bot, stock, cashFraction, ctx, tally) {
  if (!stock) return;
  const qty = Math.floor((bot.c * cashFraction) / stock.price);
  if (qty < 1) return;
  bot.c -= qty * stock.price;
  bot.h[stock.name] = (bot.h[stock.name] || 0) + qty;
  tally[stock.name].buy++;
}

// 봇 1명의 행동 (메모리에서만 체결, 체결가 = 변동 전 현재가)
function act(bot, ctx, tally) {
  const mult = ACT_RATE_MULT[bot.s] ?? 1;
  if (Math.random() > ACT_RATE * mult) return;

  const { byName, tradable, byUp, byDown } = ctx;
  const held = Object.keys(bot.h);

  switch (bot.s) {
    case 0: {
      // 모멘텀: 떨어진 보유 종목은 손절, 오르는 종목(상위 3개 중 랜덤)을 매수
      const sell = held.find((n) => byName[n].pct < -10 * bot.k);
      if (sell) doSell(bot, sell, bot.h[sell], ctx, tally);
      const buy = pick(byUp.slice(0, 3));
      if (buy && buy.pct > 3 * bot.k) doBuy(bot, buy, 0.1 + Math.random() * 0.3, ctx, tally);
      break;
    }
    case 1: {
      // 줍줍: 오른 보유 종목은 익절, 많이 떨어진 종목(하위 3개 중 랜덤)을 매수
      const sell = held.find((n) => byName[n].pct > 15 * bot.k);
      if (sell) doSell(bot, sell, Math.ceil(bot.h[sell] / 2), ctx, tally);
      const buy = pick(byDown.slice(0, 3));
      if (buy && buy.pct < -10 * bot.k) doBuy(bot, buy, 0.1 + Math.random() * 0.3, ctx, tally);
      break;
    }
    case 2: {
      // 랜덤: 별 생각 없이 아무 종목이나
      if (held.length && Math.random() < 0.5) {
        const sell = pick(held);
        doSell(bot, sell, Math.random() < 0.5 ? bot.h[sell] : Math.ceil(bot.h[sell] / 2), ctx, tally);
      } else {
        doBuy(bot, pick(tradable), 0.1 + Math.random() * 0.3, ctx, tally);
      }
      break;
    }
    case 3: {
      // 존버: 거의 안 팔고, 가끔 소액만 추가 매수 (보유 종목 추가매수 선호, 없으면 아무거나 조금)
      if (Math.random() < 0.85) break; // 대부분은 그냥 쳐다만 봄
      const holding = held.length ? byName[pick(held)] : null;
      doBuy(bot, holding || pick(tradable), 0.05 + Math.random() * 0.1, ctx, tally);
      break;
    }
    case 4: {
      // 공포매도: 보유 종목이 조금만 떨어져도 바로 전량 손절
      const scared = held.find((n) => byName[n].pct < -3 * bot.k);
      if (scared) {
        doSell(bot, scared, bot.h[scared], ctx, tally);
        break;
      }
      // 무서워서 평소엔 거의 안 삼
      if (Math.random() < 0.8) break;
      doBuy(bot, pick(tradable), 0.05 + Math.random() * 0.1, ctx, tally);
      break;
    }
    case 5: {
      // 추격매수(FOMO): 조금만 올라도 크게 질러요 (과감하고 비합리적)
      const chase = pick(byUp.slice(0, 5));
      if (chase && chase.pct > 0.5 * bot.k) {
        doBuy(bot, chase, 0.3 + Math.random() * 0.4, ctx, tally);
      } else if (held.length && Math.random() < 0.4) {
        // 가끔 급하게 손절도 함
        const sell = held.find((n) => byName[n].pct < -8 * bot.k) || pick(held);
        doSell(bot, sell, bot.h[sell], ctx, tally);
      }
      break;
    }
    case 6: {
      // 분산투자: 아직 안 가진 종목 위주로 조금씩 사 모음
      const notHeld = tradable.filter((s) => !bot.h[s.name]);
      const target = notHeld.length ? pick(notHeld) : pick(tradable);
      doBuy(bot, target, 0.05 + Math.random() * 0.1, ctx, tally);
      // 너무 많은 종목을 들고 있으면 가끔 하나 정리
      if (held.length > 6 && Math.random() < 0.2) {
        const sell = pick(held);
        doSell(bot, sell, bot.h[sell], ctx, tally);
      }
      break;
    }
    case 7: {
      // 익절러: 조금만 올라도 바로 일부 이익 실현
      const winner = held.find((n) => byName[n].pct > 2 * bot.k);
      if (winner) {
        doSell(bot, winner, Math.max(1, Math.floor(bot.h[winner] * (0.3 + Math.random() * 0.4))), ctx, tally);
        break;
      }
      doBuy(bot, pick(tradable), 0.1 + Math.random() * 0.2, ctx, tally);
      break;
    }
    default:
      break;
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
  const personalityCount = Array(PERSONALITY_COUNT).fill(0);
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
      if (Number.isInteger(bot.s) && bot.s >= 0 && bot.s < PERSONALITY_COUNT) personalityCount[bot.s]++;
    }
  }
  const top = Object.entries(held)
    .filter(([name]) => price[name] !== undefined)
    .sort((a, b) => b[1] - a[1] || compareKo(a[0], b[0]))
    .slice(0, 5)
    .map(([name, qty], i) => `${i + 1}. ${name} (${qty.toLocaleString()}주)`);

  const personalityText = PERSONALITY_NAMES.map((label, i) => `${label} ${personalityCount[i].toLocaleString()}명`).join(" · ");

  return [
    "**🤖 AI 봇 현황**",
    `참여 봇: ${n.toLocaleString()}명 · 시세 영향 계수 ${influence}`,
    `봇 평균 총자산: ${Math.round(sum / Math.max(n, 1)).toLocaleString()}해정`,
    `성격 분포: ${personalityText}`,
    "봇이 많이 들고 있는 종목:",
    ...(top.length ? top : ["(아직 없음)"]),
  ].join("\n");
}