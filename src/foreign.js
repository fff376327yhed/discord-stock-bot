// ============================================================
// [foreign.js] 외국자산(코인·해외주식) 시세 조회 + 해정 가격 계산
// ============================================================
// - lib.js 를 가져오지 않는 "독립 모듈"이에요. (lib.js 가 이 파일을 가져다 써요 → 서로 순환하지 않음)
// - 여기서는 "실제 시세를 가져오기"와 "해정 가격 계산하기"만 해요.
//   Firestore 저장, 상장폐지, 공지 등은 lib.js(fluctuatePrices)가 맡아요. (1단계-3)
//
// 가격 방식 (최대한 실제처럼):
//   해정 가격 = 상장가 × (1 + (현재 실제가 ÷ 기준 실제가 − 1) × 배율)
//   - 기준 실제가(baseReal): 상장 후 처음 받아온 실제 시세
//   - 배율(mult): 1이면 실제와 똑같이, 3이면 3배로 움직여요. (기본 3, 종목마다 바꿀 수 있음)
//   - 가격이 DELIST_PRICE 이하가 되면 일반 종목처럼 상장폐지돼요. (그 판단은 lib.js 에서)
//
// 외국자산 종목 문서에 추가되는 필드:
//   kind      "crypto" | "us"      종류 (코인 / 미국 주식)
//   symbol    "BTC" 등             심볼 (코인은 CoinGecko 아이디를 직접 써도 돼요. 예: "bitcoin")
//   source    "coingecko" | "finnhub"  시세 출처
//   mult      3                    배율
//   startPrice 1000                상장가 (안 적으면 1000)
//   baseReal  실제 가격(USD)        기준 실제가 (첫 시세로 자동 기록)
//   lastReal  실제 가격(USD)        마지막으로 받은 실제 시세
//   quoteAt   밀리초               마지막 실제 시세의 기준 시각
//   stale     true/false           시세 지연 여부 (조회 실패 또는 오래된 시세)

export const FOREIGN_KINDS = ["crypto", "us"];
export const FOREIGN_START_PRICE = 1000; // 상장가 기본값 (LISTING_PRICE 와 같게 유지)
export const DEFAULT_MULT = 3; // 기본 배율
export const QUOTE_STALE_MS = 30 * 60 * 1000; // 실제 시세가 이보다 오래되면 "시세 지연"
export const SUSPECT_RATIO = 2; // 직전 시세보다 이 배수(또는 1/배수)를 넘게 움직이면 API 오류로 의심해요
export const SUSPECT_WINDOW_MS = 6 * 60 * 60 * 1000; // 마지막 시세가 이 시간 안일 때만 의심해요 (오래 못 받았으면 큰 변화도 진짜일 수 있어요)
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60 * 1000; // 같은 조회를 1분 안에 또 하면 API를 다시 부르지 않아요
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";
const FINNHUB_URL = "https://finnhub.io/api/v1/quote";
export const US_MAX_SYMBOLS = 30; // 한 번의 변동에서 조회할 미국 주식 최대 종목 수 (Finnhub 무료 한도: 분당 60번, 종목당 1번)

// 심볼 -> CoinGecko 코인 아이디 (목록에 없는 코인은 CoinGecko 아이디를 심볼 칸에 그대로 적으면 돼요)
export const COIN_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  XRP: "ripple",
  SOL: "solana",
  BNB: "binancecoin",
  DOGE: "dogecoin",
  ADA: "cardano",
  TRX: "tron",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  DOT: "polkadot",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  SHIB: "shiba-inu",
  TON: "the-open-network",
  XLM: "stellar",
  ATOM: "cosmos",
  ETC: "ethereum-classic",
};

// ---------- 종목 판별 ----------
export function isForeign(stock) {
  return !!stock && FOREIGN_KINDS.includes(stock.kind);
}

// 종목 앞에 붙일 아이콘 (표시는 2단계에서 사용)
export function foreignIcon(stock) {
  if (!stock) return "";
  if (stock.kind === "crypto") return "₿";
  if (stock.kind === "us") return "🌐";
  return "";
}

// 심볼 -> CoinGecko 아이디. 모르는 심볼이면 null
export function coinIdOf(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (COIN_IDS[upper]) return COIN_IDS[upper];
  // 목록에 없으면 CoinGecko 아이디(소문자·숫자·하이픈)를 직접 쓴 것으로 봐요
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(raw) ? raw : null;
}

// 미국 주식 심볼(티커) 검사: 영문 대문자로 시작, 숫자·점·하이픈 허용 (예: AAPL, TSLA, BRK.B). 올바르면 대문자로 돌려주고, 아니면 null
export function usSymbolOf(symbol) {
  const upper = String(symbol || "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper) ? upper : null;
}

// 종류에 맞는 심볼 검사: 코인이면 CoinGecko 아이디, 미국 주식이면 티커. 올바르지 않으면 null
export function symbolOfKind(kind, symbol) {
  if (kind === "crypto") return coinIdOf(symbol);
  if (kind === "us") return usSymbolOf(symbol);
  return null;
}

// 종류별 기본 시세 출처
export function defaultSourceOf(kind) {
  return kind === "us" ? "finnhub" : "coingecko";
}

// ---------- 시세 조회 (코인: CoinGecko) ----------
// symbols: ["BTC", "ETH", ...]
// 반환: { quotes: { BTC: { price(USD), at(밀리초), stale } }, errors: [문장...] }
// 절대 예외를 던지지 않아요. (실패하면 quotes 에서 빠지고 errors 에 이유가 남아요 → 호출한 쪽은 직전 가격을 유지)
let quoteCache = { key: "", at: 0, result: null };

// 시세 캐시 비우기 (테스트용. 운영에서는 변동 간격이 15분이라 따로 부를 일이 없어요)
export function clearQuoteCache() {
  quoteCache = { key: "", at: 0, result: null };
}

export async function fetchCoinQuotes(symbols, env = {}, now = Date.now()) {
  const list = [...new Set((symbols || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (list.length === 0) return { quotes: {}, errors: [] };

  const idBySymbol = {};
  const errors = [];
  for (const s of list) {
    const id = coinIdOf(s);
    if (id) idBySymbol[s] = id;
    else errors.push(`${s}: 알 수 없는 심볼`);
  }
  const ids = [...new Set(Object.values(idBySymbol))].sort();
  if (ids.length === 0) return { quotes: {}, errors };

  // 짧은 캐시: 같은 코인 목록을 1분 안에 다시 조회하면 저장된 결과를 써요 (무료 API 호출 횟수 보호)
  const key = ids.join(",");
  if (quoteCache.result && quoteCache.key === key && now - quoteCache.at < CACHE_TTL_MS) {
    return { quotes: { ...quoteCache.result.quotes }, errors: [...errors, ...quoteCache.result.errors] };
  }

  const quotes = {};
  const fetchErrors = [];
  try {
    const headers = { Accept: "application/json" };
    if (env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = env.COINGECKO_API_KEY; // 선택: 무료 데모 키가 있으면 한도가 넉넉해져요
    const url = `${COINGECKO_URL}?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd&include_last_updated_at=true`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`CoinGecko 조회 실패 (${res.status})`);
    const data = await res.json();

    for (const [symbol, id] of Object.entries(idBySymbol)) {
      const row = data?.[id];
      const price = Number(row?.usd);
      if (!Number.isFinite(price) || price <= 0) {
        fetchErrors.push(`${symbol}: 시세 없음`);
        continue;
      }
      const updated = Number(row?.last_updated_at); // 초 단위
      const at = Number.isFinite(updated) && updated > 0 ? updated * 1000 : now;
      quotes[symbol] = { price, at, stale: now - at > QUOTE_STALE_MS };
    }
  } catch (err) {
    fetchErrors.push(err?.name === "TimeoutError" ? "CoinGecko 응답 시간 초과" : err?.message || "CoinGecko 조회 실패");
  }

  // 성공한 결과가 있을 때만 캐시 (전부 실패한 결과는 캐시하지 않고 다음에 바로 다시 시도)
  if (Object.keys(quotes).length > 0) quoteCache = { key, at: now, result: { quotes, errors: fetchErrors } };
  return { quotes, errors: [...errors, ...fetchErrors] };
}

// ---------- 시세 조회 (미국 주식: Finnhub) ----------
// symbols: ["AAPL", "TSLA", ...]   (Finnhub 무료 키가 필요해요: env.FINNHUB_API_KEY)
// 반환: { quotes: { AAPL: { price(USD), at(밀리초), stale } }, errors: [문장...] }
// 절대 예외를 던지지 않아요. (실패하면 quotes 에서 빠지고 errors 에 이유가 남아요 → 호출한 쪽은 직전 가격을 유지)
// - 주의: API 키는 주소에 들어가므로 오류 문장에는 주소를 넣지 않아요.
// - 장이 닫혀 있으면 Finnhub 는 마지막 거래가를 그대로 줘요. 시세 조회 자체가 성공했으면 "지연(stale)"이 아니에요.
//   (장이 닫힌 동안 가격이 안 움직이는 건 정상이라서요. 장 시간 처리는 3단계-2에서 다뤄요.)
let usCache = { key: "", at: 0, result: null };

export function clearUsQuoteCache() {
  usCache = { key: "", at: 0, result: null };
}

export async function fetchUsQuotes(symbols, env = {}, now = Date.now()) {
  const list = [...new Set((symbols || []).map((s) => usSymbolOf(s)).filter(Boolean))];
  if (list.length === 0) return { quotes: {}, errors: [] };
  if (!env.FINNHUB_API_KEY) return { quotes: {}, errors: ["FINNHUB_API_KEY 환경변수가 없어요"] };

  const errors = [];
  let targets = list;
  if (list.length > US_MAX_SYMBOLS) {
    targets = list.slice(0, US_MAX_SYMBOLS);
    errors.push(`미국 주식은 한 번에 ${US_MAX_SYMBOLS}종목까지만 조회해요 (${list.length - US_MAX_SYMBOLS}종목 건너뜀)`);
  }

  const key = [...targets].sort().join(",");
  if (usCache.result && usCache.key === key && now - usCache.at < CACHE_TTL_MS) {
    return { quotes: { ...usCache.result.quotes }, errors: [...errors, ...usCache.result.errors] };
  }

  const quotes = {};
  const fetchErrors = [];
  await Promise.all(
    targets.map(async (symbol) => {
      try {
        const url = `${FINNHUB_URL}?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;
        const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`Finnhub 조회 실패 (${res.status})`);
        const data = await res.json();
        const price = Number(data?.c);
        if (!Number.isFinite(price) || price <= 0) {
          fetchErrors.push(`${symbol}: 시세 없음 (없는 티커이거나 무료로 볼 수 없는 종목)`);
          return;
        }
        const traded = Number(data?.t); // 마지막 거래 시각(초). 없으면 0
        const at = Number.isFinite(traded) && traded > 0 ? traded * 1000 : now;
        quotes[symbol] = { price, at, stale: false };
      } catch (err) {
        fetchErrors.push(`${symbol}: ${err?.name === "TimeoutError" ? "Finnhub 응답 시간 초과" : err?.message || "Finnhub 조회 실패"}`);
      }
    })
  );

  if (Object.keys(quotes).length > 0) usCache = { key, at: now, result: { quotes, errors: fetchErrors } };
  return { quotes, errors: [...errors, ...fetchErrors] };
}

// ---------- 이상한 시세 거르기 ----------
// 상장폐지는 유저 보유분이 사라지는 되돌릴 수 없는 일이라, API 오류로 시세가 갑자기 반토막(또는 두 배)이
// 난 것처럼 보이면 그 시세는 반영하지 않아요. (호출한 쪽은 "시세를 못 받은 것"과 똑같이 처리)
// 마지막 시세로부터 SUSPECT_WINDOW_MS 가 지나면 큰 변화도 진짜일 수 있으니 그대로 반영해요.
export function isSuspectQuote(stock, quote, now = Date.now()) {
  if (!quote || !(quote.price > 0) || !(stock?.lastReal > 0)) return false;
  if (Number.isFinite(stock.quoteAt) && now - stock.quoteAt > SUSPECT_WINDOW_MS) return false;
  const ratio = quote.price / stock.lastReal;
  return ratio > SUSPECT_RATIO || ratio < 1 / SUSPECT_RATIO;
}

// ---------- 해정 가격 계산 ----------
// 반환: 정수 해정 가격(최소 1). real/baseReal 이 올바르지 않으면 null
export function calcForeignPrice({ real, baseReal, mult = DEFAULT_MULT, startPrice = FOREIGN_START_PRICE }) {
  if (!(real > 0) || !(baseReal > 0)) return null;
  const m = Number.isFinite(mult) && mult > 0 ? mult : DEFAULT_MULT;
  const start = Number.isFinite(startPrice) && startPrice > 0 ? startPrice : FOREIGN_START_PRICE;
  const raw = start * (1 + (real / baseReal - 1) * m);
  return Math.max(1, Math.round(raw));
}

// 종목 문서 + 새 실제 시세 -> 이번에 적용할 가격과 저장할 필드
// quote 가 없으면(조회 실패) 가격은 그대로 두고 stale 만 켜요.
// 반환: { price, fields, changed }
//   - price: 새 해정 가격 (정수)
//   - fields: 종목 문서에 같이 저장할 필드 { baseReal, lastReal, quoteAt, stale }
//   - changed: 가격이 바뀌었는지
export function buildForeignUpdate(stock, quote) {
  if (!quote || !(quote.price > 0)) {
    return { price: stock.price, fields: { stale: true }, changed: false };
  }
  // 기준 실제가가 아직 없으면(상장 직후) 첫 시세를 기준으로 삼아요 → 상장가에서 시작
  const baseReal = stock.baseReal > 0 ? stock.baseReal : quote.price;
  const price = calcForeignPrice({
    real: quote.price,
    baseReal,
    mult: stock.mult,
    startPrice: stock.startPrice,
  });
  if (price === null) return { price: stock.price, fields: { stale: true }, changed: false };
  return {
    price,
    fields: { baseReal, lastReal: quote.price, quoteAt: quote.at, stale: !!quote.stale },
    changed: price !== stock.price,
  };
}