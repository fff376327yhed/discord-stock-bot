// 봇 군중(crowd): 봇 수천 명을 문서 몇 개에 몰아서 저장하고, 매 시세 변동 때 메모리에서만 거래시켜요.
// - 봇은 users 컬렉션에 없어서 /랭킹, 알림 DM, 전체 유저 조회에 전혀 섞이지 않아요.
// - 봇의 순매수 압력이 종목 변동률에 더해져 시세에 영향을 줘요. (CROWD_INFLUENCE=0 이면 영향 없음)
//
// 환경변수 (Vercel):
//   CROWD_BOTS       봇 수 (기본 200, 0이면 꺼짐)
//   CROWD_INFLUENCE  시세 영향 계수 (기본 0). 봇 전체가 한 종목을 100% 순매수하면 +이 값(%p)만큼 더해져요. 상한 ±IMPACT_CAP
//                    (IMPACT_CAP 35 기준 추천: 500 — 봇 200명 중 순매수 14명이면 상한)

import { listStocks, getPriceHistory, DANGER_PRICE, compareKo } from "./economy.js";
import { getDoc, setDoc } from "./firebase.js";

const BOTS_PER_DOC = 1700; // 문서 1개당 봇 수 (5000명이면 문서 3개)
const START_CASH = 1000; // 봇 시작/재지급 해정 (유저 시작 잔고와 동일)
const ACT_RATE = 0.3; // 한 번 변동 때 행동하는 봇 비율 (성격별로 이 값에 배율을 곱해요)
const IMPACT_CAP = 35; // 봇이 한 번에 줄 수 있는 최대 영향 (%p)

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

// 8 고가매수    : "비쌀수록 좋다"는 믿음으로, 추세와 무관하게 가장 비싼 종목 위주로 사요
// 9 저가싹쓸이  : 추세와 무관하게 가장 싼 종목만 골라 양을 많이 사요
// 10 올인러     : 거의 안 움직이다가, 가끔 한 종목에 현금 대부분을 몰빵해요
// 11 소심이     : 아주 소액만 거래하고, 가진 건 거의 안 팔아요
// 12 역발상     : 남들과 반대로 — 오른 보유 종목은 팔고, 떨어진 종목을 사요
// 13 단타족     : 추세 상관없이 자주, 소액으로 사고팔기를 반복해요
// 14 가치투자자 : 최고가 대비 많이 할인된 종목을 사서 오래 묵히고, 회복하면 서서히 정리해요
// 15 도박꾼     : 방향(상승/하락) 상관없이 변동폭이 제일 큰 종목에 크게 베팅해요
// 16 균형러     : 현금 비중이 너무 높으면 사고, 한 종목 비중이 너무 크면 정리해요
// 17 관망러     : 웬만해선 안 움직이다가, 아주 큰 폭락·급등일 때만 확실하게 베팅해요
// 18 컬렉터     : 안 가진 종목을 가격 안 가리고 1주씩이라도 모으는 수집가예요
// 19 물타기     : 떨어진 보유 종목을 더 사서 평단을 낮춰요
// 20 돌파매매   : 최고가에 근접한 종목을 사고, 최고가 대비 15% 빠지면 정리해요
// 21 신상털이   : 시세 기록이 적은(갓 상장된) 종목 위주로 사요
// 22 시장추종   : 시장 평균이 오르면 사고, 내리면 일부 정리해요
// 23 짝사랑     : 본명 종목 하나를 정해 두고 계속 사 모아요 (폐지되면 새로 정함)
// 24 펌프앤덤프 : 평소엔 조용하다가 싼 종목에 몰빵, 오르면 전량 매도해요
// 25 복권러     : 폐지 위기 종목에 소액으로 한 방을 노려요
const PERSONALITY_COUNT = 26;
const PERSONALITY_NAMES = [
  "모멘텀",
  "줍줍",
  "랜덤",
  "존버",
  "공포매도",
  "추격매수",
  "분산투자",
  "익절러",
  "고가매수",
  "저가싹쓸이",
  "올인러",
  "소심이",
  "역발상",
  "단타족",
  "가치투자자",
  "도박꾼",
  "균형러",
  "관망러",
  "컬렉터",
  "물타기",
  "돌파매매",
  "신상털이",
  "시장추종",
  "짝사랑",
  "펌프앤덤프",
  "복권러",
];
// 성격별 "행동 확률" 배율 (ACT_RATE에 곱해짐). 1보다 크면 더 자주, 작으면 덜 자주 움직여요.
const ACT_RATE_MULT = [1, 1, 1, 0.25, 1.3, 1.4, 0.9, 1.2, 0.8, 0.8, 0.15, 0.4, 1, 1.6, 0.5, 0.7, 0.6, 0.1, 0.5, 0.8, 0.9, 0.9, 1.0, 0.7, 0.3, 0.6];

// 봇 1명: c=현금, h=보유 {종목: 수량}, s=성격, k=민감도(0.5~1.5, 임계값 배율), f=짝사랑 종목(선택)
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
    case 8: {
      // 고가매수: 추세 무관, 가장 비싼 종목 위주로 매수
      const expensive = pick([...tradable].sort((a, b) => b.price - a.price).slice(0, 5));
      if (expensive) doBuy(bot, expensive, 0.1 + Math.random() * 0.2, ctx, tally);
      break;
    }
    case 9: {
      // 저가싹쓸이: 추세 무관, 가장 싼 종목을 많이 매수
      const cheap = pick([...tradable].sort((a, b) => a.price - b.price).slice(0, 5));
      if (cheap) doBuy(bot, cheap, 0.2 + Math.random() * 0.3, ctx, tally);
      break;
    }
    case 10: {
      // 올인러: 거의 안 움직이다가 가끔 한 종목에 현금 대부분을 몰빵
      if (Math.random() < 0.9) break;
      doBuy(bot, pick(tradable), 0.7 + Math.random() * 0.3, ctx, tally);
      break;
    }
    case 11: {
      // 소심이: 아주 소액만 거래, 거의 안 팔아요
      if (held.length && Math.random() < 0.05) {
        const sell = pick(held);
        doSell(bot, sell, Math.max(1, Math.floor(bot.h[sell] * 0.1)), ctx, tally);
        break;
      }
      doBuy(bot, pick(tradable), 0.02 + Math.random() * 0.03, ctx, tally);
      break;
    }
    case 12: {
      // 역발상: 오른 보유 종목은 팔고, 떨어진 종목을 사요 (모멘텀의 반대)
      const sellWinner = held.find((n) => byName[n].pct > 5 * bot.k);
      if (sellWinner) doSell(bot, sellWinner, bot.h[sellWinner], ctx, tally);
      const buyLoser = pick(byDown.slice(0, 3));
      if (buyLoser && buyLoser.pct < -3 * bot.k) doBuy(bot, buyLoser, 0.1 + Math.random() * 0.3, ctx, tally);
      break;
    }
    case 13: {
      // 단타족: 추세 상관없이 자주, 소액으로 사고팔기를 반복
      if (held.length && Math.random() < 0.5) {
        const sell = pick(held);
        doSell(bot, sell, Math.max(1, Math.ceil(bot.h[sell] * (0.3 + Math.random() * 0.4))), ctx, tally);
      } else {
        doBuy(bot, pick(tradable), 0.05 + Math.random() * 0.15, ctx, tally);
      }
      break;
    }
    case 14: {
      // 가치투자자: 최고가 대비 많이 할인된 종목을 저가매수, 거의 회복하면 일부 정리
      const discounted = tradable.filter(
        (s) => s.maxPrice > 0 && (s.maxPrice - s.price) / s.maxPrice > 0.4 * bot.k
      );
      const buy = pick(discounted);
      if (buy) doBuy(bot, buy, 0.15 + Math.random() * 0.25, ctx, tally);
      const recovered = held.find(
        (n) => byName[n].maxPrice > 0 && (byName[n].maxPrice - byName[n].price) / byName[n].maxPrice < 0.1
      );
      if (recovered) doSell(bot, recovered, Math.ceil(bot.h[recovered] / 3), ctx, tally);
      break;
    }
    case 15: {
      // 도박꾼: 방향 상관없이 변동폭이 가장 큰 종목에 크게 베팅
      const wild = pick([...tradable].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 5));
      if (wild) doBuy(bot, wild, 0.4 + Math.random() * 0.5, ctx, tally);
      break;
    }
    case 16: {
      // 균형러: 현금 비중이 너무 높으면 사고, 한 종목 비중이 너무 크면 정리
      const stockValue = held.reduce((sum, nm) => sum + bot.h[nm] * (byName[nm]?.price || 0), 0);
      const totalValue = bot.c + stockValue;
      if (totalValue <= 0) break;
      if (bot.c / totalValue > 0.6) {
        doBuy(bot, pick(tradable), 0.2 + Math.random() * 0.2, ctx, tally);
      } else {
        const heavy = held.find((n) => (bot.h[n] * (byName[n]?.price || 0)) / totalValue > 0.4);
        if (heavy) doSell(bot, heavy, Math.ceil(bot.h[heavy] / 2), ctx, tally);
      }
      break;
    }
    case 17: {
      // 관망러: 웬만해선 안 움직이고, 아주 큰 폭락·급등일 때만 확실하게 베팅
      const bigDrop = pick(byDown.filter((s) => s.pct < -20 * bot.k));
      if (bigDrop) {
        doBuy(bot, bigDrop, 0.3 + Math.random() * 0.3, ctx, tally);
        break;
      }
      const bigRise = held.find((n) => byName[n].pct > 20 * bot.k);
      if (bigRise) doSell(bot, bigRise, bot.h[bigRise], ctx, tally);
      break;
    }
    case 18: {
      // 컬렉터: 안 가진 종목을 가격 안 가리고 1주씩이라도 모아요
      const notHeld = tradable.filter((s) => !bot.h[s.name] && s.price <= bot.c);
      const target = pick(notHeld);
      if (target) {
        bot.c -= target.price;
        bot.h[target.name] = (bot.h[target.name] || 0) + 1;
        tally[target.name].buy++;
      }
      break;
    }
    case 19: {
      // 물타기: 떨어진 보유 종목을 더 사서 평단을 낮춰요
      const dipped = held.filter((n) => byName[n].pct < -5 * bot.k && byName[n].price > DANGER_PRICE);
      if (dipped.length) doBuy(bot, byName[pick(dipped)], 0.2 + Math.random() * 0.2, ctx, tally);
      break;
    }
    case 20: {
      // 돌파매매: 최고가에 근접한 종목을 사고, 최고가 대비 15% 빠지면 정리
      const sell = held.find((n) => (byName[n].maxPrice - byName[n].price) / byName[n].maxPrice > 0.15);
      if (sell) {
        doSell(bot, sell, bot.h[sell], ctx, tally);
        break;
      }
      const near = tradable.filter((s) => s.price >= s.maxPrice * 0.95);
      const buy = pick(near);
      if (buy) doBuy(bot, buy, 0.15 + Math.random() * 0.25, ctx, tally);
      break;
    }
    case 21: {
      // 신상털이: 시세 기록이 적은(갓 상장된) 종목 위주로 매수
      const fresh = [...tradable].sort((a, b) => a.age - b.age).slice(0, 4);
      const buy = pick(fresh);
      if (buy) doBuy(bot, buy, 0.1 + Math.random() * 0.2, ctx, tally);
      break;
    }
    case 22: {
      // 시장추종: 시장 평균이 오르면 사고, 내리면 일부 정리
      if (ctx.avgPct > 0) {
        doBuy(bot, pick(tradable), 0.1 + Math.random() * 0.2, ctx, tally);
      } else if (held.length) {
        const sell = pick(held);
        doSell(bot, sell, Math.ceil(bot.h[sell] / 2), ctx, tally);
      }
      break;
    }
    case 23: {
      // 짝사랑: 본명 종목 하나를 정해 두고 계속 사 모아요 (폐지되면 새로 정함)
      if (!bot.f || !byName[bot.f]) bot.f = pick(tradable)?.name;
      if (bot.f && byName[bot.f]) doBuy(bot, byName[bot.f], 0.05 + Math.random() * 0.15, ctx, tally);
      break;
    }
    case 24: {
      // 펌프앤덤프: 평소엔 조용하다가 싼 종목에 몰빵, 오르면 전량 매도
      const pumped = held.find((n) => byName[n].pct > 10 * bot.k);
      if (pumped) {
        doSell(bot, pumped, bot.h[pumped], ctx, tally);
        break;
      }
      const cheap = [...tradable].sort((a, b) => a.price - b.price)[0];
      if (cheap && held.length === 0) doBuy(bot, cheap, 0.8, ctx, tally);
      break;
    }
    case 25: {
      // 복권러: 폐지 위기 종목에 소액으로 한 방을 노려요
      const lotto = pick(ctx.danger);
      if (lotto) doBuy(bot, lotto, 0.03 + Math.random() * 0.05, ctx, tally);
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

  const rows = stocks.map((s) => ({
    name: s.name,
    price: s.price,
    pct: changeOf(s),
    maxPrice: s.maxPrice || s.price,
    age: getPriceHistory(s).length, // 시세 기록 수 (적을수록 신규 상장)
  }));
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const tradable = rows.filter((r) => r.price > DANGER_PRICE); // 폐지 위기 종목은 안 삼
  const ctx = {
    byName,
    tradable,
    danger: rows.filter((r) => r.price <= DANGER_PRICE), // 폐지 위기 종목 (복권러용)
    avgPct: rows.reduce((sum, r) => sum + r.pct, 0) / rows.length, // 시장 평균 변동률
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