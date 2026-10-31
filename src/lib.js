// 통합 라이브러리: env / firebase / listing / economy / actionlog / attendance / mining / chart / crowd / notify / orders / commands
// (예전 src/*.js 12개를 한 파일로 합쳤어요. 파일 안 순서는 의존 순서예요.)
// 외국자산(코인·해외주식) 시세/가격 계산은 별도 파일(foreign.js)에 있어요. (이 파일을 가져오지 않는 독립 모듈)
import { isForeign, foreignIcon, fetchCoinQuotes, fetchUsQuotes, usSymbolOf, buildForeignUpdate, isSuspectQuote, getUsMarketStatus, closedMessage } from "./foreign.js";
import { askGuide } from "./guidebot.js";

// ============================================================
// [env.js]
// ============================================================
// Vercel 프로젝트에 등록해둔 환경변수를 한 곳에서 모아줍니다.
export function loadEnv() {
  return {
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    ADMIN_DISCORD_ID: process.env.ADMIN_DISCORD_ID,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    CRON_SECRET: process.env.CRON_SECRET,
    ADMIN_PANEL_PASSWORD: process.env.ADMIN_PANEL_PASSWORD,
    ALLOWED_CHANNEL_ID: process.env.ALLOWED_CHANNEL_ID,
    COINGECKO_API_KEY: process.env.COINGECKO_API_KEY, // 선택: 코인 시세(CoinGecko) 무료 데모 키
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY, // 미국 주식 시세(Finnhub) 무료 키 (미국 주식 종목이 있을 때만 필요)
  };
}

// Cron 엔드포인트는 외부에 공개된 URL이라, 아무나 호출 못 하도록
// Authorization: Bearer <CRON_SECRET> 헤더를 확인합니다.
// (Vercel 자체 Cron은 이 헤더를 자동으로 붙여서 보내줍니다.)
export function isAuthorizedCron(request, env) {
  if (!env.CRON_SECRET) return false;
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${env.CRON_SECRET}`;
}
// ---------- 급등락 시각 ----------
// 하루 딱 3번: 새벽 12시(0시), 오후 6시, 오후 9시 (한국시간)
const SURGE_SLOTS = [
  { hour: 0, label: "새벽 12시 급등락" },
  { hour: 18, label: "오후 6시 급등락" },
  { hour: 21, label: "오후 9시 급등락" },
];

// 현재 한국시간이 슬롯 시각에서 몇 분 떨어져 있는지 (음수 = 슬롯 전, 양수 = 슬롯 후)
function minutesFromSlot(hour, now) {
  const d = new Date(now + 9 * 60 * 60 * 1000);
  const nowMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((nowMin - hour * 60 + 1440 + 720) % 1440) - 720;
}

// 지금이 급등락 시각이면 { hour, label }, 아니면 null
// 급등락은 슬롯 1분 전 ~ 30분 후 사이에 호출됐을 때만 실행돼요. (외부 스케줄러가 조금 늦거나 빨라도 허용)
// 주의: 시작을 너무 일찍(예: 10분 전) 잡으면 5분 간격 호출 시 정각보다 먼저 급등락이 터져요.
export function currentSurgeSlot(now = Date.now()) {
  for (const s of SURGE_SLOTS) {
    const diff = minutesFromSlot(s.hour, now);
    if (diff >= -1 && diff <= 30) return s;
  }
  return null;
}

// 평소 변동(±50%)을 건너뛸지: 급등락 시각 3분 전 ~ 5분 후에는 평소 변동을 쉬어서 겹치지 않게 해요.
export function isSurgeMoment(now = Date.now()) {
  return SURGE_SLOTS.some((s) => {
    const diff = minutesFromSlot(s.hour, now);
    return diff >= -3 && diff <= 5;
  });
}

// 급등락 슬롯의 "그날 몇 시 슬롯" 고유 키. 예: "2026-10-08-18"
// 새벽 12시 슬롯은 23:50~00:30에 걸쳐 있어서 날짜가 바뀌어도 같은 키가 나오도록 계산해요.
export function surgeSlotKey(slot, now = Date.now()) {
  const shifted = new Date(now + 9 * 60 * 60 * 1000 - slot.hour * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 10)}-${slot.hour}`;
}

// ============================================================
// [firebase.js]
// ============================================================
// Cloudflare Workers 환경에는 firebase-admin SDK가 동작하지 않으므로,
// Firestore REST API를 서비스 계정(JWT) 인증으로 직접 호출합니다.
// 모두 Web Crypto API(crypto.subtle) 기반이라 추가 의존성이 없습니다.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/datastore";

// ---- 내부 유틸: base64url 인코딩 ----
function base64url(bytes) {
  let str = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textToBase64url(text) {
  return base64url(new TextEncoder().encode(text));
}

// PEM 형식 private key -> CryptoKey (RS256 서명용)
async function importPrivateKey(pem) {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// 서비스 계정으로 서명된 JWT를 만들고, Google OAuth 서버에서 access token으로 교환합니다.
async function requestAccessToken(env) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${textToBase64url(JSON.stringify(header))}.${textToBase64url(JSON.stringify(claim))}`;
  const key = await importPrivateKey(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`Firebase 인증 실패: ${await res.text()}`);
  const data = await res.json();
  return { token: data.access_token, expiresIn: data.expires_in || 3600 };
}

// ---- 토큰 캐시 ----
// 같은 서버리스 인스턴스가 살아 있는 동안 토큰을 재사용합니다.
// 동시에 여러 호출이 오면 토큰 요청을 하나로 합칩니다.
let cachedToken = null;
let cachedExpiresAt = 0; // ms
let pendingToken = null;

async function getAccessToken(env) {
  if (cachedToken && Date.now() < cachedExpiresAt - 60_000) return cachedToken;
  if (pendingToken) return pendingToken;

  pendingToken = requestAccessToken(env)
    .then(({ token, expiresIn }) => {
      cachedToken = token;
      cachedExpiresAt = Date.now() + expiresIn * 1000;
      return token;
    })
    .finally(() => {
      pendingToken = null;
    });

  return pendingToken;
}

function baseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// ---- JS 값 <-> Firestore REST 필드 변환 ----
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toValue(v);
  }
  return fields;
}

function toValue(v) {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (v && typeof v === "object") return { mapValue: { fields: toFields(v) } };
  return { nullValue: null };
}

function fromFields(fields = {}) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    obj[k] = fromValue(v);
  }
  return obj;
}

function fromValue(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("mapValue" in v) return fromFields(v.mapValue.fields || {});
  return null;
}

// ---- 공개 함수: 문서 단위 CRUD ----

async function getDoc(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore 조회 실패: ${await res.text()}`);
  const data = await res.json();
  return fromFields(data.fields);
}

async function setDoc(env, path, obj) {
  const token = await getAccessToken(env);
  const fieldPaths = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await fetch(`${baseUrl(env)}/${path}?${fieldPaths}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`Firestore 저장 실패: ${await res.text()}`);
  return true;
}

async function deleteDoc(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Firestore 삭제 실패: ${await res.text()}`);
  return true;
}

async function listCollection(env, collection) {
  const token = await getAccessToken(env);
  // Firestore는 한 번에 일부만 돌려줄 수 있어서, 다음 페이지가 없을 때까지 이어서 읽어요.
  const docs = [];
  let pageToken = "";
  do {
    const query = `pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(`${baseUrl(env)}/${collection}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Firestore 목록 조회 실패: ${await res.text()}`);
    const data = await res.json();
    if (data.documents) docs.push(...data.documents);
    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return docs.map((doc) => ({
    id: doc.name.split("/").pop(),
    ...fromFields(doc.fields),
  }));
}

// 숫자 필드를 "원자적으로" 더해요. (읽지 않고 한 번의 요청으로 처리, 여러 문서·여러 사람이 동시에 더해도 값이 안 사라져요)
// items: [{ path: "stocks/이름", field: "flow", by: 숫자 }]  문서가 없으면 그 항목은 건너뛰어요(생성하지 않음).
async function incrementFields(env, items) {
  if (!items.length) return true;
  const token = await getAccessToken(env);
  const docRoot = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(`${baseUrl(env)}:commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: items.map((it) => ({
        update: { name: `${docRoot}/${it.path}` },
        updateMask: { fieldPaths: [] }, // 다른 필드는 건드리지 않아요
        updateTransforms: [{ fieldPath: it.field, increment: { doubleValue: it.by } }],
        currentDocument: { exists: true },
      })),
    }),
  });
  if (!res.ok) throw new Error(`Firestore 증가 실패: ${await res.text()}`);
  return true;
}

// since < t <= until 범위만 가져오는 쿼리 (컬렉션 전체를 읽지 않아서 읽기 비용을 아껴요)
async function queryByTime(env, collection, since, until) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "t" }, op: "GREATER_THAN", value: { integerValue: String(since) } } },
              { fieldFilter: { field: { fieldPath: "t" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(until) } } },
            ],
          },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Firestore 쿼리 실패: ${await res.text()}`);
  const data = await res.json();
  return data.filter((row) => row.document).map((row) => fromFields(row.document.fields));
}

export { getDoc, setDoc, deleteDoc, listCollection };

// ============================================================
// [listing.js]
// ============================================================
// ---------- 자동 상장 / 유저 상장 설정 (관리자 콘솔 '자동 상장 설정') ----------
// config/listing 문서: { triggerCount, addCount, dailyLimit, names, keepNames }
//  - triggerCount: 종목 수가 이 값 이하가 되면 자동 상장
//  - addCount: 한 번에 자동 상장할 종목 수
//  - dailyLimit: 유저가 하루에 /종목생성 할 수 있는 횟수
//  - names: 자동 상장에 쓸 이름 목록 (줄바꿈 구분)
//  - keepNames: true(기본)면 쓴 이름도 목록에 남기고 맨 뒤로 보냄(= 다음엔 안 쓴 이름부터 상장).
//               false면 예전처럼 쓴 이름을 목록에서 지움.
export const LISTING_PATH = "config/listing";
export const LISTING_PRICE = 1000; // 자동 상장/유저 상장 종목의 고정 가격 (해정)
const DEFAULT_LISTING = { triggerCount: 5, addCount: 15, dailyLimit: 3, names: "", keepNames: true };

export async function getListingConfig(env) {
  const saved = (await getDoc(env, LISTING_PATH)) || {};
  return { ...DEFAULT_LISTING, ...saved };
}

export async function setListingConfig(env, patch) {
  const next = { ...(await getListingConfig(env)), ...patch };
  await setDoc(env, LISTING_PATH, next);
  return next;
}

// 줄바꿈/쉼표로 구분된 이름 목록 -> 배열 (공백 제거, 빈 값과 중복 제외)
export function parseNames(text) {
  return [...new Set(String(text || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean))];
}

// 종목 문서 생성 (economy.js의 upsertStock과 같은 형식)
async function createStock(env, name, price) {
  await setDoc(env, `stocks/${encodeURIComponent(name)}`, {
    name,
    price,
    maxPrice: price,
    fv: price,
    sector: randomSector(), // 자동 상장 종목은 업종을 랜덤으로 배정해요
    volTier: newStockTier(price), // 변동성 등급도 배정해요 (1000해정 상장이면 랜덤)
    listedAt: Date.now(),
    history: { [String(Date.now()).padStart(13, "0")]: price },
    updatedAt: new Date(),
  });
  invalidateStocksCache();
}

// 종목 수가 triggerCount 이하면 names 목록에서 addCount개를 자동 상장
// 반환: { added: [상장된 이름들] }
export async function ensureMinimumStocks(env) {
  const cfg = await getListingConfig(env);
  const stocks = await listStocks(env);
  // 외국자산(코인·해외주식)은 종목 수에 세지 않아요. (상장폐지돼도 자동 상장 기준에 영향 없음)
  if (stocks.filter((s) => !isForeign(s)).length > cfg.triggerCount) return { added: [] };

  // 지금 상장 중인 이름은 제외하고, 목록 앞쪽부터 addCount개를 고름
  const existing = new Set(stocks.map((s) => s.name));
  const pool = parseNames(cfg.names).filter((n) => !existing.has(n));
  const picked = pool.slice(0, cfg.addCount);
  if (picked.length === 0) return { added: [], reason: "상장할 수 있는 이름이 목록에 없어요" };

  // 동시에 상장 (하나씩 하면 느려서 서버리스 시간 제한에 걸릴 수 있어요)
  const results = await Promise.allSettled(picked.map((name) => createStock(env, name, LISTING_PRICE)));
  const added = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") added.push(picked[i]);
    else console.error(`자동 상장 실패 (${picked[i]}):`, r.reason?.message);
  });
  // 상장에 실패한 이름은 목록에 그대로 남겨둠
  if (added.length === 0) return { added: [], reason: "자동 상장에 모두 실패했어요" };

  // 저장 직전에 설정을 다시 읽어서, 그 사이 관리자가 고친 이름 목록/설정을 옛날 값으로 덮어쓰지 않게 함
  const fresh = await getListingConfig(env);
  const names = parseNames(fresh.names);
  const used = new Set(added);
  const next = fresh.keepNames
    ? [...names.filter((n) => !used.has(n)), ...names.filter((n) => used.has(n))] // 쓴 이름은 맨 뒤로
    : names.filter((n) => !used.has(n)); // 쓴 이름은 삭제
  await setDoc(env, LISTING_PATH, { names: next.join("\n") });
  return { added };
}

// ============================================================
// [economy.js]
// ============================================================
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

// ---------- 거래 수수료·세금 ----------
// 주식을 사고팔 때마다 거래 금액의 0.3%를 떼요. (올림, 최소 1해정, 떼간 돈은 사라져요)
//  - 매수: (주가 × 수량) + 수수료를 내고, 수수료도 매수 원가에 들어가요. (평균 매수가에 반영)
//  - 매도: (주가 × 수량) − 수수료를 받아요. 손익도 수수료를 뺀 금액 기준이에요.
// 퍼센트를 바꾸려면 아래 숫자(천분율)만 바꾸면 돼요. 3 = 0.3%, 0이면 수수료 없음.
export const TRADE_FEE_PERMILLE = 3;
export const TRADE_FEE_TEXT = `${TRADE_FEE_PERMILLE / 10}%`;

export const tradeFee = (amount) => (TRADE_FEE_PERMILLE > 0 ? Math.max(1, Math.ceil((amount * TRADE_FEE_PERMILLE) / 1000)) : 0);

// 증권거래세: 주식을 "팔 때만" 떼요. (국내 종목만, 코인·해외주식은 없음. 올림, 최소 1해정, 떼간 돈은 사라져요)
// 퍼센트를 바꾸려면 아래 숫자(천분율)만 바꾸면 돼요. 2 = 0.2%, 0이면 거래세 없음.
export const SELL_TAX_PERMILLE = 2;
export const SELL_TAX_TEXT = `${SELL_TAX_PERMILLE / 10}%`;
export const sellTax = (stock, amount) =>
  SELL_TAX_PERMILLE > 0 && !isForeign(stock) ? Math.max(1, Math.ceil((amount * SELL_TAX_PERMILLE) / 1000)) : 0;

// 잔고로 살 수 있는 최대 수량 (수수료 포함해서 잔고를 넘지 않는 가장 큰 값)
export function maxBuyQty(balance, price) {
  if (!(price > 0) || balance <= 0) return 0;
  let q = Math.floor(balance / price);
  while (q > 0 && price * q + tradeFee(price * q) > balance) q--;
  return q;
}

// 매수 미리보기 (저장 안 함): 명령어 입력 중 자동완성에서 사용 (cost는 수수료 포함 금액)
export function previewBuy(user, stock, qty) {
  const fee = tradeFee(stock.price * qty);
  const cost = stock.price * qty + fee;
  const have = isForeign(stock) ? user.usd || 0 : user.balance; // 외국자산은 달러(센트)로 계산
  return { ok: have >= cost, cost, fee, after: have - cost };
}

// 매도 미리보기 (저장 안 함): 얼마 들어오고, 이득/손해가 얼마인지
export function previewSell(user, stock, qty) {
  const held = user.holdings[stock.name] || 0;
  if (held < qty) return { ok: false, held };
  const prevCost = costOf(user, stock.name, stock.price);
  const basis = Math.round((prevCost * qty) / held);
  const fee = tradeFee(stock.price * qty);
  const tax = sellTax(stock, stock.price * qty);
  const earned = stock.price * qty - fee - tax; // 수수료·거래세를 뺀 실수령액
  const have = isForeign(stock) ? user.usd || 0 : user.balance;
  return { ok: true, held, earned, fee, tax, basis, profit: earned - basis, after: have + earned };
}

// ---------- 종목 ----------
// 이름순(가나다)으로 정렬해서 반환
// 짧은 캐시: 크론 한 번 안에서 여러 번 불러도 읽기는 최소화돼요. (종목을 쓰거나 지우면 자동으로 비워져요)
let stocksCache = { at: 0, list: null };
const STOCKS_TTL_MS = 10_000;

// 자동완성 전용 종목 캐시 (60초): 칸을 누르거나 글자를 칠 때마다 불려서 읽기를 많이 먹어요.
// 목록에 보이는 가격이 최대 60초 늦을 수 있지만, 실제 매수/매도/예약은 항상 최신 시세로 처리돼요.
let acStocksCache = { at: 0, list: null };
const AC_STOCKS_TTL_MS = 60_000;

export function invalidateStocksCache() {
  stocksCache = { at: 0, list: null };
  acStocksCache = { at: 0, list: null };
}

export async function listStocksForAutocomplete(env) {
  if (acStocksCache.list && Date.now() - acStocksCache.at < AC_STOCKS_TTL_MS) {
    return acStocksCache.list.map((s) => ({ ...s }));
  }
  const stocks = await listStocks(env);
  acStocksCache = { at: Date.now(), list: stocks };
  return stocks.map((s) => ({ ...s }));
}

// 종목 목록을 ms(밀리초) 동안 기억해 둬요. (기본 2분)
// 시세 변동 직후에 부르면, 뒤에 오는 주문/선물/은행 처리가 종목 목록을 또 읽지 않아요.
export function pinStocksCache(list, ms = 120_000) {
  stocksCache = { at: Date.now() - STOCKS_TTL_MS + ms, list };
}

export async function listStocks(env) {
  if (stocksCache.list && Date.now() - stocksCache.at < STOCKS_TTL_MS) {
    return stocksCache.list.map((s) => ({ ...s })); // 복사해서 돌려줘요 (호출한 쪽에서 값을 바꿔도 안전)
  }
  const stocks = (await listCollection(env, "stocks")).sort((a, b) => compareKo(a.name, b.name));
  stocksCache = { at: Date.now(), list: stocks };
  return stocks.map((s) => ({ ...s }));
}

export async function getStock(env, name) {
  return getDoc(env, `stocks/${encodeURIComponent(name)}`);
}

// 그래프용 시세 기록 최대 개수 (5분마다 변동 + 급등락 기준 약 24시간치)
const PRICE_HISTORY_POINTS = 300;

// 종목 문서의 history 맵 -> 시간순 배열: [{ t(밀리초), p(가격) }]
export function getPriceHistory(stock) {
  return Object.entries((stock && stock.history) || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, p]) => ({ t: Number(k), p }));
}

// ---------- 해정지수 (시장 지수) ----------
// 지금 상장된 모든 종목의 "평균 주가"를 해정지수로 보여줘요. (저장하는 데이터 없이 종목의 시세 기록(history)으로 계산)
//  - 오늘 등락: 한국시간 오늘 0시 시점의 평균 주가 대비 지금 평균 주가
//  - 같은 종목들끼리 비교해요. (오늘 새로 상장한 종목은 상장가 기준, 상장폐지된 종목은 빠져요)
//  - 최근 24시간 미니 그래프는 2시간 간격 12개 점이에요.
const IDX_KST_MS = 9 * 60 * 60 * 1000;
const IDX_DAY_MS = 24 * 60 * 60 * 1000;
const IDX_SPARK = "▁▂▃▄▅▆▇█";

// 시세 기록에서 t 시각 이전의 마지막 가격 (그 전 기록이 없으면 첫 기록)
function priceAtTime(points, t) {
  let price = points[0].p;
  for (const pt of points) {
    if (pt.t <= t) price = pt.p;
    else break;
  }
  return price;
}

// stocks: listStocks() 결과. 종목이 없으면 null
export function marketIndex(stocks, now = Date.now()) {
  // 외국자산(코인·해외주식)은 해정지수(평균 주가)에서 빼요. 배율 때문에 지수가 한쪽으로 쏠리지 않게 하려는 거예요.
  const rows = stocks.filter((s) => !isForeign(s)).map((s) => {
    const pts = getPriceHistory(s);
    return { name: s.name, price: s.price, pts: pts.length ? pts : [{ t: now, p: s.price }] };
  });
  if (rows.length === 0) return null;

  const dayStart = Math.floor((now + IDX_KST_MS) / IDX_DAY_MS) * IDX_DAY_MS - IDX_KST_MS;
  const avgOf = (fn) => rows.reduce((sum, r) => sum + fn(r), 0) / rows.length;

  const level = avgOf((r) => r.price);
  const open = avgOf((r) => priceAtTime(r.pts, dayStart));
  const diff = level - open;
  const pct = open > 0 ? (diff / open) * 100 : 0;

  // 종목별 오늘 등락 (상승/하락/보합 수, 최고 상승·최대 하락)
  let up = 0, down = 0, flat = 0, pctSum = 0;
  let best = null, worst = null;
  for (const r of rows) {
    const o = priceAtTime(r.pts, dayStart);
    const p = o > 0 ? ((r.price - o) / o) * 100 : 0;
    r.todayPct = p;
    pctSum += p;
    if (r.price > o) up++;
    else if (r.price < o) down++;
    else flat++;
    if (!best || p > best.todayPct) best = r;
    if (!worst || p < worst.todayPct) worst = r;
  }

  // 최근 24시간 미니 그래프 (맨 끝은 항상 지금 값)
  const samples = Array.from({ length: 12 }, (_, i) => {
    if (i === 11) return level;
    const t = now - (11 - i) * 2 * 60 * 60 * 1000;
    return avgOf((r) => priceAtTime(r.pts, t));
  });
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  const spark = samples
    .map((v) => IDX_SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (IDX_SPARK.length - 1))])
    .join("");

  return { count: rows.length, level, open, diff, pct, up, down, flat, avgPct: pctSum / rows.length, best, worst, spark };
}

export function marketIndexText(stocks, now = Date.now()) {
  const m = marketIndex(stocks, now);
  if (!m) return "등록된 종목이 없어요.";

  const f1 = (n) => (Math.round(n * 10) / 10).toLocaleString();
  const sgn = (n, digits = 1) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(digits)}`;
  const arrow = m.pct > 0.05 ? "🔺" : m.pct < -0.05 ? "🔻" : "➖";
  const mood =
    m.pct > 0.05 ? "🟢 오늘 시장은 **올랐어요**" : m.pct < -0.05 ? "🔴 오늘 시장은 **내렸어요**" : "⚪ 오늘 시장은 **보합**이에요";

  return [
    `**📊 해정지수 ${f1(m.level)}** ${arrow} ${sgn(m.diff)} (${sgn(m.pct, 2)}%)`,
    `${mood} · 오늘 0시 ${f1(m.open)} → 지금 ${f1(m.level)}`,
    `최근 24시간 \`${m.spark}\``,
    `종목 ${m.count}개: 🔺 상승 ${m.up} · 🔻 하락 ${m.down} · ➖ 보합 ${m.flat} (종목 평균 ${sgn(m.avgPct, 2)}%)`,
    `🏆 오늘 최고 상승: **${m.best.name}** ${sgn(m.best.todayPct)}% · 💥 최대 하락: **${m.worst.name}** ${sgn(m.worst.todayPct)}%`,
    "-# 해정지수 = 상장된 모든 종목의 평균 주가예요. (오늘은 한국시간 0시부터)",
  ].join("\n");
}

// 종목 등록/가격 변경. 역대 최고가(maxPrice)와 그래프용 시세 기록(history)도 함께 저장해요.
// known: 이미 읽어둔 종목 문서 (시세 변동처럼 방금 읽어온 경우 넘기면 읽기를 아낄 수 있어요)
// 안 넘기면 기존 문서를 읽어서 확인합니다. (관리자 /시세설정, /종목추가 등)
// extra: 같이 저장할 추가 필드 (외국자산의 baseReal/lastReal/quoteAt/stale 등. 쓰기 한 번으로 같이 저장돼요)
export async function upsertStock(env, name, price, known, extra = {}) {
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

  // 처음 만들어지는 종목일 때만 상장일(listedAt)을 기록 (기존 종목의 상장일은 건드리지 않음)
  const isNew = !Number.isFinite(base.price);

  // 기업 가치(fv): 시세 변동이 아니라 "가격을 직접 정하거나 새로 만들 때"(known을 안 넘기거나 새 종목)는 fv도 그 가격으로 맞춰요.
  // (안 그러면 관리자가 정한 가격이 옛 fv 쪽으로 도로 끌려가요) 외국자산은 fv를 쓰지 않아요.
  const resetFv = extra.fv === undefined && (!known || isNew) && !isForeign({ kind: extra.kind ?? base.kind });

  // 업종: 새로 만드는 일반 종목인데 업종을 안 정했으면 랜덤 배정. (이미 있는 종목의 업종은 건드리지 않아요)
  const newSector = isNew && extra.sector === undefined && !isForeign({ kind: extra.kind ?? base.kind }) ? { sector: randomSector() } : {};
  // 변동성 등급도 같아요: 새 일반 종목이 등급을 안 정했으면 배정해요.
  const newTier = isNew && extra.volTier === undefined && !isForeign({ kind: extra.kind ?? base.kind }) ? { volTier: newStockTier(price) } : {};

  await setDoc(env, `stocks/${encodeURIComponent(name)}`, {
    name,
    price,
    maxPrice,
    history,
    updatedAt: new Date(),
    ...(isNew ? { listedAt: Date.now() } : {}),
    ...(resetFv ? { fv: price } : {}),
    // 관리자가 가격을 직접 정하면 그 전에 쌓인 유저 거래 압력은 버려요 (정한 가격이 바로 흔들리지 않게)
    ...(!known && Number.isFinite(base.flow) && base.flow !== 0 && extra.flow === undefined ? { flow: 0 } : {}),
    ...newSector,
    ...newTier,
    ...extra,
  });
  invalidateStocksCache();
}

export async function removeStock(env, name) {
  await deleteDoc(env, `stocks/${encodeURIComponent(name)}`);
  invalidateStocksCache();
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
    user = { balance: STARTING_BALANCE, holdings: {}, items: {}, costs: {}, usd: 0 };
    await setDoc(env, `users/${userId}`, user);
  }
  if (!user.holdings) user.holdings = {};
  if (!user.items) user.items = {};
  if (!user.costs) user.costs = {};
  if (!Number.isFinite(user.usd)) user.usd = 0;
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

// ---------- 미국 장 마감 막기 ----------
// 미국 주식은 장이 닫혀 있으면 사고팔 수 없어요. (코인·일반 종목은 항상 가능)
// 닫혀 있으면 안내 문장을, 열려 있거나 해당 없으면 null 을 돌려줘요.
async function usClosedNotice(env, stocks) {
  if (!stocks.some((s) => s && s.kind === "us")) return null;
  const status = await getUsMarketStatus(env);
  return status.open ? null : closedMessage(status);
}

// ---------- 주식 매수/매도 ----------
export async function buyStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };
  const closed = await usClosedNotice(env, [stock]);
  if (closed) return { ok: false, message: closed };

  const user = await getUser(env, userId);
  const usd = isForeign(stock); // 외국자산은 달러(센트)로 결제
  const have = usd ? user.usd || 0 : user.balance;
  const fee = tradeFee(stock.price * qty);
  const cost = stock.price * qty + fee; // 수수료 포함
  if (have < cost) {
    return {
      ok: false,
      message: `${usd ? "달러가" : "잔고가"} 부족해요. (필요: ${moneyOf(stock, cost)} = 주식 ${moneyOf(stock, cost - fee)} + 수수료 ${moneyOf(stock, fee)}, 보유: ${moneyOf(stock, have)})${usd ? "\n💡 `/환전`으로 해정을 달러로 바꿀 수 있어요." : ""}`,
    };
  }

  // 기존 보유분의 원가를 먼저 구한 뒤(수량 늘리기 전에) 이번 매수 금액을 더함
  const prevCost = costOf(user, stockName, stock.price);
  const balanceBefore = have;

  if (usd) user.usd = have - cost;
  else user.balance -= cost;
  user.holdings[stockName] = (user.holdings[stockName] || 0) + qty;
  user.costs[stockName] = prevCost + cost;

  const totalQty = user.holdings[stockName];
  const avg = Math.round(user.costs[stockName] / totalQty);
  const after = usd ? user.usd : user.balance;

  const summary = `${stockName} ${qty}주 매수 완료 (-${moneyOf(stock, cost)}, 수수료 ${moneyOf(stock, fee)} 포함)`;
  // 저장과 기록을 동시에 처리해서 응답 시간을 늘리지 않음
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `매수: ${summary} → ${usd ? "달러" : "잔고"} ${moneyOf(stock, after)}`),
    recordTradeFlow(env, [{ stock, amount: stock.price * qty }]), // 6단계: 다음 변동에 반영될 순매수 압력
  ]);

  return {
    ok: true,
    message: [
      summary,
      usd ? usdLine(balanceBefore, after) : balanceLine(balanceBefore, after),
      `📊 평균 매수가: ${moneyOf(stock, avg)} (보유 ${totalQty.toLocaleString()}주)`,
    ].join("\n"),
    user,
    amount: stock.price * qty, // 거래 압력 집계용 (수수료 제외, 매수는 +)
  };
}

export async function sellStock(env, userId, stockName, qty) {
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };
  const closed = await usClosedNotice(env, [stock]);
  if (closed) return { ok: false, message: closed };

  const user = await getUser(env, userId);
  const held = user.holdings[stockName] || 0;
  if (held < qty) {
    return { ok: false, message: `보유 수량이 부족해요. (보유: ${held}주)` };
  }

  const usd = isForeign(stock);
  // 팔 수량만큼의 매수 원가(평균 매수가 기준)를 계산해서 이득/손해를 구함
  const prevCost = costOf(user, stockName, stock.price);
  const basis = Math.round((prevCost * qty) / held);
  const fee = tradeFee(stock.price * qty);
  const tax = sellTax(stock, stock.price * qty);
  const earned = stock.price * qty - fee - tax; // 수수료·거래세를 뺀 실수령액
  const profit = earned - basis;
  const balanceBefore = usd ? user.usd || 0 : user.balance;

  user.holdings[stockName] = held - qty;
  if (user.holdings[stockName] === 0) {
    delete user.holdings[stockName];
    delete user.costs[stockName];
  } else {
    user.costs[stockName] = prevCost - basis;
  }
  if (usd) {
    const fxRate = (await getFxRate(env)).rate;
    user.usd = balanceBefore + earned;
    user.realizedProfit = (user.realizedProfit || 0) + Math.round((profit * fxRate) / 100); // 실현손익은 해정으로 환산
  } else {
    user.balance += earned;
    user.realizedProfit = (user.realizedProfit || 0) + profit;
  }
  const after = usd ? user.usd : user.balance;
  const pl = usd ? profitUsdLabel(profit, basis) : profitLabel(profit, basis);

  const summary = `${stockName} ${qty}주 매도 완료 (+${moneyOf(stock, earned)}, 수수료 ${moneyOf(stock, fee)}${tax > 0 ? ` + 거래세 ${moneyOf(stock, tax)}` : ""} 차감)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `매도: ${summary} · ${pl} → ${usd ? "달러" : "잔고"} ${moneyOf(stock, after)}`),
    recordTradeFlow(env, [{ stock, amount: -(stock.price * qty) }]),
  ]);

  return {
    ok: true,
    message: [
      summary,
      usd ? usdLine(balanceBefore, after) : balanceLine(balanceBefore, after),
      `📊 이번 매도 손익: ${pl}`,
    ].join("\n"),
    user,
    amount: -(stock.price * qty), // 거래 압력 집계용 (수수료 제외, 매도는 -)
  };
}

// ---------- 상품 구입 ----------
// 구입 시점의 상품 가격 x 수량만큼 잔고에서 차감하고, 보유 수량을 qty만큼 늘립니다.
export async function buyProduct(env, userId, productName, qty = 1) {
  if (!Number.isSafeInteger(qty) || qty < 1) {
    return { ok: false, message: "수량은 1 이상의 정수로 입력해 주세요." };
  }

  const product = await getProduct(env, productName);
  if (!product) return { ok: false, message: `"${productName}" 상품을 찾을 수 없어요.` };

  const user = await getUser(env, userId);
  const cost = product.price * qty;
  if (user.balance < cost) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${cost.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  const balanceBefore = user.balance;
  user.balance -= cost;
  user.items[productName] = (user.items[productName] || 0) + qty;

  const summary = `"${productName}" ${qty.toLocaleString()}개 구입 완료 (-${cost.toLocaleString()}해정)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `구입: ${summary} → 잔고 ${user.balance.toLocaleString()}해정`),
  ]);

  return {
    ok: true,
    message: `${summary}\n${balanceLine(balanceBefore, user.balance)}\n🎒 보유: ${user.items[productName].toLocaleString()}개`,
  };
}

// ---------- 여러 개 한 번에 (매수/매도/구입) ----------
// 유저를 한 번만 읽고, 전부 가능할 때만 한 번에 저장해요. 하나라도 안 되면 아무것도 체결하지 않아요.
// items: [{ name, qty }] (이름 중복 없음, qty는 1 이상의 정수)
const fmt = (n) => n.toLocaleString();

export async function buyStocks(env, userId, items) {
  const [user, ...stocks] = await Promise.all([getUser(env, userId), ...items.map((i) => getStock(env, i.name))]);

  const missing = items.filter((_, i) => !stocks[i]);
  if (missing.length) {
    return { ok: false, message: `찾을 수 없는 종목이 있어요: ${missing.map((i) => `"${i.name}"`).join(", ")}\n(아무것도 매수하지 않았어요.)` };
  }
  {
    const closedNames = items.filter((_, i) => stocks[i].kind === "us").map((i) => i.name);
    const closed = await usClosedNotice(env, stocks);
    if (closed) return { ok: false, message: `${closed}\n(미국 주식: ${closedNames.join(", ")})\n(아무것도 매수하지 않았어요.)` };
  }

  const rows = items.map((it, i) => {
    const stock = stocks[i];
    const principal = stock.price * it.qty;
    const fee = tradeFee(principal);
    return { name: it.name, qty: it.qty, stock, usd: isForeign(stock), price: stock.price, fee, cost: principal + fee }; // cost는 수수료 포함
  });
  const sumOf = (usd, key) => rows.filter((r) => r.usd === usd).reduce((sum, r) => sum + r[key], 0);
  const totalKrw = sumOf(false, "cost");
  const totalUsd = sumOf(true, "cost");
  if (!Number.isSafeInteger(totalKrw) || !Number.isSafeInteger(totalUsd)) return { ok: false, message: "금액이 너무 커서 처리할 수 없어요. 수량을 줄여 주세요." };

  const haveUsd = user.usd || 0;
  if (user.balance < totalKrw || haveUsd < totalUsd) {
    const short = [];
    if (user.balance < totalKrw) short.push(`해정이 부족해요. (합계 필요: ${fmt(totalKrw)}해정, 보유: ${fmt(user.balance)}해정, 부족: ${fmt(totalKrw - user.balance)}해정)`);
    if (haveUsd < totalUsd) short.push(`달러가 부족해요. (합계 필요: ${centsText(totalUsd)}, 보유: ${centsText(haveUsd)}, 부족: ${centsText(totalUsd - haveUsd)}) · \`/환전\`으로 바꿀 수 있어요.`);
    return {
      ok: false,
      message: [
        ...short,
        ...rows.map((r) => `- ${r.name} ${fmt(r.qty)}주 × ${moneyOf(r.stock, r.price)} + 수수료 ${moneyOf(r.stock, r.fee)} = ${moneyOf(r.stock, r.cost)}`),
        "(아무것도 매수하지 않았어요.)",
      ].join("\n"),
    };
  }

  const krwBefore = user.balance;
  const usdBefore = haveUsd;
  const lines = rows.map((r) => {
    const prevCost = costOf(user, r.name, r.price); // 수량을 늘리기 전에 기존 원가를 먼저 구함
    user.holdings[r.name] = (user.holdings[r.name] || 0) + r.qty;
    user.costs[r.name] = prevCost + r.cost;
    const avg = Math.round(user.costs[r.name] / user.holdings[r.name]);
    return `- ${r.name} ${fmt(r.qty)}주 (-${moneyOf(r.stock, r.cost)}) · 평균 매수가 ${moneyOf(r.stock, avg)} (보유 ${fmt(user.holdings[r.name])}주)`;
  });
  user.balance -= totalKrw;
  user.usd = haveUsd - totalUsd;

  const feeText = moneyPair(sumOf(false, "fee"), sumOf(true, "fee"));
  const summary = `${rows.length}종목 매수 완료 (-${moneyPair(totalKrw, totalUsd)}, 수수료 ${feeText} 포함)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `매수: ${rows.map((r) => `${r.name} ${fmt(r.qty)}주`).join(", ")} (-${moneyPair(totalKrw, totalUsd)}) → 잔고 ${fmt(user.balance)}해정 · 달러 ${centsText(user.usd)}`),
    recordTradeFlow(env, rows.map((r) => ({ stock: r.stock, amount: r.price * r.qty }))),
  ]);
  return {
    ok: true,
    message: [
      summary,
      ...lines,
      ...(totalKrw > 0 ? [balanceLine(krwBefore, user.balance)] : []),
      ...(totalUsd > 0 ? [usdLine(usdBefore, user.usd)] : []),
    ].join("\n"),
    user,
    amount: rows.reduce((sum, r) => sum + r.price * r.qty, 0), // 거래 압력 집계용 (여러 종목 합계, 매수는 +)
  };
}

export async function sellStocks(env, userId, items) {
  const [user, ...stocks] = await Promise.all([getUser(env, userId), ...items.map((i) => getStock(env, i.name))]);

  const problems = [];
  items.forEach((it, i) => {
    if (!stocks[i]) problems.push(`"${it.name}" 종목을 찾을 수 없어요.`);
    else if ((user.holdings[it.name] || 0) < it.qty) {
      problems.push(`${it.name}: 보유 수량이 부족해요. (요청 ${fmt(it.qty)}주 / 보유 ${fmt(user.holdings[it.name] || 0)}주)`);
    }
  });
  if (problems.length) return { ok: false, message: [...problems, "(아무것도 매도하지 않았어요.)"].join("\n") };
  {
    const closedNames = items.filter((_, i) => stocks[i].kind === "us").map((i) => i.name);
    const closed = await usClosedNotice(env, stocks);
    if (closed) return { ok: false, message: `${closed}\n(미국 주식: ${closedNames.join(", ")})\n(아무것도 매도하지 않았어요.)` };
  }

  const hasUsd = stocks.some((s) => isForeign(s));
  const fxRate = hasUsd ? (await getFxRate(env)).rate : 0;
  const krwBefore = user.balance;
  const usdBefore = user.usd || 0;
  let earnedKrw = 0, earnedUsd = 0, profitKrw = 0, profitUsd = 0, basisKrw = 0, basisUsd = 0;
  const lines = items.map((it, i) => {
    const stock = stocks[i];
    const usd = isForeign(stock);
    const price = stock.price;
    const held = user.holdings[it.name];
    const prevCost = costOf(user, it.name, price);
    const basis = Math.round((prevCost * it.qty) / held);
    const earned = price * it.qty - tradeFee(price * it.qty) - sellTax(stock, price * it.qty); // 수수료·거래세를 뺀 실수령액
    const profit = earned - basis;

    user.holdings[it.name] = held - it.qty;
    if (user.holdings[it.name] === 0) {
      delete user.holdings[it.name];
      delete user.costs[it.name];
    } else {
      user.costs[it.name] = prevCost - basis;
    }
    if (usd) { earnedUsd += earned; profitUsd += profit; basisUsd += basis; }
    else { earnedKrw += earned; profitKrw += profit; basisKrw += basis; }
    return `- ${it.name} ${fmt(it.qty)}주 (+${moneyOf(stock, earned)}) · ${usd ? profitUsdLabel(profit, basis) : profitLabel(profit, basis)}`;
  });
  user.balance += earnedKrw;
  user.usd = usdBefore + earnedUsd;
  user.realizedProfit = (user.realizedProfit || 0) + profitKrw + Math.round((profitUsd * fxRate) / 100);

  const summary = `${items.length}종목 매도 완료 (+${moneyPair(earnedKrw, earnedUsd)})`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      `매도: ${items.map((it) => `${it.name} ${fmt(it.qty)}주`).join(", ")} (+${moneyPair(earnedKrw, earnedUsd)}) → 잔고 ${fmt(user.balance)}해정 · 달러 ${centsText(user.usd)}`
    ),
    recordTradeFlow(env, items.map((it, i) => ({ stock: stocks[i], amount: -(stocks[i].price * it.qty) }))),
  ]);
  return {
    ok: true,
    message: [
      summary,
      ...lines,
      ...(earnedKrw > 0 ? [balanceLine(krwBefore, user.balance), `📊 이번 매도 손익 합계(해정): ${profitLabel(profitKrw, basisKrw)}`] : []),
      ...(earnedUsd > 0 ? [usdLine(usdBefore, user.usd), `📊 이번 매도 손익 합계(달러): ${profitUsdLabel(profitUsd, basisUsd)}`] : []),
    ].join("\n"),
    user,
    amount: -items.reduce((sum, it, i) => sum + stocks[i].price * it.qty, 0), // 거래 압력 집계용 (여러 종목 합계, 매도는 -)
  };
}

export async function buyProducts(env, userId, items) {
  const [user, ...products] = await Promise.all([getUser(env, userId), ...items.map((i) => getProduct(env, i.name))]);

  const missing = items.filter((_, i) => !products[i]);
  if (missing.length) {
    return { ok: false, message: `찾을 수 없는 상품이 있어요: ${missing.map((i) => `"${i.name}"`).join(", ")}\n(아무것도 구입하지 않았어요.)` };
  }

  const rows = items.map((it, i) => ({ name: it.name, qty: it.qty, price: products[i].price, cost: products[i].price * it.qty }));
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  if (!Number.isSafeInteger(total)) return { ok: false, message: "금액이 너무 커서 처리할 수 없어요. 수량을 줄여 주세요." };
  if (user.balance < total) {
    return {
      ok: false,
      message: [
        `잔고가 부족해요. (합계 필요: ${fmt(total)}해정, 보유: ${fmt(user.balance)}해정, 부족: ${fmt(total - user.balance)}해정)`,
        ...rows.map((r) => `- ${r.name} ${fmt(r.qty)}개 × ${fmt(r.price)} = ${fmt(r.cost)}해정`),
        "(아무것도 구입하지 않았어요.)",
      ].join("\n"),
    };
  }

  const balanceBefore = user.balance;
  user.balance -= total;
  const lines = rows.map((r) => {
    user.items[r.name] = (user.items[r.name] || 0) + r.qty;
    return `- "${r.name}" ${fmt(r.qty)}개 (-${fmt(r.cost)}해정) · 보유 ${fmt(user.items[r.name])}개`;
  });

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `구입: ${rows.map((r) => `"${r.name}" ${fmt(r.qty)}개`).join(", ")} (-${fmt(total)}해정) → 잔고 ${fmt(user.balance)}해정`),
  ]);
  return { ok: true, message: [`${rows.length}종 구입 완료 (-${fmt(total)}해정)`, ...lines, balanceLine(balanceBefore, user.balance)].join("\n") };
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
  const [users, stocks, fx] = await Promise.all([
    listCollection(env, "users"),
    listStocks(env),
    getFxRate(env),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const krwMap = krwPriceMap(stocks, fx.rate); // 외국자산은 환율로 해정 환산
  const extras = await extraAssets(env, priceMap, fx.rate); // 예금 + 선물 평가금 - 대출

  return users
    .map((u) => {
      const holdingsValue = Object.entries(u.holdings || {}).reduce(
        (sum, [name, qty]) => sum + (krwMap[name] || 0) * qty,
        0
      );
      const usdValue = ((u.usd || 0) * fx.rate) / 100; // 달러 잔고도 해정으로 환산
      return { id: u.id, total: Math.round((u.balance || 0) + holdingsValue + usdValue + (extras[u.id] || 0)) };
    })
    .sort((a, b) => b.total - a.total);
}

// 유저 한 명의 잔고/보유종목/총자산/순위를 한 번에 계산 (/내정보 용)
// 보유 종목은 이름순으로 정렬. 종목별 평가손익, 지난 조회 대비 총자산 증감도 함께 돌려줘요.
// 조회할 때마다 현재 총자산을 저장해 두었다가 다음 조회 때 비교합니다.
export async function getUserDetail(env, userId) {
  const [user, stocks, ranking, fx] = await Promise.all([
    getUser(env, userId),
    listStocks(env),
    getRanking(env),
    getFxRate(env),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
  const extraAsset = Math.round(await userExtraAsset(env, userId, priceMap, fx.rate)); // 예금 + 선물 평가금 - 대출

  const holdings = Object.entries(user.holdings)
    .map(([name, qty]) => {
      const price = priceMap[name] || 0;
      const cost = costOf(user, name, price);
      // 매수 기록이 없던 기존 보유분은 이때 현재가 기준으로 기록해 둠
      if (!Number.isFinite(user.costs[name])) user.costs[name] = cost;
      const value = price * qty;
      const stock = stockMap[name];
      const foreign = stock ? isForeign(stock) : false;
      const mul = foreign ? fx.rate / 100 : 1; // 외국자산은 센트 → 해정
      return {
        name, qty, price, value, cost, avg: Math.round(cost / qty), profit: value - cost,
        valueKrw: Math.round(value * mul), costKrw: Math.round(cost * mul),
        foreign,
        icon: stock ? foreignIcon(stock) : "",
      };
    })
    .sort((a, b) => compareKo(a.name, b.name));
  const holdingsValue = holdings.reduce((sum, h) => sum + h.valueKrw, 0);
  const holdingsCost = holdings.reduce((sum, h) => sum + h.costKrw, 0);
  const usdValue = Math.round(((user.usd || 0) * fx.rate) / 100);
  const totalAsset = user.balance + holdingsValue + usdValue + extraAsset;
  const rank = ranking.findIndex((r) => r.id === userId) + 1;

  const prevAsset = Number.isFinite(user.lastAsset) ? user.lastAsset : null;
  const prevAssetAt = Number.isFinite(user.lastAssetAt) ? user.lastAssetAt : null;

  user.lastAsset = totalAsset;
  user.lastAssetAt = Date.now();
  await saveUser(env, userId, user);

  return {
    balance: user.balance,
    usd: user.usd || 0,
    usdValue,
    rate: fx.rate,
    holdings,
    holdingsValue,
    extraAsset,
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
  const { lastPrice, finalPrice, maxPrice, history, listedAt, kind } = info;
  await removeStock(env, stockName);

  const usd = isForeign({ kind }); // 외국자산은 원가가 센트라서 해정으로 환산해 실현손익에 반영해요
  const fxRate = usd ? (await getFxRate(env)).rate : 0;
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
    // 보험: 기간 안의 보험이 있으면 폐지 순간 들고 있던 수량(최대 가입 수량)만큼 보험금을 줘요
    const policy = u.insurance && u.insurance[stockName];
    const insured = policy && policy.expiresAt > Date.now() ? Math.min(policy.qty, held) * policy.payout : 0;
    const lossKrw = usd ? Math.round((cost * fxRate) / 100) : cost;
    const realizedProfit = (u.realizedProfit || 0) - lossKrw + insured;

    try {
      const saved = { holdings, costs, realizedProfit };
      if (policy) {
        const rest = { ...u.insurance };
        delete rest[stockName]; // 폐지된 종목의 보험은 (기간이 끝났어도) 정리
        saved.insurance = rest;
      }
      if (insured > 0) {
        saved.balance = (u.balance || 0) + insured;
        saved.insuranceTotal = (u.insuranceTotal || 0) + insured;
      }
      await Promise.all([
        setDoc(env, `users/${u.id}`, saved),
        addHistory(
          env,
          u.id,
          `상장폐지: ${stockName} ${held.toLocaleString()}주 소멸 (손실 -${usd ? `${centsText(cost)} ≈ ${lossKrw.toLocaleString()}해정` : `${cost.toLocaleString()}해정`})`
        ),
      ]);
      // 같은 기록 문서에 동시에 쓰면 한쪽이 덮어써져서, 보험금 기록은 뒤에 따로 남겨요
      if (insured > 0) await addHistory(env, u.id, `보험금: +${insured.toLocaleString()}해정 (${stockName} 폐지 보험)`);
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
      ...(kind ? { kind } : {}), // 외국자산이면 종류 저장 (표시할 때 $로 보여줘요)
      delistedAt,
      ...(Number.isFinite(listedAt) ? { listedAt } : {}), // 상장일 (기록이 있는 종목만)
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

// ---------- 외국자산 표시 도우미 ----------
// 종목 이름 앞에 외국자산 아이콘을 붙여요. (코인 ₿ / 해외주식 🌐, 일반 종목은 이름 그대로)
// stock 자리에는 종목 문서도, 변동 내역(c)도 넣을 수 있어요. (kind 만 보고 판단해요)
function iconName(stock) {
  const icon = foreignIcon(stock);
  return icon ? `${icon} ${stock.name}` : stock.name;
}

// 시세 지연 중인 외국자산이면 짧은 경고 표시
function staleTag(stock) {
  return isForeign(stock) && stock.stale === true ? " ⚠️시세지연" : "";
}

// 실제 가격(USD) 표시: 1달러 이상은 소수 2자리까지, 1달러 미만은 의미 있는 숫자 4자리까지
function usdText(n) {
  if (!Number.isFinite(n) || n <= 0) return "-";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${Number(n.toPrecision(4))}`;
}

// 시세 출처 이름
const SOURCE_LABEL = { coingecko: "CoinGecko", finnhub: "Finnhub" };

// "방금 / 3분 전 / 2시간 전 / 1일 전"
function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "방금";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  return `${Math.floor(hour / 24)}일 전`;
}

// /종목정보에 들어갈 외국자산 전용 줄들 (배당 줄 자리를 대신해요. 외국자산은 배당이 없어요)
function foreignInfoLines(stock, now = Date.now(), market = null) {
  const mult = Number.isFinite(stock.mult) && stock.mult > 0 ? stock.mult : 3;
  const start = Number.isFinite(stock.startPrice) && stock.startPrice > 0 ? stock.startPrice : 1000;
  const source = SOURCE_LABEL[stock.source] || stock.source || "실제 시세";
  const lines = [];

  if (stock.lastReal > 0 && stock.baseReal > 0) {
    const changePct = (stock.lastReal / stock.baseReal - 1) * 100;
    const sign = changePct > 0 ? "+" : "";
    const age = Number.isFinite(stock.quoteAt) ? ` · ${agoText(now - stock.quoteAt)} 갱신` : "";
    lines.push(`🌐 실제 시세: **${stock.symbol} ${usdText(stock.lastReal)}** (${source}${age})`);
    lines.push(`📐 상장 때 실제가 ${usdText(stock.baseReal)} 대비 **${sign}${changePct.toFixed(2)}%** → 해정 가격은 그 **${mult}배**로 움직여요. (상장가 ${start.toLocaleString()}해정 기준)`);
  } else {
    lines.push(`🌐 실제 시세: ${stock.symbol} (${source}) · 첫 시세를 기다리는 중이에요. 다음 시세 변동 때 기준이 정해져요. (배율 ×${mult})`);
  }

  if (stock.stale === true) {
    const age = Number.isFinite(stock.quoteAt) ? ` (마지막 시세 ${agoText(now - stock.quoteAt)})` : "";
    lines.push(`⚠️ 시세 지연: 최근 실제 시세를 못 받아서 가격이 그대로예요.${age}`);
  }
  lines.push(`💵 배당: 외국자산(코인·해외주식)은 배당이 없어요. · 🕒 실제 시세를 따라 15분마다 움직여요.`);
  if (stock.kind === "us") {
    if (market && !market.open) {
      lines.push(`${closedMessage(market)}\n   장이 닫혀 있는 동안은 가격이 그대로이고, 매수·매도·선물이 막혀요. (예약·손절·익절은 장이 열리면 체결돼요)`);
    } else if (market && market.open) {
      lines.push("🟢 미국 장이 열려 있어요.");
    } else {
      lines.push("🌙 미국 장이 닫혀 있는 동안은 가격이 그대로이고, 매수·매도·선물이 막혀요.");
    }
  }
  return lines;
}

// ---------- 외국자산(코인·해외주식) 시세 반영 ----------
// 외국자산 종목들의 실제 시세를 한 번에 가져와요. 반환: { 심볼: { price, at, stale } }
// 조회에 실패해도 예외를 던지지 않고 빈 값을 돌려줘요. (시세 변동 전체가 멈추지 않게)
// 반환: { "crypto:BTC": {price, at, stale}, "us:AAPL": {...} } — 종류를 앞에 붙여서 코인 심볼과 미국 티커가 겹쳐도 섞이지 않아요.
// 한쪽(코인/미국 주식) 조회가 실패해도 다른 쪽은 그대로 진행해요.
function quoteKeyOf(stock) {
  const symbol = stock.kind === "us" ? usSymbolOf(stock.symbol) : String(stock.symbol || "").trim();
  return `${stock.kind}:${symbol}`;
}

async function loadForeignQuotes(env, stocks) {
  const pick = (kind) => [...new Set(stocks.filter((s) => s.kind === kind && s.symbol).map((s) => String(s.symbol).trim()))];
  const jobs = [
    { kind: "crypto", symbols: pick("crypto"), fetcher: fetchCoinQuotes, label: "코인" },
    { kind: "us", symbols: pick("us"), fetcher: fetchUsQuotes, label: "미국 주식" },
  ].filter((j) => j.symbols.length > 0);
  if (jobs.length === 0) return {};

  const all = {};
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const { quotes, errors } = await job.fetcher(job.symbols, env);
        if (errors.length) console.error(`외국자산(${job.label}) 시세 조회 문제:`, errors.join(" / "));
        for (const [symbol, q] of Object.entries(quotes)) all[`${job.kind}:${symbol}`] = q;
      } catch (err) {
        console.error(`외국자산(${job.label}) 시세 조회 실패:`, err.message);
      }
    })
  );
  return all;
}

// 외국자산 한 종목을 실제 시세로 갱신해요. 반환: 일반 종목과 같은 모양의 변동 내역, 또는 null(이번엔 변동 없음/시세 못 받음)
//  - 시세를 못 받았거나 이상한 시세(갑자기 반토막 등)면 가격은 그대로 두고 "시세 지연(stale)"만 표시해요. 공지에는 올리지 않아요.
//  - 새 가격이 DELIST_PRICE 이하면 일반 종목처럼 상장폐지돼요.
async function updateForeignStock(env, stock, quotes) {
  const path = `stocks/${encodeURIComponent(stock.name)}`;
  let quote = quotes[quoteKeyOf(stock)];

  if (quote && isSuspectQuote(stock, quote)) {
    console.error(`외국자산 이상 시세 무시 (${stock.name}): 실제가 ${stock.lastReal} → ${quote.price}`);
    quote = null;
  }

  if (!quote) {
    // 이미 시세 지연으로 표시돼 있으면 쓰기를 아껴요
    if (stock.stale !== true) {
      await setDoc(env, path, { stale: true });
      invalidateStocksCache();
    }
    return null;
  }

  const upd = buildForeignUpdate(stock, quote);
  const before = stock.price;
  const after = upd.price;
  const pct = before > 0 ? ((after - before) / before) * 100 : 0;
  const maxPrice = Math.max(Number.isFinite(stock.maxPrice) ? stock.maxPrice : stock.price, stock.price);

  if (after <= DELIST_PRICE) {
    const holders = await delistStock(env, stock.name, {
      kind: stock.kind,
      lastPrice: before,
      finalPrice: after,
      maxPrice,
      history: stock.history,
      listedAt: stock.listedAt,
    });
    return { name: stock.name, kind: stock.kind, before, after, pct, delisted: true, holders };
  }

  // 가격·시세 기록과 실제 시세 필드(baseReal 등)를 쓰기 한 번으로 저장
  await upsertStock(env, stock.name, after, stock, upd.fields);
  return { name: stock.name, kind: stock.kind, before, after, pct, delisted: false, holders: [] };
}

// ---------- 변동률 뽑기 (하락 편향 보정) ----------
// 예전에는 변동률(%)을 -20~+20 균등 난수로 뽑았어요. 평균이 0%여도 가격은 곱셈으로 누적되기 때문에
// 중앙값이 계속 떨어졌어요. (예: +20% 다음 -20% 이면 원래 가격의 96%)
// 지금은 "로그 수익률"을 정규분포(범위 안으로 잘라낸 것)에서 뽑고, 잘라낸 뒤에도 평균이 정확히 0이 되도록 중심을 맞춰요.
// 그래서 곱셈으로 누적해도 가격이 한쪽으로 쏠리지 않아요. 변동 범위(minPct~maxPct)는 그대로 지켜요.
//   FLUCT_RANGE_SIGMAS: 범위 전체 폭이 표준편차의 몇 배인지. 작을수록 범위 끝까지 자주 가고, 클수록 가운데에 몰려요.
//   FLUCT_DRIFT: 로그 수익률의 평균(한 번 변동당). 0이면 중립, 양수면 완만한 상승, 음수면 완만한 하락이에요.
const FLUCT_RANGE_SIGMAS = 3.6;
const FLUCT_DRIFT = 0;

// 표준정규 분포함수 Φ, 밀도함수 φ (erf 근사식)
function erfApprox(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}
const normCdf = (z) => 0.5 * (1 + erfApprox(z / Math.SQRT2));
const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// mu를 중심으로 하고 [lo, hi]로 자른 정규분포의 평균
function truncatedMean(mu, sigma, lo, hi) {
  const a = (lo - mu) / sigma;
  const b = (hi - mu) / sigma;
  const mass = normCdf(b) - normCdf(a);
  if (mass < 1e-12) return mu;
  return mu + (sigma * (normPdf(a) - normPdf(b))) / mass;
}

// 잘라낸 뒤의 평균이 target이 되는 mu를 이분법으로 찾아요
function solveCenter(lo, hi, sigma, target) {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60; i++) {
    const mid = (a + b) / 2;
    if (truncatedMean(mid, sigma, lo, hi) < target) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
}

const fluctParamsCache = new Map();
function fluctParams(minPct, maxPct, sigmaOverride) {
  const key = `${minPct}|${maxPct}|${sigmaOverride ?? ""}`;
  let p = fluctParamsCache.get(key);
  if (!p) {
    const lo = Math.log(1 + Math.max(minPct, -99.9) / 100);
    const hi = Math.log(1 + maxPct / 100);
    const sigma = sigmaOverride ?? (hi - lo) / FLUCT_RANGE_SIGMAS;
    // 목표 평균은 범위 안에 들어와야 해요
    const target = Math.min(Math.max(FLUCT_DRIFT, lo + 1e-6), hi - 1e-6);
    p = { lo, hi, sigma, mu: solveCenter(lo, hi, sigma, target) };
    fluctParamsCache.set(key, p);
  }
  return p;
}

function randomNormal() {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// minPct~maxPct(%) 범위 안에서 변동률(%)을 하나 뽑아요. (하락 편향 없음)
export function randomChangePct(minPct, maxPct, sigmaOverride) {
  const { lo, hi, sigma, mu } = fluctParams(minPct, maxPct, sigmaOverride);
  for (let i = 0; i < 100; i++) {
    const r = mu + sigma * randomNormal();
    if (r >= lo && r <= hi) return (Math.exp(r) - 1) * 100;
  }
  return (Math.exp(lo + Math.random() * (hi - lo)) - 1) * 100; // 거의 일어나지 않는 예외 상황
}

// ---------- 기업 가치(fv)와 평균 회귀 ----------
// 종목 문서에 fv(적정 가치)가 있어요. 가격은 fv 주변을 오가고, 너무 벗어나면 서서히 fv 쪽으로 끌려와요.
// fv는 유저에게 보여주지 않아요. (관리자 API의 종목 목록에만 들어 있어요)
//   FV_REVERT: 한 번 변동당 끌어당기는 세기(로그 기준). 0이면 끌어당김 없음. 0.02면 가격이 fv에서 벗어난 만큼의 약 2%씩 돌아와요.
//   FV_DRIFT_SIGMA: fv가 한 번 변동당 제멋대로 움직이는 정도(로그 표준편차). 평균은 0이라 한쪽으로 쏠리지 않아요.
//   NEWS_FV_FACTOR: 공시 효과 중 fv에 오래 남는 비율. 1이면 공시로 오른 만큼 적정 가치도 그대로 올라요.
const FV_REVERT = 0.02;
const FV_DRIFT_SIGMA = 0.004;
const NEWS_FV_FACTOR = 0.8;

// ---------- 유저 거래의 가격 영향 (6단계) ----------
// 유저가 /매수·/매도(예약 체결 포함)로 거래하면, 종목 문서의 flow 필드에 "순매수 금액(해정)"이 쌓여요.
//   (매수 +, 매도 −. 사고 바로 팔면 서로 상쇄돼서 영향이 거의 없어요. 선물·강제청산·외국자산은 안 쌓여요)
// 다음 시세 변동 때 flow를 읽어 변동률(impact)에 더하고, 종목 문서를 저장할 때 flow를 0으로 비워요. (별도 읽기·쓰기 없음)
// 영향 크기는 시장충격 연구의 "제곱근 법칙"을 따라요: 영향 = Y × (그 종목의 개별 변동성) × √(순매수 금액 ÷ 유동성)
//   - 제곱근이라 금액을 4배로 늘려도 영향은 2배만 늘어요. (큰손이 돈으로 가격을 밀어붙이기 어려워요)
//   - 같은 금액이면 소형주가 대형주보다 훨씬 많이 움직여요. (유동성이 작고 변동성이 커서)
//   - 마지막에 tanh로 부드럽게 눌러서 TRADE_IMPACT_CAP(%p)를 넘지 못해요.
//   - 영향 중 TRADE_PERMANENT_SHARE만큼은 fv도 같이 옮겨서 오래 남고, 나머지는 평균 회귀로 서서히 돌아와요.
//   TRADE_IMPACT_ENABLED: false면 쌓지도, 반영하지도 않아요.
//   TRADE_IMPACT_Y: 영향 세기 계수 (1이 연구에서 흔한 값. 줄이면 둔해져요)
//   TRADE_LIQUIDITY: 등급별 유동성(해정). 한 번 변동 사이에 이만큼 순매수하면 "개별 변동성 1배"만큼 움직여요.
//   TRADE_IMPACT_CAP: 한 번 변동에 유저 거래가 줄 수 있는 최대 영향(%p, 위·아래 모두)
//   TRADE_FLOW_MAX_PER_TRADE: 거래 1건이 flow에 더할 수 있는 최대 금액(해정). 한 번에 어마어마한 금액을 넣어도 이만큼만 쳐줘요.
//   TRADE_PERMANENT_SHARE: 영향 중 fv(적정 가치)에 남는 비율 (0이면 전부 일시적)
const TRADE_IMPACT_ENABLED = true;
const TRADE_IMPACT_Y = 1;
const TRADE_LIQUIDITY = { 대형: 2_000_000, 중형: 500_000, 소형: 100_000 };
const TRADE_IMPACT_CAP = 10;
const TRADE_FLOW_MAX_PER_TRADE = 1_000_000;
const TRADE_PERMANENT_SHARE = 0.3;

// ---------- 업종과 시장 공통 요인 ----------
// 한 번 변동할 때 "시장 충격 1개 + 업종별 충격 1개씩 + 종목 개별 충격"을 합쳐서 반영해요. (모두 로그 수익률 기준)
//   종목 충격 합 = beta × 시장 충격 + 내 업종 충격 + 개별 충격
// 시장·업종 충격은 0을 중심으로 좌우 대칭이라 평균이 0이고, 개별 충격은 나머지 범위 안에서 평균 0이 되게 맞춰요.
// 그래서 1단계의 "하락 편향 없음"이 그대로 유지돼요. 전체 변동 폭(minPct~maxPct)도 넘지 않아요.
//   SECTORS: 업종 목록. 업종이 없거나 목록에 없는 종목("기타")은 시장 충격만 받고 업종 충격은 없어요.
//   BETA_DEFAULT / BETA_MAX: 종목 beta(시장 민감도) 기본값 / 최대값. beta가 2면 시장 충격을 2배로 받아요.
//   SHOCK_NORMAL: 평소 변동(15분마다). market/sector = 충격의 표준편차, *Max = 충격의 최대 크기 (개별 충격은 아래 변동성 등급이 정해요)
//   SHOCK_SURGE : 급등락(18시/21시/0시). 시장·업종 충격이 크게 나오는 이벤트예요. (cron.js의 range.surge === true)
//   COMMON_LIMIT_RATIO: 시장+업종 충격 합이 변동 범위 한쪽 끝의 몇 %까지만 가도록 제한 (0.95면 95%)
export const SECTORS = ["IT", "바이오", "에너지", "금융", "소비재", "건설"];
export const NO_SECTOR = "기타";
export const BETA_DEFAULT = 1;
export const BETA_MAX = 3;
const SHOCK_NORMAL = { marketSigma: 0.03, marketMax: 0.08, sectorSigma: 0.05, sectorMax: 0.12 };
const SHOCK_SURGE = { marketSigma: 0.3, marketMax: 0.5, sectorSigma: 0.4, sectorMax: 0.6 };
const COMMON_LIMIT_RATIO = 0.95;

export function randomSector() {
  return SECTORS[Math.floor(Math.random() * SECTORS.length)];
}

// 업종 이름 정리: 목록에 있으면 그대로, 아니면 "기타"
export function sectorOf(stock) {
  return SECTORS.includes(stock?.sector) ? stock.sector : NO_SECTOR;
}

// 0 중심, 좌우 대칭으로 잘라낸 정규분포 (평균 0 유지)
function randomSymNormal(sigma, max) {
  for (let i = 0; i < 100; i++) {
    const x = sigma * randomNormal();
    if (Math.abs(x) <= max) return x;
  }
  return 0;
}

// 이번 변동의 공통 충격을 한 번 뽑아요. (시장 1개, 업종별 1개씩) surge=true면 급등락용 큰 충격이에요.
export function rollShocks(surge = false) {
  const p = surge ? SHOCK_SURGE : SHOCK_NORMAL;
  const sectors = {};
  for (const s of SECTORS) sectors[s] = randomSymNormal(p.sectorSigma, p.sectorMax);
  return { market: randomSymNormal(p.marketSigma, p.marketMax), sectors, surge: !!surge };
}

// 한 종목이 이번에 받는 공통 충격(로그) = beta × 시장 + 내 업종
export function commonShockOf(shocks, sector, beta) {
  const b = Number.isFinite(beta) && beta >= 0 ? Math.min(beta, BETA_MAX) : BETA_DEFAULT;
  const sec = SECTORS.includes(sector) ? shocks.sectors[sector] : 0;
  return b * shocks.market + sec;
}

// ---------- 변동성 등급 (대형 / 중형 / 소형) ----------
// 종목마다 등급이 있고, 등급에 따라 "종목 개별 충격"의 크기가 달라요. (시장·업종 충격은 등급과 무관해요)
//   VOL_TIER_SIGMA: 등급별 개별 충격의 표준편차(로그). normal = 평소 변동, surge = 급등락.
//                   평소에는 표준편차의 약 2배가 "대형 ±5% / 중형 ±10% / 소형 ±20%"쯤이에요.
//   TIER_LARGE_PRICE / TIER_MID_PRICE: 등급을 안 정한 종목의 기본 배정 규칙. 가격이 높을수록 대형이에요.
//                   (이 가격 이상이면 대형 / 중형, 아니면 소형)
//   TIER_LISTING_WEIGHTS: 가격이 똑같은 1000해정(LISTING_PRICE)으로 새로 상장되는 종목은 이 비율로 랜덤 배정해요.
export const VOL_TIERS = ["대형", "중형", "소형"];
export const VOL_TIER_SIGMA = {
  대형: { normal: 0.025, surge: 0.12 },
  중형: { normal: 0.05, surge: 0.22 },
  소형: { normal: 0.1, surge: 0.35 },
};
const TIER_LARGE_PRICE = 10000;
const TIER_MID_PRICE = 2000;
const TIER_LISTING_WEIGHTS = { 대형: 0.1, 중형: 0.3, 소형: 0.6 };

// 가격으로 정하는 기본 등급
export function tierByPrice(price) {
  if (price >= TIER_LARGE_PRICE) return "대형";
  if (price >= TIER_MID_PRICE) return "중형";
  return "소형";
}

function randomTier() {
  let r = Math.random();
  for (const t of VOL_TIERS) {
    r -= TIER_LISTING_WEIGHTS[t];
    if (r < 0) return t;
  }
  return "소형";
}

// 새로 만드는 종목의 등급: 1000해정 상장이면 랜덤, 그 밖의 가격이면 가격 규칙
export function newStockTier(price) {
  return price === LISTING_PRICE ? randomTier() : tierByPrice(price);
}

// 종목의 등급 (등급이 없으면 가격 규칙)
export function tierOf(stock) {
  return VOL_TIERS.includes(stock?.volTier) ? stock.volTier : tierByPrice(stock?.price);
}

// 이번 변동에서 이 종목의 개별 충격 크기
export function idioSigmaOf(stock, surge = false) {
  return VOL_TIER_SIGMA[tierOf(stock)][surge ? "surge" : "normal"];
}

// 쌓인 순매수 금액(flow, 해정) -> 이번 변동에 더할 영향(%p)과 fv에 남길 몫(%p). (fluctuatePrices와 scripts/simulate.js가 같이 써요)
// flow가 없거나 0이면 영향 없음. 종목 문서에 flow 필드가 없던 기존 종목도 그대로 동작해요.
export function tradeImpactOf(flow, stock) {
  if (!TRADE_IMPACT_ENABLED || !Number.isFinite(flow) || flow === 0) return { impact: 0, fvShift: 0 };
  const tier = tierOf(stock);
  const raw = TRADE_IMPACT_Y * VOL_TIER_SIGMA[tier].normal * 100 * Math.sqrt(Math.abs(flow) / TRADE_LIQUIDITY[tier]);
  const impact = Math.sign(flow) * TRADE_IMPACT_CAP * Math.tanh(raw / TRADE_IMPACT_CAP);
  return { impact, fvShift: impact * TRADE_PERMANENT_SHARE };
}

// 유저 거래를 종목 문서의 flow에 더해요. (원자적 증가 1번, 읽기 없음) 실패해도 거래 자체는 그대로 성공해요.
// trades: [{ stock(종목 문서), amount(해정, 매수 +/매도 −) }]  외국자산은 건너뛰어요.
async function recordTradeFlow(env, trades) {
  if (!TRADE_IMPACT_ENABLED) return;
  const merged = new Map(); // 같은 종목은 합쳐서 문서당 쓰기 1번
  for (const t of trades) {
    if (!t.stock || isForeign(t.stock) || !Number.isFinite(t.amount) || t.amount === 0) continue;
    const by = Math.sign(t.amount) * Math.min(Math.abs(t.amount), TRADE_FLOW_MAX_PER_TRADE); // 거래 1건당 상한은 그대로
    const path = `stocks/${encodeURIComponent(t.stock.name)}`;
    merged.set(path, (merged.get(path) || 0) + by);
  }
  const items = [...merged].filter(([, by]) => by !== 0).map(([path, by]) => ({ path, field: "flow", by }));
  if (items.length === 0) return;
  try {
    await incrementFields(env, items);
  } catch (err) {
    console.error("거래 압력 기록 실패:", err.message);
  }
}

// [lo, hi] 안에서 평균이 0이 되게 뽑은 로그 수익률 (범위가 매번 달라서 중심을 그때그때 맞춰요)
function randomLogWithin(lo, hi, sigma) {
  const target = Math.min(Math.max(FLUCT_DRIFT, lo + 1e-6), hi - 1e-6);
  const mu = solveCenter(lo, hi, sigma, target);
  for (let i = 0; i < 100; i++) {
    const r = mu + sigma * randomNormal();
    if (r >= lo && r <= hi) return r;
  }
  return lo + Math.random() * (hi - lo); // 거의 일어나지 않는 예외 상황
}

// 한 종목의 이번 변동률(%)과 새 fv를 계산해요. (fluctuatePrices와 scripts/simulate.js가 같이 써요)
//   fvIn: 지금 fv (없으면 현재 가격으로 시작)
//   impact: 봇 순매수 압력(%p), newsShift: 공시 기울기(%p)
//   newsFvShift: 공시 기울기 중 fv에도 반영할 몫(%p). 안 넘기면 newsShift와 같아요. (실적 발표는 fv를 이미 직접 바꿨으니 0)
//   common: 시장·업종 공통 충격(로그, commonShockOf 결과). idioSigma: 개별 충격 표준편차(idioSigmaOf 결과, 등급별).
//           idioSigma를 안 넘기면 예전(2단계)처럼 공통 충격 없이 개별 변동만 써요.
export function nextChange(price, fvIn, { minPct, maxPct, crashChance = 0, crashPct = -100, impact = 0, newsShift = 0, newsFvShift = newsShift, common = 0, idioSigma, tradeFvShift = 0 }) {
  const fvBase = Number.isFinite(fvIn) && fvIn > 0 ? fvIn : price;
  // fv는 공시를 따라 움직이고(+ 유저 거래 영향 중 오래 남는 몫), 아주 조금씩 제멋대로 움직여요
  const fv = Math.max(1, fvBase * (1 + (newsFvShift * NEWS_FV_FACTOR + tradeFvShift) / 100) * Math.exp(FV_DRIFT_SIGMA * randomNormal()));
  if (Math.random() < crashChance) return { pct: crashPct, fv };
  // 끌어당김은 지난번 fv 기준이에요. (공시 효과는 newsShift로 이미 더해지니까 이번 변동에 두 번 세지 않아요)
  const pull = (Math.exp(FV_REVERT * Math.log(fvBase / price)) - 1) * 100;

  let basePct;
  if (idioSigma === undefined) {
    basePct = randomChangePct(minPct, maxPct);
  } else {
    const lo = Math.log(1 + Math.max(minPct, -99.9) / 100);
    const hi = Math.log(1 + maxPct / 100);
    // 공통 충격은 0 대칭으로 제한해서(평균 0 유지), 개별 충격이 들어갈 자리를 항상 남겨요
    const lim = Math.min(-lo, hi) * COMMON_LIMIT_RATIO;
    const c = Math.min(Math.max(common, -lim), lim);
    basePct = (Math.exp(c + randomLogWithin(lo - c, hi - c, idioSigma)) - 1) * 100;
  }
  return { pct: basePct + impact + newsShift + pull, fv };
}

// ---------- 시세 변동 ----------
// 모든 종목 가격을 minPct~maxPct(%) 범위에서 무작위로 변동시킴 (외국자산은 실제 시세로 변동) (최저가 1해정 보장)
// 변동 후 가격이 DELIST_PRICE 이하이면 상장폐지 처리합니다.
// 반환: [{ name, before, after, pct, delisted, holders }]
//   - delisted: 상장폐지 여부
//   - holders: 상장폐지된 종목을 보유 중이던 유저 ID 목록 (아니면 빈 배열)
// crashChance: 종목마다 이 확률로 crashPct(예: -100%)가 그대로 적용돼요. (0.005 = 0.5%)
// impact: { 종목이름: %p } 봇 순매수 압력 등 종목별로 변동률에 더해지는 값 (crowd.js 에서 계산)
// surge: true면 급등락 변동이라 시장·업종 충격이 크게 나와요. (cron.js의 SURGE_RANGE)
// 반환 배열에는 이번에 뽑은 시장·업종 충격이 changes.shocks 로 같이 붙어 있어요. (로그용)
export async function fluctuatePrices(env, { minPct, maxPct, crashChance = 0, crashPct = -100, impact = {}, news = {}, newsFv = null, surge = false }) {
  const stocks = await listStocks(env);
  const changes = [];
  const shocks = rollShocks(surge); // 이번 변동의 시장 충격 1개 + 업종별 충격 1개씩
  changes.shocks = shocks;

  // 외국자산(코인·해외주식)은 랜덤 대신 실제 시세로 움직여요. 시세는 한 번에 모아서 가져와요.
  const quotes = await loadForeignQuotes(env, stocks);

  for (const stock of stocks) {
    if (isForeign(stock)) {
      // 랜덤 변동·급등락(-100% 폭락 포함)·봇 영향·공시는 모두 적용하지 않아요.
      try {
        const change = await updateForeignStock(env, stock, quotes);
        if (change) changes.push(change); // 일반 종목과 같은 모양이라 공지·알림·선물 정산이 그대로 이어져요
      } catch (err) {
        console.error(`외국자산 갱신 실패 (${stock.name}):`, err.message); // 한 종목이 실패해도 나머지는 계속해요
      }
      continue;
    }

    // 6단계: 이 종목 문서에 쌓여 있던 유저 순매수(flow)를 영향으로 바꿔요. (이미 읽은 문서라 추가 읽기 없음)
    const trade = tradeImpactOf(stock.flow, stock);
    // news = 공시 기울기, impact = 봇 압력 + 유저 거래 압력, fv = 기업 가치(평균 회귀용)
    const { pct, fv } = nextChange(stock.price, stock.fv, {
      minPct, maxPct, crashChance, crashPct,
      impact: (impact[stock.name] || 0) + trade.impact,
      tradeFvShift: trade.fvShift,
      newsShift: news[stock.name] || 0,
      newsFvShift: newsFv ? newsFv[stock.name] || 0 : undefined, // 실적 발표 공시는 fv를 또 움직이지 않아요
      common: commonShockOf(shocks, stock.sector, stock.beta), // beta × 시장 + 내 업종 (업종 없으면 시장만)
      idioSigma: idioSigmaOf(stock, surge), // 변동성 등급에 따른 개별 충격 크기
    });
    const newPrice = Math.max(1, Math.round(stock.price * (1 + pct / 100)));
    // 최고가 기록이 없던 기존 종목은 지금 가격을 최고가로 시작
    const maxPrice = Math.max(Number.isFinite(stock.maxPrice) ? stock.maxPrice : stock.price, stock.price);

    if (newPrice <= DELIST_PRICE) {
      const holders = await delistStock(env, stock.name, {
        lastPrice: stock.price,
        finalPrice: newPrice,
        maxPrice,
        history: stock.history,
        listedAt: stock.listedAt,
      });
      changes.push({ name: stock.name, before: stock.price, after: newPrice, pct, delisted: true, holders });
      continue;
    }

    // 등급이 없던 기존 종목은 이번에 가격 규칙으로 정해서 같이 저장해요. (쓰기 횟수는 그대로)
    const tierExtra = VOL_TIERS.includes(stock.volTier) ? {} : { volTier: tierOf(stock) };
    // 쌓였던 유저 거래 압력은 반영했으니 같은 쓰기에 실어서 비워요. (쓰기 횟수는 그대로)
    const flowExtra = Number.isFinite(stock.flow) && stock.flow !== 0 ? { flow: 0 } : {};
    await upsertStock(env, stock.name, newPrice, stock, { fv: Math.round(fv * 100) / 100, ...tierExtra, ...flowExtra });
    changes.push({ name: stock.name, before: stock.price, after: newPrice, pct, delisted: false, holders: [] });
  }

  // 종목 수가 기준 이하로 줄었으면 자동 상장
  await ensureMinimumStocks(env);
  // 가격을 다 쓴 뒤의 최신 목록을 2분간 기억해요. (이후 주문/선물/은행 처리가 종목을 다시 읽지 않게 함)
  pinStocksCache(await listStocks(env));
  return changes;
}

// ---------- 알림 설정 ----------
// 알림을 켠 유저 목록 문서 ({ u_유저ID: true/false }). 시세 변동 때 users 전체 대신 이 문서만 읽어요.
export const NOTIFY_USERS_PATH = "config/notifyUsers";

// 문서를 읽어요. 아직 없으면 딱 한 번만 users 전체를 읽어서 만들어요. (이미 알림 켠 유저가 빠지지 않게)
async function loadNotifyFlags(env) {
  let flags = await getDoc(env, NOTIFY_USERS_PATH);
  if (!flags) {
    const all = await listCollection(env, "users");
    flags = Object.fromEntries(
      all.map((u) => [`u_${u.id}`, Boolean(u.notify && (u.notify.all || u.notify.up || u.notify.down))])
    );
    if (Object.keys(flags).length) await setDoc(env, NOTIFY_USERS_PATH, flags);
  }
  return flags;
}

export async function setNotify(env, userId, notify) {
  const user = await getUser(env, userId);
  user.notify = notify;
  await saveUser(env, userId, user);
  await loadNotifyFlags(env); // 문서가 없으면 기존 유저까지 포함해서 먼저 만들어둬요
  await setDoc(env, NOTIFY_USERS_PATH, { [`u_${userId}`]: Boolean(notify.all || notify.up || notify.down) });
}

// ---------- 전체 유저 보유 종목 (/보유종목 용) ----------
// 보유 종목이 있는 유저만, 보유 평가액 높은 순으로 돌려줘요. 상장폐지된 종목은 제외.
// [{ id, username, holdings: [{ name, qty, price, value, foreign, icon }], total }]
export async function getAllHoldings(env) {
  const [users, stocks] = await Promise.all([
    listCollection(env, "users"),
    listStocks(env),
  ]);
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));

  return users
    .map((u) => {
      const holdings = Object.entries(u.holdings || {})
        .filter(([name, qty]) => qty > 0 && stockMap[name] !== undefined)
        .map(([name, qty]) => {
          const stock = stockMap[name];
          return {
            name,
            qty,
            price: stock.price,
            value: stock.price * qty,
            foreign: isForeign(stock),
            icon: foreignIcon(stock),
          };
        })
        .sort((a, b) => compareKo(a.name, b.name));
      return {
        id: u.id,
        username: u.username,
        holdings,
        total: holdings.reduce((sum, h) => sum + h.value, 0),
      };
    })
    .filter((u) => u.holdings.length > 0)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
// [actionlog.js]
// ============================================================
// ---------- 활동 로그 ----------
// 유저가 쓴 명령어와 관리자 콘솔 작업을 "날짜별 컬렉션"(logs_2026-10-27)에 한 건씩 문서로 저장해요.
//  - 문서 하나가 로그 한 줄이라서, 여러 명이 동시에 써도 서로 덮어쓰지 않아요.
//  - 시간은 밀리초까지 저장하고(t), 관리자 콘솔에서는 한국시간 초 단위로 보여줘요.
//  - 로그를 남기다 실패해도 명령어 자체는 절대 막지 않아요.
// 문서 모양: { t: 시각(ms), u: 유저ID, n: 닉네임, c: 명령어, k: 분류, a: 입력값, r: 결과 }

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKST = (ms) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
const collectionOf = (day) => `logs_${day}`;

// 보기만 하는 명령어는 로그에 남기지 않아요. (쓰기 횟수를 아끼려고)
// 이것도 남기고 싶으면 이름을 이 목록에서 지우세요.
export const VIEW_ONLY = new Set([
  "도움말", "주식목록", "그래프", "상장폐지종류", "보유종목", "잔고", "내정보",
  "지수", "종목정보", "관심목록", "봇현황", "랭킹", "내역", "예약목록", "보유상품", "알림확인", "채굴정보", "주식상점",
  "선물목록", "선물설명", "은행", "은행설명", "배당", "공시목록", "보험", "환율", "주식질문",
]);

// 명령어 이름 -> 분류 (관리자 콘솔의 분류 선택칸에 그대로 나와요)
const CATEGORY = {
  매수: "매수",
  매도: "매도",
  구입: "상품구입",
  선물: "선물",
  선물청산: "선물",
  보험가입: "보험",
  보험해지: "보험",
  환전: "환전",
  예금: "은행",
  출금: "은행",
  송금: "은행",
  대출: "은행",
  상환: "은행",
  예약매수: "예약",
  예약매도: "예약",
  자동매도: "예약",
  예약취소: "예약",
  예약체결: "예약",
  출석체크: "출석",
  채굴: "채굴",
  채굴업그레이드: "채굴",
  종목생성: "종목생성",
  알림설정: "알림",
  종목추가: "관리자",
  종목삭제: "관리자",
  시세설정: "관리자",
  출석설정: "관리자",
  체력회복: "관리자",
  공시: "관리자",
  공시설정: "관리자",
};
export const categoryOf = (cmd) => CATEGORY[cmd] || "기타";

// 입력한 옵션을 "종목=가나다, 수량=5" 처럼 한 줄로
export function summarizeOptions(options = []) {
  return options
    .map((o) => `${o.name}=${typeof o.value === "boolean" ? (o.value ? "켜기" : "끄기") : o.value}`)
    .join(", ")
    .slice(0, 200);
}

// 결과 메시지의 첫 줄만 (굵은 글씨 표시 등은 지움)
export function firstLine(content) {
  if (typeof content !== "string") return "";
  const line = content.split("\n").find((l) => l.trim()) || "";
  return line.replace(/[*`>_~]/g, "").trim().slice(0, 160);
}

// 로그 1건 저장 (실패해도 조용히 넘어감)
// amt: 거래 금액(해정/센트, 부호 있음 — 매수 +, 매도 -). 없는 명령어는 필드 자체를 생략해요.
export async function logAction(env, { u, n = "", cmd, a = "", r = "", k, amt }) {
  try {
    const t = Date.now();
    const id = `${String(t).padStart(13, "0")}_${Math.random().toString(36).slice(2, 7)}`;
    await setDoc(env, `${collectionOf(dayKST(t))}/${id}`, {
      t,
      u: String(u),
      n: String(n || ""),
      c: String(cmd),
      k: k || categoryOf(cmd),
      a: String(a || ""),
      r: String(r || ""),
      ...(Number.isFinite(amt) ? { amt } : {}),
    });
  } catch (err) {
    console.error(`활동 로그 저장 실패 (${cmd}):`, err.message);
  }
}

// ---------- 로그 기반 거래 압력 집계 (매수/매도/선물/선물청산의 amt 합산) ----------
// 매번 컬렉션 전체를 읽지 않도록, 마지막으로 집계한 시각(config/tradePressure.lastFluctuationAt) 이후의 로그만 읽어요.
// 자정(KST)을 걸치면 날짜별 컬렉션이 최대 2개로 나뉘어 있어서 그만큼만 쿼리해요.
const TRADE_PRESSURE_PATH = "config/tradePressure";

export async function logTradePressure(env) {
  const now = Date.now();
  const state = await getDoc(env, TRADE_PRESSURE_PATH);
  const since = Number.isFinite(state?.lastFluctuationAt) ? state.lastFluctuationAt : now; // 첫 실행이면 지금부터 쌓기 시작 (과거는 건너뜀)

  let amount = 0, count = 0;
  if (since < now) {
    const days = [...new Set([dayKST(since), dayKST(now)])];
    const results = await Promise.all(days.map((day) => queryByTime(env, collectionOf(day), since, now)));
    for (const docs of results) {
      for (const doc of docs) {
        if (Number.isFinite(doc.amt)) {
          amount += doc.amt;
          count++;
        }
      }
    }
  }

  const result = { amount, count, since, until: now };
  // lastAmount/lastCount도 같이 저장해서, 관리자 콘솔은 새로 쿼리하지 않고 이 문서만 읽으면 돼요.
  await setDoc(env, TRADE_PRESSURE_PATH, { lastFluctuationAt: now, lastAmount: amount, lastCount: count, lastSince: since });
  return result;
}

// 관리자 콘솔 조회용: 커서를 소비하지 않고 마지막 집계 결과만 읽어요.
export async function getTradePressureState(env) {
  return (await getDoc(env, TRADE_PRESSURE_PATH)) || { lastFluctuationAt: null, lastAmount: 0, lastCount: 0, lastSince: null };
}

// 최근 days일(오늘 포함, 1~7)의 로그를 최신순으로
export async function listLogs(env, days = 1) {
  const n = Math.min(7, Math.max(1, Math.floor(Number(days)) || 1));
  const now = Date.now();
  const lists = await Promise.all(
    Array.from({ length: n }, (_, i) => listCollection(env, collectionOf(dayKST(now - i * DAY_MS))).catch(() => []))
  );
  return lists
    .flat()
    .map(({ id, ...log }) => log)
    .sort((a, b) => b.t - a.t)
    .slice(0, 5000);
}

// keepDays일보다 오래된 로그 삭제 (최대 90일 전까지 훑어요). 지운 개수를 돌려줘요.
export async function purgeLogs(env, keepDays) {
  const now = Date.now();
  let deleted = 0;
  for (let i = keepDays; i < keepDays + 90; i++) {
    const coll = collectionOf(dayKST(now - i * DAY_MS));
    let docs = [];
    try {
      docs = await listCollection(env, coll);
    } catch {
      continue;
    }
    for (let j = 0; j < docs.length; j += 20) {
      await Promise.all(docs.slice(j, j + 20).map((d) => deleteDoc(env, `${coll}/${d.id}`)));
    }
    deleted += docs.length;
  }
  return deleted;
}

// ============================================================
// [attendance.js]
// ============================================================
const CONFIG_PATH = "config/attendance";
const DEFAULT_CONFIG = { enabled: true, reward: 100 };

// 한국 날짜 기준 YYYY-MM-DD
export function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function getAttendanceConfig(env) {
  const saved = await getDoc(env, CONFIG_PATH);
  return { ...DEFAULT_CONFIG, ...(saved || {}) };
}

// enabled, reward 중 넘어온 값만 바꾸고 나머지는 유지
export async function setAttendanceConfig(env, { enabled, reward }) {
  const current = await getAttendanceConfig(env);
  const next = {
    enabled: enabled ?? current.enabled,
    reward: reward ?? current.reward,
  };
  await setDoc(env, CONFIG_PATH, next);
  return next;
}

export async function checkAttendance(env, userId) {
  // 설정 조회와 유저 조회를 동시에 처리
  const [config, user] = await Promise.all([
    getAttendanceConfig(env),
    getUser(env, userId),
  ]);

  if (!config.enabled) {
    return { ok: false, message: "지금은 출석체크가 꺼져 있어요." };
  }

  const today = todayKST();
  if (user.lastAttendance === today) {
    return { ok: false, message: "오늘은 이미 출석체크를 했어요. 내일 다시 와 주세요!" };
  }

  user.balance += config.reward;
  user.lastAttendance = today;
  user.attendanceCount = (user.attendanceCount || 0) + 1;

  // 저장과 기록을 동시에 처리
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      `출석: +${config.reward.toLocaleString()}해정 (누적 ${user.attendanceCount}일)`
    ),
  ]);

  return {
    ok: true,
    message: `출석 완료! +${config.reward.toLocaleString()}해정을 받았어요. (누적 ${user.attendanceCount}일)`,
  };
}

// ============================================================
// [mining.js]
// ============================================================
// ---------- 튜닝 상수 ----------
const MAX_LEVEL = 100;            // 채굴장 최고 레벨 (이 레벨부터는 더 못 올려요)

const STAMINA_BASE = 15;          // Lv1 최대 체력 (기존 10)
const STAMINA_PER_LEVEL = 1;      // 레벨당 최대 체력 증가량
const STAMINA_REGEN_MINUTES = 10; // 체력 1 회복에 걸리는 시간(분)

const REWARD_BASE_MIN = 40;       // Lv1 채굴 보상 최소 (기존 15)
const REWARD_BASE_MAX = 80;       // Lv1 채굴 보상 최대 (기존 35)
const REWARD_PER_LEVEL = 5;       // 레벨당 보상 증가량(최소/최대 동일하게) (기존 2)

const UPGRADE_BASE_COST = 600;    // Lv1→2 업그레이드 비용(해정)
const UPGRADE_COST_GROWTH = 1.3;  // 레벨마다 비용 배율 (Lv15까지)
const UPGRADE_COST_GROWTH_LATE = 1.08; // Lv15 이후 비용 배율 (최고 레벨이 100이라 비용이 터지지 않게 완만하게)
const UPGRADE_COST_SOFT_LEVEL = 15;    // 이 레벨부터 완만한 배율 적용

const UPGRADE_BASE_COUNT = 30;    // 노가다로 무료 업그레이드하려면 필요한 채굴 횟수(Lv1 기준)
const UPGRADE_COUNT_GROWTH = 10;  // 레벨마다 필요 횟수 증가량

function staminaMaxFor(level) {
  return STAMINA_BASE + (level - 1) * STAMINA_PER_LEVEL;
}

function rewardRangeFor(level) {
  return {
    min: REWARD_BASE_MIN + (level - 1) * REWARD_PER_LEVEL,
    max: REWARD_BASE_MAX + (level - 1) * REWARD_PER_LEVEL,
  };
}

function upgradeCostFor(level) {
  const early = Math.min(level, UPGRADE_COST_SOFT_LEVEL) - 1;
  const late = Math.max(0, level - UPGRADE_COST_SOFT_LEVEL);
  return Math.round(
    UPGRADE_BASE_COST * Math.pow(UPGRADE_COST_GROWTH, early) * Math.pow(UPGRADE_COST_GROWTH_LATE, late)
  );
}

function upgradeCountFor(level) {
  return UPGRADE_BASE_COUNT + (level - 1) * UPGRADE_COUNT_GROWTH;
}

// 유저 문서에 채굴 상태가 없으면 기본값으로 생성
function ensureMining(user) {
  if (!user.mining) {
    user.mining = { level: 1, stamina: STAMINA_BASE, staminaAt: Date.now(), count: 0 };
  }
  // 최고 레벨을 만들기 전에 이미 더 높이 올린 유저는 최고 레벨로 맞춰요
  if (user.mining.level > MAX_LEVEL) user.mining.level = MAX_LEVEL;
  return user.mining;
}

// 경과 시간만큼 체력을 회복시킴 (남은 시간은 staminaAt에 이월해서 손해 없게 함)
function regenStamina(mining) {
  const max = staminaMaxFor(mining.level);
  if (mining.stamina >= max) {
    mining.staminaAt = Date.now();
    return mining;
  }
  const regenMs = STAMINA_REGEN_MINUTES * 60 * 1000;
  const elapsed = Date.now() - mining.staminaAt;
  const gained = Math.floor(elapsed / regenMs);
  if (gained <= 0) return mining;

  const next = Math.min(max, mining.stamina + gained);
  mining.staminaAt = next >= max ? Date.now() : mining.staminaAt + gained * regenMs;
  mining.stamina = next;
  return mining;
}

// 체력이 다음 1칸 찰 때까지 남은 시간(분)
function minutesUntilNextRegen(mining) {
  const regenMs = STAMINA_REGEN_MINUTES * 60 * 1000;
  const waitMs = regenMs - (Date.now() - mining.staminaAt);
  return Math.max(1, Math.ceil(waitMs / 60000));
}

// ---------- 관리자: 모든 유저 체력 가득 채우기 ----------
// 채굴 기록이 있는 유저만 대상이에요. (채굴을 한 번도 안 한 유저는 처음 채굴할 때 체력이 가득 찬 상태로 시작해요)
export async function refillAllStamina(env) {
  const users = await listCollection(env, "users");
  const targets = users.filter((u) => u.mining);
  const now = Date.now();
  let done = 0;
  for (let i = 0; i < targets.length; i += 20) {
    await Promise.all(
      targets.slice(i, i + 20).map(async (u) => {
        const level = Math.min(u.mining.level || 1, MAX_LEVEL);
        const mining = { ...u.mining, level, stamina: staminaMaxFor(level), staminaAt: now };
        await setDoc(env, `users/${u.id}`, { mining });
        done += 1;
      })
    );
  }
  return { total: users.length, refilled: done };
}

// ---------- 채굴 1회 ----------
export async function mineOnce(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  const max = staminaMaxFor(mining.level);

  if (mining.stamina < 1) {
    await saveUser(env, userId, user); // 회복된 staminaAt은 반영
    return {
      ok: false,
      message: `⛏️ 체력이 없어요. (${mining.stamina}/${max})\n약 ${minutesUntilNextRegen(mining)}분 후 체력이 1 회복돼요.`,
    };
  }

  const { min, max: rewardMax } = rewardRangeFor(mining.level);
  const reward = Math.round(min + Math.random() * (rewardMax - min));
  const balanceBefore = user.balance;

  mining.stamina -= 1;
  mining.count += 1;
  user.balance += reward;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `채굴: +${reward.toLocaleString()}해정 (Lv.${mining.level}, 체력 ${mining.stamina}/${max})`),
  ]);

  const required = upgradeCountFor(mining.level);
  return {
    ok: true,
    message: [
      `⛏️ 채굴 완료! +${reward.toLocaleString()}해정`,
      `💰 잔고: ${balanceBefore.toLocaleString()} → **${user.balance.toLocaleString()}해정**`,
      `🔋 체력: ${mining.stamina}/${max}`,
      mining.level >= MAX_LEVEL
        ? `🏆 Lv.${mining.level} (최고 레벨)`
        : `📈 Lv.${mining.level} 진행도: ${mining.count}/${required}회 (채우면 무료 업그레이드 가능)`,
    ].join("\n"),
  };
}

// ---------- 업그레이드 ----------
export async function upgradeMining(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  const cost = upgradeCostFor(mining.level);
  const required = upgradeCountFor(mining.level);

  if (mining.level >= MAX_LEVEL) {
    await saveUser(env, userId, user);
    return { ok: false, message: `🏆 채굴장이 이미 최고 레벨(Lv.${MAX_LEVEL})이에요!` };
  }

  const canGrind = mining.count >= required;
  const canPay = user.balance >= cost;

  if (!canGrind && !canPay) {
    await saveUser(env, userId, user);
    return {
      ok: false,
      message: [
        `⛏️ Lv.${mining.level} → Lv.${mining.level + 1} 업그레이드 조건이 부족해요.`,
        `- 해정으로: ${cost.toLocaleString()}해정 필요 (보유 ${user.balance.toLocaleString()}해정)`,
        `- 노가다로: 이번 레벨에서 ${required}회 채굴 필요 (현재 ${mining.count}/${required})`,
      ].join("\n"),
    };
  }

  // 조건을 둘 다 채웠으면 노가다(무료) 쪽을 우선 적용
  const paidWithMoney = !canGrind && canPay;
  if (paidWithMoney) user.balance -= cost;

  const fromLevel = mining.level;
  mining.level += 1;
  mining.count = 0;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      paidWithMoney
        ? `채굴장 업그레이드: Lv.${fromLevel} → Lv.${mining.level} (-${cost.toLocaleString()}해정)`
        : `채굴장 업그레이드: Lv.${fromLevel} → Lv.${mining.level} (노가다 달성, 무료)`
    ),
  ]);

  return {
    ok: true,
    message: [
      `🎉 채굴장을 Lv.${mining.level}로 업그레이드했어요!${paidWithMoney ? ` (-${cost.toLocaleString()}해정)` : " (노가다 조건 달성, 무료)"}`,
      `🔋 최대 체력: ${staminaMaxFor(mining.level)}`,
    ].join("\n"),
  };
}

// ---------- 정보 조회 ----------
export async function getMiningInfo(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  await saveUser(env, userId, user); // 회복된 staminaAt 반영

  const max = staminaMaxFor(mining.level);
  const { min, max: rewardMax } = rewardRangeFor(mining.level);
  const cost = upgradeCostFor(mining.level);
  const required = upgradeCountFor(mining.level);
  const nextIn = mining.stamina >= max ? "가득 참" : `약 ${minutesUntilNextRegen(mining)}분 후 +1`;

  return [
    `**⛏️ 채굴장 정보 (Lv.${mining.level})**`,
    `체력: ${mining.stamina}/${max} (${nextIn})`,
    `1회 채굴 보상: ${min.toLocaleString()} ~ ${rewardMax.toLocaleString()}해정`,
    ...(mining.level >= MAX_LEVEL
      ? [`🏆 최고 레벨이에요! (Lv.${MAX_LEVEL})`]
      : [
          `다음 업그레이드 (Lv.${mining.level + 1}):`,
          `- 해정으로: ${cost.toLocaleString()}해정`,
          `- 노가다로: ${required}회 채굴 (현재 ${mining.count}/${required})`,
        ]),
  ].join("\n");
}

// ============================================================
// [chart.js]
// ============================================================
// 종목 시세 그래프 이미지를 QuickChart(무료 차트 이미지 서비스)로 만들어요.
// 차트 설정을 보내면 이미지 주소를 돌려주고, 디스코드 임베드의 image.url에 넣으면 그림으로 보여요.
// 글꼴 문제를 피하려고 그래프 안에는 숫자/영문만 쓰고, 한글 제목은 임베드 제목에 적어요.

const QUICKCHART = "https://quickchart.io";
const RED = "#e53935"; // 오름
const BLUE = "#1e88e5"; // 내림

// 밀리초 -> "MM/DD HH:mm" (한국시간)
function labelOf(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace("T", " ").replace("-", "/");
}

function buildConfig(points, up) {
  const color = up ? RED : BLUE;
  return {
    type: "line",
    data: {
      labels: points.map((p) => labelOf(p.t)),
      datasets: [
        {
          data: points.map((p) => p.p),
          borderColor: color,
          backgroundColor: up ? "rgba(229,57,53,0.12)" : "rgba(30,136,229,0.12)",
          borderWidth: 2,
          pointRadius: points.length > 40 ? 0 : 3,
          pointBackgroundColor: color,
          lineTension: 0,
          fill: true,
        },
      ],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 7, maxRotation: 0, fontSize: 11 } }],
        yAxes: [{ ticks: { fontSize: 11 } }],
      },
    },
  };
}

// points: [{ t(ms), p(가격) }], up: 구간 전체가 올랐으면 true(빨강), 아니면 false(파랑)
// 반환: 이미지 주소(URL)
export async function renderStockChart(points, up) {
  const config = buildConfig(points, up);

  // 1) 짧은 주소 발급 (포인트가 많아도 안전). 느리면 포기하고 2번으로.
  try {
    const res = await fetch(`${QUICKCHART}/chart/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "2",
        backgroundColor: "white",
        width: 700,
        height: 360,
        format: "png",
        chart: config,
      }),
      signal: AbortSignal.timeout(5000), // 지연 응답(처리 중…)으로 보내서 3초 제한과 상관없어요
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.url) {
        // 받은 주소가 진짜 이미지를 주는지 확인해요. 아니면 긴 주소 방식으로 넘어가요.
        try {
          const check = await fetch(data.url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
          const type = check.headers.get("content-type") || "";
          if (check.ok && type.startsWith("image/")) return data.url;
          console.error(`QuickChart 이미지 주소 이상(${check.status}, ${type}):`, data.url);
        } catch (err) {
          console.error("QuickChart 이미지 주소 확인 실패:", err.message, data.url);
        }
      } else {
        console.error("QuickChart 짧은 주소 응답 이상:", JSON.stringify(data).slice(0, 200));
      }
    } else {
      console.error(`QuickChart 짧은 주소 발급 실패(${res.status}):`, (await res.text().catch(() => "")).slice(0, 200));
    }
  } catch (err) {
    console.error("QuickChart 짧은 주소 발급 실패:", err.message);
  }

  // 2) 긴 주소로 직접 요청 (주소가 너무 길지 않게 최근 기록만 사용)
  for (const n of [40, 24, 12]) {
    const slice = points.slice(-n);
    const url = `${QUICKCHART}/chart?v=2&w=700&h=360&bkg=white&c=${encodeURIComponent(
      JSON.stringify(buildConfig(slice, up))
    )}`;
    if (url.length <= 1900 || n === 12) return url;
  }
}

// ============================================================
// [crowd.js]
// ============================================================
// 봇 군중(crowd): 봇 수천 명을 문서 몇 개에 몰아서 저장하고, 매 시세 변동 때 메모리에서만 거래시켜요.
// - 봇은 users 컬렉션에 없어서 /랭킹, 알림 DM, 전체 유저 조회에 전혀 섞이지 않아요.
// - 봇의 순매수 압력이 종목 변동률에 더해져 시세에 영향을 줘요. (CROWD_INFLUENCE=0 이면 영향 없음)
//
// 환경변수 (Vercel):
//   CROWD_BOTS       봇 수 (기본 200, 0이면 꺼짐)
//   CROWD_INFLUENCE  시세 영향 계수 (기본 0). 봇 전체가 한 종목을 100% 순매수하면 +이 값(%p)만큼 더해져요. 상한 ±IMPACT_CAP
//                    (IMPACT_CAP 35 기준 추천: 500 — 봇 200명 중 순매수 14명이면 상한)


const BOTS_PER_DOC = 1700; // 문서 1개당 봇 수 (5000명이면 문서 3개)
const START_CASH = 1000; // 봇 시작/재지급 해정 (유저 시작 잔고와 동일)
const ACT_RATE = 0.3; // 한 번 변동 때 행동하는 봇 비율 (성격별로 이 값에 배율을 곱해요)
const IMPACT_CAP = 35; // 봇이 한 번에 줄 수 있는 최대 영향 (%p)
// 한 종목을 "한 번 변동 때" 살 수 있는 봇의 최대 비율 (전체 봇 수 기준). 예: 0.03 이면 봇 5000명 중 150명까지.
// 싼 종목에 봇이 우르르 몰리는 걸 막아줘요. 더 줄이려면 숫자를 낮추고(0.02), 풀려면 높여요(0.05). 0이면 제한 없음.
const MAX_BUY_SHARE = 0.03;

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
const ACT_RATE_MULT = [1, 1, 1, 0.25, 1.3, 1.4, 0.9, 1.2, 0.8, 0.4, 0.15, 0.4, 1, 1.6, 0.5, 0.7, 0.6, 0.1, 0.5, 0.8, 0.9, 0.9, 1.0, 0.7, 0.3, 0.6];

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
  if (ctx.maxBuy > 0 && tally[stock.name].buy >= ctx.maxBuy) return; // 이 종목은 이번에 살 봇이 꽉 참
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
      const cheap = pick([...tradable].sort((a, b) => a.price - b.price).slice(0, 8));
      if (cheap) doBuy(bot, cheap, 0.1 + Math.random() * 0.15, ctx, tally);
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
      if (target && !(ctx.maxBuy > 0 && tally[target.name].buy >= ctx.maxBuy)) {
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
      const cheap = pick([...tradable].sort((a, b) => a.price - b.price).slice(0, 5));
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

  const [docs, allStocks] = await Promise.all([loadBots(env, total), listStocks(env)]);
  // 외국자산(코인·해외주식)은 봇이 거래하지 않아요. (실제 시세를 따라가는 종목이라 봇 쏠림이 가격에 영향을 주면 안 돼요)
  const stocks = allStocks.filter((s) => !isForeign(s));
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
    maxBuy: Math.floor(total * MAX_BUY_SHARE), // 한 종목당 한 번에 살 수 있는 봇 수 (0이면 제한 없음)
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

// ---------- 관리자 콘솔: 봇 초기화 ----------
// 모든 봇의 현금을 cash로 맞추고 보유 종목·짝사랑을 비워요.
// newPersonality=true 면 성격·민감도도 새로 뽑고, false(기본)면 기존 성격은 그대로 둬요.
// 반환: { count, cash }  (봇이 꺼져 있으면 count 0)
export async function resetBots(env, cash = START_CASH, { newPersonality = false } = {}) {
  const { total } = crowdConfig();
  if (total <= 0) return { count: 0, cash };

  const docs = await loadBots(env, total);
  const next = docs.map((bots) =>
    bots.map((b) => (newPersonality ? { ...makeBot(), c: cash } : { c: cash, h: {}, s: b.s, k: b.k }))
  );
  await saveBots(env, next);
  return { count: total, cash };
}

// ============================================================
// [notify.js]
// ============================================================
// ---------- 주식채널 가격 변동 공지 on/off (관리자 콘솔의 체크박스) ----------
// 유저별 DM 알림(/알림설정)과는 별개예요. 기본값은 켜짐입니다.
const ANNOUNCE_PATH = "config/announce";

// config/announce 문서: { enabled, messageIds, channelId }
// messageIds = 마지막으로 올린 공지 메시지 ID들(쉼표로 구분). 다음 변동 때 이 메시지들을 지우고 새로 올립니다.
async function readAnnounceDoc(env) {
  try {
    return (await getDoc(env, ANNOUNCE_PATH)) || {};
  } catch (err) {
    console.error("공지 설정 조회 실패:", err.message);
    return {};
  }
}

export async function getAnnounceConfig(env) {
  const saved = await readAnnounceDoc(env);
  return { enabled: saved.enabled ?? true };
}

export async function setAnnounceConfig(env, { enabled }) {
  const next = { enabled: Boolean(enabled) };
  await setDoc(env, ANNOUNCE_PATH, next);
  return next;
}

const DISCORD_API = "https://discord.com/api/v10";

async function discordRequest(env, method, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`Discord 요청 실패(${res.status}): ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const discordPost = (env, path, body) => discordRequest(env, "POST", path, body);

// 유저에게 DM 보내기 (DM 채널을 먼저 열고 메시지 전송)
export async function sendDM(env, userId, content) {
  const channel = await discordPost(env, "/users/@me/channels", { recipient_id: userId });
  await discordPost(env, `/channels/${channel.id}/messages`, { content });
}

// 상장폐지된 변동의 하락 문구: "-1,200해정, -92.3%"
function dropText(c) {
  const lost = c.before - c.after;
  const pct = c.before > 0 ? (lost / c.before) * 100 : 0;
  return `-${moneyOf(c, lost)}, -${pct.toFixed(1)}%`;
}

// DM용 한 줄 (상장폐지는 별도 문구)
function formatLines(list) {
  return list
    .map((c) => {
      if (c.delisted) {
        return `• 🚫 **${iconName(c)}**: 상장폐지 (${moneyOf(c, c.before)} → ${moneyOf(c, c.after)} · ${dropText(c)} 하락, 보유 주식 소멸)`;
      }
      const pct = ((c.after - c.before) / c.before) * 100;
      const sign = pct > 0 ? "+" : "";
      const mark = c.after > c.before ? UP_MARK : c.after < c.before ? DOWN_MARK : "➖";
      return `• ${mark} **${iconName(c)}**${dangerTag(c.after)}: ${moneyOf(c, c.before)} → ${moneyOf(c, c.after)} (${sign}${pct.toFixed(1)}%)`;
    })
    .join("\n");
}

// 한국시간 기준 현재 시(0~23)
function currentHourKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCHours();
}

// 한국시간 기준 "MM/DD HH:mm"
function formatNowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(5, 16)
    .replace("T", " ")
    .replace("-", "/");
}

// 알림 시간대 안인지 확인합니다.
// - start/end가 없거나 서로 같으면 하루 종일
// - start < end: start시 이상 end시 미만 (예: 9~22)
// - start > end: 자정을 넘기는 구간 (예: 22~6)
export function isWithinNotifyWindow(setting, hour = currentHourKST()) {
  const { start, end } = setting || {};
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

// 공지용 한 줄: 📈 상승 / 📉 하락 / ➖ 변동 없음 / 🚫 상장폐지
// 폐지 위기 종목은 "(±%)" 뒤에 ⚠️ 표시
function announceLine(c) {
  if (c.delisted) {
    return `🚫 **${iconName(c)}**: 상장폐지 (${moneyOf(c, c.before)} → ${moneyOf(c, c.after)} · ${dropText(c)} 하락)`;
  }
  if (c.after === c.before) {
    return `➖ **${iconName(c)}**: ${moneyOf(c, c.after)} (변동 없음)${dangerTag(c.after)}`;
  }
  const up = c.after > c.before;
  const pct = ((c.after - c.before) / c.before) * 100;
  return `${up ? UP_MARK : DOWN_MARK} **${iconName(c)}**: ${moneyOf(c, c.before)} → ${moneyOf(c, c.after)} (${up ? "+" : ""}${pct.toFixed(1)}%)${dangerTag(c.after)}`;
}

// 시세가 변동될 때마다 주식채널(ALLOWED_CHANNEL_ID)에 변동 내역을 공지합니다.
// 유저의 알림 설정과 상관없이 올라가요. (관리자 콘솔의 '가격 변동 알림' 체크를 끄면 올라가지 않음) 실패해도 시세 변동 자체는 막지 않습니다.
// 상장폐지된 종목이 있으면 공지 맨 아래에 안내 문구가 추가돼요.
// 반환값: { sent: true, messages: 보낸 메시지 수 } 또는 { sent: false, reason: "이유" }
export async function announcePriceChanges(env, changes, label = "시세 변동", extraLines = []) {
  if (!env.DISCORD_BOT_TOKEN) {
    return { sent: false, reason: "DISCORD_BOT_TOKEN 환경변수가 없어요" };
  }
  if (!env.ALLOWED_CHANNEL_ID) {
    return { sent: false, reason: "ALLOWED_CHANNEL_ID 환경변수가 없어요" };
  }
  if (changes.length === 0) {
    return { sent: false, reason: "변동 내역이 없어요" };
  }

  // 관리자 콘솔에서 체크를 끈 경우 공지를 보내지 않음
  const doc = await readAnnounceDoc(env);
  if (doc.enabled === false) {
    return { sent: false, reason: "가격 변동 공지가 꺼져 있어요" };
  }

  // 미국 주식은 맨 아래에 따로 묶어서 보여줘요. 장이 닫혀 있으면 가격이 그대로라 평소 공지에서는 빼고,
  // 상장폐지처럼 실제로 일어난 변화만 보여줘요.
  const usChanges = changes.filter((c) => c.kind === "us");
  const usOpen = usChanges.length ? (await getUsMarketStatus(env)).open : true;
  const visibleUs = usOpen ? usChanges : usChanges.filter((c) => c.delisted);
  const mainChanges = changes.filter((c) => c.kind !== "us");

  if (mainChanges.length === 0 && visibleUs.length === 0) {
    return { sent: false, reason: "표시할 변동 내역이 없어요 (미국 장마감)" };
  }

  try {
    const header = `📊 **시세 변동** · ${label} · ${formatNowKST()}`;
    const chunks = [];
    let current = header;

    const pushLine = (line) => {
      // 디스코드 메시지 한도(2000자)를 넘지 않게 나눠서 보냄
      if (current.length + line.length + 1 > 1900) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n" : "") + line;
    };
    const pushBlock = (block) => {
      if (current.length + block.length + 2 > 1900) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n\n" : "") + block;
    };

    // 변동 후 가격이 높은 순으로 정렬 (같으면 이름순). 낮은 순으로 바꾸려면 b.after - a.after 를 a.after - b.after 로
    const sortByPrice = (list) =>
      [...list].sort((a, b) => b.after - a.after || String(a.name).localeCompare(String(b.name), "ko"));

    for (const c of sortByPrice(mainChanges)) pushLine(announceLine(c));

    // 미국 주식 (있을 때만, 하단에 따로)
    if (visibleUs.length) {
      pushBlock(["🌐 **미국 주식**", ...sortByPrice(visibleUs).map(announceLine)].join("\n"));
    }

    // 공시 결과 (있을 때만)
    if (extraLines.length) {
      pushBlock(["📰 **공시 결과**", ...extraLines].join("\n"));
    }

    // 안내 문구: 상장폐지 종목이 있을 때만 표시
    if (mainChanges.some((c) => c.delisted) || visibleUs.some((c) => c.delisted)) {
      pushBlock("🚫 상장폐지된 종목은 거래할 수 없고, 보유 중이던 주식은 모두 사라졌어요.");
    }
    if (current) chunks.push(current);

    // 이전 공지는 지우고 새 메시지를 올림 (항상 채널 맨 아래에 최신 공지만 남음)
    const channel = env.ALLOWED_CHANNEL_ID;
    const oldIds = doc.channelId === channel ? String(doc.messageIds || "").split(",").filter(Boolean) : [];

    for (const id of oldIds) {
      try {
        await discordRequest(env, "DELETE", `/channels/${channel}/messages/${id}`);
      } catch (err) {
        console.error("이전 공지 삭제 실패:", err.message);
      }
    }

    const newIds = [];
    for (const content of chunks) {
      // flags 4096 = 무음 메시지(푸시 알림·소리 없음)
      const message = await discordPost(env, `/channels/${channel}/messages`, { content, flags: 4096 });
      newIds.push(message.id);
    }

    await setDoc(env, ANNOUNCE_PATH, { messageIds: newIds.join(","), channelId: channel });
    return { sent: true, messages: chunks.length, edited: 0 };
  } catch (err) {
    console.error("시세 변동 공지 실패:", err.message);
    return { sent: false, reason: err.message };
  }
}

// 시세 변동 목록을 받아 유저별 알림 설정에 맞춰 DM 전송
// changes: [{ name, before, after, delisted, holders }]
// 상장폐지된 종목은 이미 유저 보유분이 지워진 뒤라서, change.holders(폐지 당시 보유자)로 "보유 종목"을 판단해요.
export async function notifyPriceChanges(env, changes) {
  if (!env.DISCORD_BOT_TOKEN || changes.length === 0) return;

  // 알림 켠 유저 목록 문서를 읽어요. 문서가 아직 없으면 딱 한 번만 users 전체를 읽어서 만들어요.
  const flags = await loadNotifyFlags(env);
  const ids = Object.entries(flags).filter(([, on]) => on).map(([k]) => k.slice(2));
  if (ids.length === 0) return;
  const users = (
    await Promise.all(ids.map((id) => getDoc(env, `users/${id}`).then((u) => u && { id, ...u })))
  ).filter(Boolean);
  const hour = currentHourKST();

  for (const user of users) {
    const setting = user.notify || {};
    if (!setting.all && !setting.up && !setting.down) continue;

    // 유저가 정한 알림 시간대 밖이면 건너뜀 (나중에 몰아서 보내지 않음)
    if (!isWithinNotifyWindow(setting, hour)) continue;

    const held = user.holdings || {};
    const buckets = { heldUp: [], heldDown: [], all: [] };

    for (const c of changes) {
      if (c.after === c.before && !c.delisted) continue;
      const isUp = c.after > c.before;
      const isHeld = (held[c.name] || 0) > 0 || (c.holders || []).includes(user.id);

      // 한 변동당 하나의 알림만 배정 (중복 방지)
      if (isHeld && isUp && setting.up) buckets.heldUp.push(c);
      else if (isHeld && !isUp && setting.down) buckets.heldDown.push(c);
      else if (setting.all) buckets.all.push(c);
    }

    const messages = [];
    if (buckets.heldUp.length) {
      messages.push(
        `${UP_MARK} **[보유 종목 상승]**\n내가 가진 종목 시세가 올랐어요!\n${formatLines(buckets.heldUp)}`
      );
    }
    if (buckets.heldDown.length) {
      messages.push(
        `${DOWN_MARK} **[보유 종목 하락]**\n내가 가진 종목 시세가 떨어졌어요.\n${formatLines(buckets.heldDown)}`
      );
    }
    if (buckets.all.length) {
      messages.push(
        `🔔 **[시세 변동]**\n등록된 종목 시세가 바뀌었어요.\n${formatLines(buckets.all)}`
      );
    }

    for (const content of messages) {
      try {
        await sendDM(env, user.id, content);
      } catch (err) {
        // 특정 유저의 DM이 막혀 있어도 나머지 유저에게는 계속 보냅니다.
        console.error(`알림 전송 실패 (${user.id}):`, err.message);
      }
    }
  }
}

// 급등락 예고 (6분 전): 마지막 공지 메시지 맨 아래에 덧붙입니다.
// 덧붙일 공간이 없거나 공지가 없으면 새 메시지로 올리고, 공지 목록에 추가합니다.
// 반환값: { sent: true, mode: "edit" | "new" } 또는 { sent: false, reason: "이유" }
export async function announcePreAlert(env, slotLabel, leadMin) {
  if (!env.DISCORD_BOT_TOKEN) {
    return { sent: false, reason: "DISCORD_BOT_TOKEN 환경변수가 없어요" };
  }
  if (!env.ALLOWED_CHANNEL_ID) {
    return { sent: false, reason: "ALLOWED_CHANNEL_ID 환경변수가 없어요" };
  }

  // 관리자 콘솔에서 체크를 끈 경우 예고도 보내지 않음
  const doc = await readAnnounceDoc(env);
  if (doc.enabled === false) {
    return { sent: false, reason: "가격 변동 공지가 꺼져 있어요" };
  }

  const channel = env.ALLOWED_CHANNEL_ID;
  const line = `⏰ **${leadMin}분 뒤 ${slotLabel}** (±100%) · 보유 종목을 확인해 주세요!`;

  try {
    const ids =
      doc.channelId === channel ? String(doc.messageIds || "").split(",").filter(Boolean) : [];
    const lastId = ids[ids.length - 1];

    if (lastId) {
      const msg = await discordRequest(env, "GET", `/channels/${channel}/messages/${lastId}`);
      const merged = `${msg.content}\n\n${line}`;
      if (merged.length <= 1900) {
        await discordRequest(env, "PATCH", `/channels/${channel}/messages/${lastId}`, {
          content: merged,
        });
        return { sent: true, mode: "edit" };
      }
    }

    // 공지가 없거나 꽉 찼을 때: 새 메시지로 올리고 공지 목록에 추가
    const message = await discordPost(env, `/channels/${channel}/messages`, {
      content: line,
      flags: 4096,
    });
    await setDoc(env, ANNOUNCE_PATH, {
      messageIds: [...ids, message.id].join(","),
      channelId: channel,
    });
    return { sent: true, mode: "new" };
  } catch (err) {
    console.error("급등락 예고 실패:", err.message);
    return { sent: false, reason: err.message };
  }
}

// ============================================================
// [orders.js]
// ============================================================
// ---------- 예약 매수/매도 (지정가 주문) ----------
// orders/{유저ID} 문서: { items: { [예약번호]: { stock, side, qty, price, at } } }
//  - side "buy" : 현재가가 price 이하가 되면 qty주 매수
//  - side "sell": 현재가가 price 이상이 되면 qty주 매도
//  - dir "down" (손절): 매도인데 현재가가 price 이하가 되면 매도
//  - kind "손절"/"익절", link: /자동매도로 만든 짝. 한쪽이 체결되면 같은 link의 나머지는 자동 취소돼요.
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

// 예: **종목A** 800해정 이하가 되면 3주 매수 (stock을 넘기면 외국자산은 $로 표시)
export function orderText(o, stock) {
  const cond = o.side === "buy" || o.dir === "down" ? "이하가 되면" : "이상이 되면";
  const tag = o.kind ? `[${o.kind}] ` : "";
  return `${tag}**${o.stock}** ${moneyOf(stock, o.price)} ${cond} ${o.qty.toLocaleString()}주 ${sideText(o.side)}`;
}

// 종목별로 이미 매도 예약에 묶인 수량. 손절/익절 짝(같은 link)은 한 번만 세요. (둘 중 하나만 체결되니까)
export function reservedSellQty(items) {
  const reserved = {};
  const seenLinks = new Set();
  for (const o of Object.values(items)) {
    if (o.side !== "sell") continue;
    if (o.link) {
      if (seenLinks.has(o.link)) continue;
      seenLinks.add(o.link);
    }
    reserved[o.stock] = (reserved[o.stock] || 0) + o.qty;
  }
  return reserved;
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

// 여러 건 취소: targets = 예약번호들 또는 "all". 한 번만 읽고 한 번만 저장해요.
// 반환: { removed: 취소된 예약들, missing: 못 찾은 번호들 }
async function cancelOrders(env, userId, targets) {
  const items = await getOrderItems(env, userId);
  const wantsAll = targets.includes("all");
  const ids = wantsAll ? Object.keys(items) : [...new Set(targets)].filter((id) => items[id]);
  const missing = wantsAll ? [] : [...new Set(targets)].filter((id) => !items[id]);
  if (ids.length === 0) return { removed: [], missing };

  const removed = ids.map((id) => ({ id, ...items[id] }));
  for (const id of ids) delete items[id];
  await saveOrderItems(env, userId, items);
  return { removed, missing };
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
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
  const usNames = new Set(stocks.filter((s) => s.kind === "us").map((s) => s.name));
  // 미국 장이 닫혀 있으면 미국 주식 예약은 취소하지 않고 그대로 두었다가, 장이 열리면 체결해요.
  const usOpen = usNames.size === 0 ? true : (await getUsMarketStatus(env)).open;
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
        } else if (!usOpen && usNames.has(o.stock)) {
          continue; // 장 마감: 보류 (취소 아님)
        } else if (o.side === "buy" || o.dir === "down" ? price <= o.price : price >= o.price) {
          hits.push({ id, o, price });
        }
      }
      if (hits.length === 0) return;

      // 2) 체결 전에 먼저 예약에서 지워서, 중간에 문제가 생겨도 같은 예약이 두 번 체결되지 않게 함
      try {
        const fresh = await getOrderItems(env, userId);
        for (const h of hits) delete fresh[h.id];
        // 손절/익절 짝이 있으면 한쪽이 체결될 때 나머지도 같이 지워요
        for (const h of hits) {
          if (!h.o.link) continue;
          for (const [id, o] of Object.entries(fresh)) {
            if (o.link === h.o.link) delete fresh[id];
          }
        }
        await saveOrderItems(env, userId, fresh);
      } catch (err) {
        console.error(`예약 정리 실패 (${userId}):`, err.message);
        return;
      }

      // 3) 한 명의 예약은 순서대로 체결 (잔고/보유량이 이어지므로)
      for (const h of hits) {
        const label = `${h.o.stock} ${h.o.qty.toLocaleString()}주 ${sideText(h.o.side)}`;
        const sk = stockMap[h.o.stock];
        try {
          if (h.gone) {
            summary.cancelled++;
            await addHistory(env, userId, `예약 취소: ${label} (상장폐지)`);
            await logAction(env, { u: userId, cmd: "예약취소", a: label, r: "자동 취소: 상장폐지" });
            await safeDM(env, userId, `⚠️ **[예약 취소]** ${label} 예약이 취소됐어요.\n사유: 상장폐지된 종목이에요.`);
            continue;
          }

          const result =
            h.o.side === "buy"
              ? await buyStock(env, userId, h.o.stock, h.o.qty)
              : await sellStock(env, userId, h.o.stock, h.o.qty);

          if (result.ok) {
            summary.filled++;
            await logAction(env, {
              u: userId,
              cmd: "예약체결",
              a: label,
              r: `예약가 ${moneyOf(sk, h.o.price)} → 체결가 ${moneyOf(sk, h.price)}`,
              amt: result.amount, // 거래 압력 집계용 (매수/매도와 동일하게 buyStock/sellStock이 계산한 값)
            });
            const cond = h.o.side === "buy" || h.o.dir === "down" ? "이하" : "이상";
            await safeDM(
              env,
              userId,
              [
                `✅ **[${h.o.kind || "예약"} 체결]** ${label}`,
                `${h.o.kind ? "기준가" : "예약가"} ${moneyOf(sk, h.o.price)} ${cond} → 체결가 ${moneyOf(sk, h.price)}`,
                ...(h.o.link ? ["(짝으로 걸어둔 손절/익절 주문은 자동으로 취소했어요.)"] : []),
                result.message,
              ].join("\n")
            );
          } else {
            summary.cancelled++;
            await addHistory(env, userId, `예약 취소: ${label} (${result.message.split("\n")[0]})`);
            await logAction(env, { u: userId, cmd: "예약취소", a: label, r: `자동 취소: ${result.message.split("\n")[0]}`.slice(0, 160) });
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

// ============================================================
// [watch.js]
// ============================================================
// ---------- 관심종목 + 가격 알림 ----------
// watch/{유저ID} 문서: { stocks: { [종목]: 담은시각 }, alerts: { [알림번호]: { stock, price, dir, at } } }
//  - dir "up": 현재가가 price 이상이 되면 DM / "down": price 이하가 되면 DM
//  - 알림을 만들 때 현재가와 비교해서 방향을 자동으로 정해요. (현재가보다 높게 걸면 "이상", 낮게 걸면 "이하")
//  - 알림은 한 번 보내고 자동으로 삭제돼요. 가격은 시세가 변동될 때(평소 변동, 급등락)에만 확인해요.
//  - 관심종목/알림이 걸린 종목이 상장폐지되면 DM으로 알리고 자동으로 정리해요.
export const MAX_WATCH_STOCKS = 20;
export const MAX_PRICE_ALERTS = 10;

const watchPath = (userId) => `watch/${userId}`;

export async function getWatch(env, userId) {
  const doc = await getDoc(env, watchPath(userId));
  return { stocks: { ...((doc && doc.stocks) || {}) }, alerts: { ...((doc && doc.alerts) || {}) } };
}

async function saveWatch(env, userId, w) {
  await setDoc(env, watchPath(userId), { stocks: w.stocks, alerts: w.alerts });
}

const alertDirText = (dir) => (dir === "up" ? "이상" : "이하");

// 예: **종목A** 1,500해정 이상이 되면 DM (stock을 넘기면 외국자산은 $로 표시)
export function alertText(a, stock) {
  return `**${a.stock}** ${moneyOf(stock, a.price)} ${alertDirText(a.dir)}이 되면 DM`;
}

// 오래된 알림부터: [{ id, stock, price, dir, at }]
export function alertList(alerts) {
  return Object.entries(alerts)
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));
}

// 시세 변동 직후에 호출: 조건에 도달한 알림을 DM으로 보내고 지워요.
// 반환: { sent: 보낸 알림 수, cleared: 상장폐지로 정리한 수 }
export async function processPriceAlerts(env) {
  const [docs, stocks] = await Promise.all([listCollection(env, "watch"), listStocks(env)]);
  const summary = { sent: 0, cleared: 0 };
  if (stocks.length === 0) return summary; // 목록을 못 읽었을 때 관심종목이 통째로 지워지지 않게
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));

  await Promise.all(
    docs.map(async (doc) => {
      const userId = doc.id;
      const alerts = doc.alerts || {};
      const hits = [];
      for (const [id, a] of Object.entries(alerts)) {
        const price = priceMap[a.stock];
        if (price === undefined) hits.push({ id, a, gone: true });
        else if (a.dir === "up" ? price >= a.price : price <= a.price) hits.push({ id, a, price });
      }
      const goneStocks = Object.keys(doc.stocks || {}).filter((n) => priceMap[n] === undefined);
      if (hits.length === 0 && goneStocks.length === 0) return;

      // 보내기 전에 먼저 지워서, 중간에 문제가 생겨도 같은 알림이 두 번 가지 않게 함
      try {
        const fresh = await getWatch(env, userId);
        for (const h of hits) delete fresh.alerts[h.id];
        for (const n of goneStocks) delete fresh.stocks[n];
        await saveWatch(env, userId, fresh);
      } catch (err) {
        console.error(`가격 알림 정리 실패 (${userId}):`, err.message);
        return;
      }

      for (const h of hits) {
        try {
          if (h.gone) {
            summary.cleared++;
            await safeDM(env, userId, `⚠️ **[가격 알림 취소]** **${h.a.stock}**이(가) 상장폐지돼서 알림을 지웠어요.`);
            continue;
          }
          summary.sent++;
          const sk = stockMap[h.a.stock];
          await addHistory(env, userId, `가격 알림: ${h.a.stock} ${moneyOf(sk, h.price)} (설정 ${moneyOf(sk, h.a.price)} ${alertDirText(h.a.dir)})`);
          await safeDM(
            env,
            userId,
            [
              `🔔 **[가격 알림]** **${h.a.stock}**`,
              `현재가 **${moneyOf(sk, h.price)}** — 설정한 ${moneyOf(sk, h.a.price)} ${alertDirText(h.a.dir)}에 도달했어요.`,
              "(이 알림은 한 번 보내고 자동으로 삭제됐어요.)",
            ].join("\n")
          );
        } catch (err) {
          console.error(`가격 알림 전송 실패 (${userId}, ${h.a.stock}):`, err.message);
        }
      }

      const alertedGone = new Set(hits.filter((h) => h.gone).map((h) => h.a.stock));
      for (const n of goneStocks) {
        if (alertedGone.has(n)) continue;
        summary.cleared++;
        await safeDM(env, userId, `⚠️ **[관심종목]** **${n}**이(가) 상장폐지돼서 관심종목에서 지웠어요.`);
      }
    })
  );

  return summary;
}

// ============================================================
// [futures.js]
// ============================================================
// ---------- 주식 선물 (롱/숏 + 배율) ----------
// 증거금을 걸고 종목이 오를지(롱) 내릴지(숏)에 배율을 곱해 베팅해요.
//  - 평가금 = 증거금 + 증거금 × 배율 × 방향 × (현재가 - 진입가) / 진입가   (롱 +1, 숏 -1)
//  - 평가금이 0이 되면 강제청산(증거금 전액 손실). 정산하면 평가금을 해정으로 돌려받아요.
//  - 저장: futures/{유저ID} 문서의 items 맵 { 번호: { stock, side, margin, lev, entry, t } }
export const MAX_FUTURES_PER_USER = 3;
// 선물도 시세에 영향을 줘요. (진입/청산 금액 = 증거금 × 배율, recordTradeFlow로 stock.flow에 쌓임)
// FUTURES_LIQ_FLOW: 강제청산도 반영할지. 롱이 청산되면 매도 압력이 생겨서 연쇄 청산이 일어날 수 있어요. false면 강제청산은 제외해요.
export const FUTURES_FLOW_ENABLED = true;
export const FUTURES_LIQ_FLOW = true;
export const MIN_FUTURES_MARGIN = 100;
export const FUTURES_LEVERAGES = [2, 3, 5];

const futuresPath = (userId) => `futures/${userId}`;

export async function getFutureItems(env, userId) {
  const doc = await getDoc(env, futuresPath(userId));
  return { ...((doc && doc.items) || {}) };
}

export async function saveFutureItems(env, userId, items) {
  // 포지션이 하나도 안 남으면 문서 자체를 지워요. 안 그러면 빈 문서가 쌓여서
  // processFutures가 매 변동마다 읽는 "futures" 컬렉션이 계속 불어나요.
  if (Object.keys(items).length === 0) {
    await deleteDoc(env, futuresPath(userId));
    return;
  }
  await setDoc(env, futuresPath(userId), { items });
}

// 오래된 포지션부터: [{ id, stock, side, margin, lev, entry, t }]
export function futureList(items) {
  return Object.entries(items)
    .map(([id, f]) => ({ id, ...f }))
    .sort((a, b) => (a.t || 0) - (b.t || 0));
}

function newFutureId(items) {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 6);
  } while (!id || items[id]);
  return id;
}

// 평가금 (0 아래로는 내려가지 않아요)
export function futureEquity(f, price) {
  const dir = f.side === "long" ? 1 : -1;
  const pnl = (f.margin * f.lev * dir * (price - f.entry)) / f.entry;
  return Math.max(0, Math.round(f.margin + pnl));
}

// 강제청산가: 롱은 이 가격 이하, 숏은 이 가격 이상이 되면 증거금을 전부 잃어요
export function futureLiqPrice(f) {
  return f.side === "long" ? Math.ceil(f.entry * (1 - 1 / f.lev)) : Math.floor(f.entry * (1 + 1 / f.lev));
}

const sideLabel = (side) => (side === "long" ? "롱" : "숏");

// 예: **종목A** 📈 롱 x3 · 증거금 1,000해정 · 진입가 1,000해정
export function futureText(f) {
  const m = (n) => (f.cur === "usd" ? centsText(n) : `${n.toLocaleString()}해정`); // 외국자산 선물은 달러
  return `**${f.stock}** ${f.side === "long" ? "📈" : "📉"} ${sideLabel(f.side)} x${f.lev} · 증거금 ${m(f.margin)} · 진입가 ${m(f.entry)}`;
}

// 선물 시작
export async function openFuture(env, userId, { stock: stockName, side, margin, lev }) {
  if (side !== "long" && side !== "short") return { ok: false, message: "방향은 롱 또는 숏 중에서 골라 주세요." };
  if (!FUTURES_LEVERAGES.includes(lev)) {
    return { ok: false, message: `배율은 ${FUTURES_LEVERAGES.join(", ")}배 중에서 골라 주세요.` };
  }
  if (!Number.isSafeInteger(margin) || margin < 1) {
    return { ok: false, message: "증거금은 1 이상의 정수로 입력해 주세요." };
  }

  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };
  const closed = await usClosedNotice(env, [stock]);
  if (closed) return { ok: false, message: closed };

  const usd = isForeign(stock); // 외국자산 선물은 달러 증거금 (입력은 달러 정수, 저장은 센트)
  if (!usd && margin < MIN_FUTURES_MARGIN) {
    return { ok: false, message: `증거금은 ${MIN_FUTURES_MARGIN.toLocaleString()}해정 이상 정수로 입력해 주세요.` };
  }
  const marginAmt = usd ? margin * 100 : margin;

  const items = await getFutureItems(env, userId);
  if (Object.keys(items).length >= MAX_FUTURES_PER_USER) {
    return { ok: false, message: `선물은 최대 ${MAX_FUTURES_PER_USER}개까지 열 수 있어요. \`/선물청산\`으로 먼저 정산해 주세요.` };
  }

  const user = await getUser(env, userId);
  const have = usd ? user.usd || 0 : user.balance;
  if (have < marginAmt) {
    return {
      ok: false,
      message: `${usd ? "달러가" : "잔고가"} 부족해요. (필요: ${moneyOf(stock, marginAmt)}, 보유: ${moneyOf(stock, have)})${usd ? "\n💡 `/환전`으로 해정을 달러로 바꿀 수 있어요." : ""}`,
    };
  }

  const balanceBefore = have;
  if (usd) user.usd = have - marginAmt;
  else user.balance -= marginAmt;
  const id = newFutureId(items);
  const f = { stock: stockName, side, margin: marginAmt, lev, entry: stock.price, t: Date.now(), ...(usd ? { cur: "usd" } : {}) };
  items[id] = f;

  // 증거금 차감을 먼저 저장하고 포지션을 저장해요. 포지션 저장이 실패하면 증거금을 돌려줘요.
  await saveUser(env, userId, user);
  try {
    await saveFutureItems(env, userId, items);
  } catch (err) {
    console.error(`선물 저장 실패 (${userId}):`, err.message);
    if (usd) user.usd += marginAmt;
    else user.balance += marginAmt;
    await saveUser(env, userId, user).catch(() => {});
    return { ok: false, message: "선물을 여는 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }

  await Promise.all([
    addHistory(env, userId, `선물 시작: ${stockName} ${sideLabel(side)} x${lev} · 증거금 ${moneyOf(stock, marginAmt)} (진입가 ${moneyOf(stock, f.entry)})`),
    FUTURES_FLOW_ENABLED
      ? recordTradeFlow(env, [{ stock, amount: (side === "long" ? 1 : -1) * marginAmt * lev }]) // 롱 +, 숏 − (외국자산은 내부에서 제외)
      : null,
  ]);

  const liq = futureLiqPrice(f);
  const after = usd ? user.usd : user.balance;
  return {
    ok: true,
    message: [
      `${side === "long" ? "📈" : "📉"} **선물 시작!** ${stockName} ${sideLabel(side)} x${lev}`,
      `- 증거금 ${moneyOf(stock, marginAmt)} · 진입가 ${moneyOf(stock, f.entry)}`,
      `- 💥 강제청산가: ${moneyOf(stock, liq)} ${side === "long" ? "이하" : "이상"} (증거금 전부 잃어요)`,
      usd ? usdLine(balanceBefore, after) : balanceLine(balanceBefore, after),
    ].join("\n"),
    amount: (side === "long" ? 1 : -1) * marginAmt * lev, // 거래 압력 집계용 (진입 방향대로: 롱 +, 숏 -)
  };
}

// 정산(청산): targets = 포지션 번호들 또는 ["all"]. 평가금을 (해정 선물은 해정, 외국자산 선물은 달러로) 돌려받아요.
export async function closeFutures(env, userId, targets) {
  const [items, stocks] = await Promise.all([getFutureItems(env, userId), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
  const flows = []; // 시세 영향용
  let ids = targets.includes("all") ? Object.keys(items) : [...new Set(targets)].filter((t) => items[t]);
  if (ids.length === 0) {
    return { ok: false, message: "정산할 선물 포지션을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요." };
  }
  // 미국 주식 선물은 장이 닫혀 있으면 정산할 수 없어요. ("전체 정산"이면 나머지만 정산하고 안내해요)
  let heldBack = [];
  if (stocks.some((s) => s.kind === "us")) {
    const usNames = new Set(stocks.filter((s) => s.kind === "us").map((s) => s.name));
    const blocked = ids.filter((id) => usNames.has(items[id].stock));
    if (blocked.length) {
      const closed = await usClosedNotice(env, stocks.filter((s) => s.kind === "us"));
      if (closed) {
        if (blocked.length === ids.length) return { ok: false, message: `${closed}\n(미국 주식 선물은 장이 열려야 정산할 수 있어요.)` };
        heldBack = blocked;
        ids = ids.filter((id) => !blocked.includes(id));
      }
    }
  }

  const [user, fx] = await Promise.all([getUser(env, userId), getFxRate(env)]);
  const krwBefore = user.balance;
  const usdBefore = user.usd || 0;
  const lines = [];
  const closed = [];
  let payoutKrw = 0, payoutUsd = 0, pnlKrw = 0, pnlUsd = 0;
  let hasKrw = false, hasUsd = false;
  let exitAmount = 0; // 거래 압력 집계용: 청산은 진입 방향의 반대 (롱 청산 -, 숏 청산 +)

  for (const id of ids) {
    const f = items[id];
    const isUsd = f.cur === "usd";
    const m = (n) => (isUsd ? centsText(n) : `${n.toLocaleString()}해정`);
    const price = priceMap[f.stock] ?? f.entry; // 폐지돼서 남은 포지션이면 증거금 그대로 돌려줘요
    const equity = futureEquity(f, price);
    const pnl = equity - f.margin;
    if (isUsd) { payoutUsd += equity; pnlUsd += pnl; hasUsd = true; }
    else { payoutKrw += equity; pnlKrw += pnl; hasKrw = true; }
    exitAmount += (f.side === "long" ? -1 : 1) * f.margin * f.lev;
    if (stockMap[f.stock] && !isUsd) flows.push({ stock: stockMap[f.stock], amount: (f.side === "long" ? -1 : 1) * f.margin * f.lev }); // 폐지된 종목은 문서가 없어서 제외
    delete items[id];
    lines.push(`- ${futureText(f)}\n  진입 ${m(f.entry)} → 정산 ${m(price)} · ${isUsd ? profitUsdLabel(pnl, f.margin) : profitLabel(pnl, f.margin)}`);
    closed.push(`${f.stock} ${sideLabel(f.side)} x${f.lev} ${isUsd ? `${pnl < 0 ? "-" : pnl > 0 ? "+" : ""}${centsText(Math.abs(pnl))}` : `${fmtSigned(pnl)}해정`}`);
  }

  // 포지션을 먼저 지워서 같은 포지션이 두 번 정산되지 않게 해요
  await saveFutureItems(env, userId, items);
  user.balance += payoutKrw;
  user.usd = usdBefore + payoutUsd;
  user.realizedProfit = (user.realizedProfit || 0) + pnlKrw + Math.round((pnlUsd * fx.rate) / 100);
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `선물 정산: ${closed.join(", ")} → 잔고 ${user.balance.toLocaleString()}해정 · 달러 ${centsText(user.usd)}`),
    FUTURES_FLOW_ENABLED ? recordTradeFlow(env, flows) : null,
  ]);

  return {
    ok: true,
    message: [
      `**선물 ${ids.length}건 정산 완료**`,
      ...lines,
      ...(hasKrw ? [balanceLine(krwBefore, user.balance)] : []),
      ...(hasUsd ? [usdLine(usdBefore, user.usd)] : []),
      ...(heldBack.length ? [`🌙 미국 장이 닫혀 있어서 ${heldBack.length}건(${[...new Set(heldBack.map((id) => items[id]?.stock))].join(", ")})은 정산하지 않고 그대로 두었어요. 장이 열리면 다시 정산해 주세요.`] : []),
    ].join("\n"),
    amount: exitAmount,
  };
}

// 시세 변동 직후에 호출: 증거금이 바닥난 포지션은 강제청산, 폐지된 종목은 폐지 가격으로 정산
// 반환: { liquidated: 강제청산 수, settled: 폐지 정산 수 }
export async function processFutures(env, changes = []) {
  const [docs, stocks] = await Promise.all([listCollection(env, "futures"), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
  const delistedAfter = Object.fromEntries(changes.filter((c) => c.delisted).map((c) => [c.name, c.after]));
  const summary = { liquidated: 0, settled: 0 };

  await Promise.all(
    docs.map(async (doc) => {
      const userId = doc.id;
      const hits = [];
      for (const [id, f] of Object.entries(doc.items || {})) {
        const gone = priceMap[f.stock] === undefined;
        const price = priceMap[f.stock] ?? delistedAfter[f.stock] ?? f.entry;
        const equity = futureEquity(f, price);
        if (gone || equity <= 0) hits.push({ id, f, price, equity, gone });
      }
      if (hits.length === 0) return;

      // 포지션을 먼저 지우고, 그 사이 유저가 직접 정산한 건은 건너뛰어요 (이중 지급 방지)
      let live;
      try {
        const fresh = await getFutureItems(env, userId);
        live = hits.filter((h) => fresh[h.id]);
        for (const h of live) delete fresh[h.id];
        await saveFutureItems(env, userId, fresh);
      } catch (err) {
        console.error(`선물 정리 실패 (${userId}):`, err.message);
        return;
      }
      if (live.length === 0) return;

      try {
        const user = await getUser(env, userId);
        const fxRate = (await getFxRate(env)).rate;
        const lines = [];
        const flows = []; // 강제청산 압력 (폐지 정산은 문서가 없어서 제외)
        for (const h of live) {
          const pnl = h.equity - h.f.margin;
          const isUsd = h.f.cur === "usd";
          const m = (n) => (isUsd ? centsText(n) : `${n.toLocaleString()}해정`);
          if (isUsd) user.usd = (user.usd || 0) + h.equity;
          else user.balance += h.equity;
          user.realizedProfit = (user.realizedProfit || 0) + (isUsd ? Math.round((pnl * fxRate) / 100) : pnl);
          const label = `${h.f.stock} ${sideLabel(h.f.side)} x${h.f.lev}`;
          if (h.gone) {
            summary.settled++;
            lines.push(`🏁 ${label} — 상장폐지로 ${m(h.price)}에 정산 (${pnl < 0 ? "-" : pnl > 0 ? "+" : ""}${m(Math.abs(pnl))})`);
          } else {
            summary.liquidated++;
            if (FUTURES_LIQ_FLOW && stockMap[h.f.stock] && !isUsd) {
              flows.push({ stock: stockMap[h.f.stock], amount: (h.f.side === "long" ? -1 : 1) * h.f.margin * h.f.lev });
            }
            lines.push(`💥 ${label} — 시세가 ${m(h.price)}이 되어 강제청산 (-${m(h.f.margin)})`);
          }
        }
        // 거래 압력 집계용: 청산은 진입 방향의 반대 (롱 청산 -, 숏 청산 +)
        const exitAmount = live.reduce((sum, h) => sum + (h.f.side === "long" ? -1 : 1) * h.f.margin * h.f.lev, 0);
        await saveUser(env, userId, user);
        await Promise.all([
          addHistory(env, userId, `선물 자동 정산 ${live.length}건 → 잔고 ${user.balance.toLocaleString()}해정`),
          recordTradeFlow(env, flows),
          logAction(env, { u: userId, cmd: "선물청산", a: `${live.length}건`, r: "자동 정산: 강제청산/상장폐지", amt: exitAmount }),
          safeDM(env, userId, [`⚠️ **[선물 자동 정산]**`, ...lines].join("\n")),
        ]);
      } catch (err) {
        console.error(`선물 정산 실패 (${userId}):`, err.message);
      }
    })
  );

  return summary;
}

// ============================================================
// [fx.js] 환율 · 환전 (달러)
// ============================================================
// - 달러 잔고는 user.usd 에 "센트"(1달러 = 100센트) 정수로 저장해요.
//   외국자산(코인·미국주식) 가격 숫자도 센트예요. (가격 1000 = $10.00)
// - 환율 = 1달러가 몇 해정인지. 1시간마다 직전 환율에서 ±FX_STEP_PCT%만 움직여요. (FX_MIN ~ FX_MAX 안에서, config/fxRate)
// - 환전할 때 FX_FEE_RATE 수수료를 "받는 쪽" 금액에서 떼요.
export const FX_BASE = 100;
export const FX_MIN = 70;
export const FX_MAX = 140;
export const FX_FEE_RATE = 0.01; // 환전 수수료 1%
export const FX_STEP_PCT = 5; // 1시간마다 직전 환율에서 최대 ±5%만 움직여요
export const FX_MIN_KRW = 10; // 해정 → 달러 최소 환전액

const FX_PATH = "config/fxRate";
const FX_MSG_PATH = "config/fxRateMsg"; // 마지막 환율 공지 메시지 ID
const FX_ANNOUNCE = true; // false면 환율 변경 공지를 안 올려요
const FX_REPLACE = true; // true면 새 공지를 올리기 전에 지난 환율 공지를 지워요
const FX_CACHE_MS = 30 * 1000;
const FX_HOUR_MS = 60 * 60 * 1000;

let fxCache = { at: 0, doc: null };

// 센트 -> "$12.34"
export function centsText(cents) {
  const n = Math.round(Number(cents) || 0);
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, "0")}`;
}

// 종목 종류에 맞는 금액 문구: 외국자산은 달러, 나머지는 해정
export const moneyOf = (stock, n) => (isForeign(stock) ? centsText(n) : `${n.toLocaleString()}해정`);

// 해정 + 달러를 한 문구로 (0인 쪽은 빼요)
export function moneyPair(krw, cents) {
  return [krw > 0 ? `${krw.toLocaleString()}해정` : "", cents > 0 ? centsText(cents) : ""].filter(Boolean).join(" + ") || "0해정";
}

export function usdLine(before, after) {
  const diff = after - before;
  return `💵 달러: ${centsText(before)} → **${centsText(after)}** (${diff > 0 ? "+" : diff < 0 ? "-" : ""}${centsText(Math.abs(diff))})`;
}

// profitLabel 의 달러(센트) 버전
export function profitUsdLabel(profit, cost, plain = false) {
  const UP = plain ? UP_PLAIN : UP_MARK;
  const DOWN = plain ? DOWN_PLAIN : DOWN_MARK;
  const pct = cost > 0 ? (profit / cost) * 100 : 0;
  const mark = profit > 0 ? `${UP} 이득` : profit < 0 ? `${DOWN} 손해` : "➖ 본전";
  return `${mark} ${profit > 0 ? "+" : profit < 0 ? "-" : ""}${centsText(Math.abs(profit))} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

export const rateText = (rate) => `1달러 = ${Number(rate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}해정`;

// 선물 포지션의 평가금을 해정으로 바꿀 배율 (달러 포지션만 환율 적용)
export const fxMul = (f, rate) => (f && f.cur === "usd" ? rate / 100 : 1);

// 종목별 "주당 해정 가격" (외국자산은 센트 → 해정 환산). 랭킹/순자산 계산용이라 소수가 나올 수 있어요.
export function krwPriceMap(stocks, rate) {
  return Object.fromEntries(stocks.map((s) => [s.name, isForeign(s) ? (s.price * rate) / 100 : s.price]));
}

export async function getFxRate(env) {
  const now = Date.now();
  if (fxCache.doc && now - fxCache.at < FX_CACHE_MS) return fxCache.doc;
  let doc = await getDoc(env, FX_PATH);
  if (!doc || !(doc.rate > 0)) {
    doc = { rate: FX_BASE, prev: FX_BASE, at: now };
    await setDoc(env, FX_PATH, doc);
  }
  fxCache = { at: now, doc };
  return doc;
}

// 매시 1번 호출(크론): 직전 환율에서 ±FX_STEP_PCT% 안으로만 움직여 저장하고 주식채널에 무음 공지
export async function rollFxRate(env) {
  const now = Date.now();
  const prev = await getFxRate(env);
  let raw = prev.rate * (1 + (Math.random() * 2 - 1) * (FX_STEP_PCT / 100));
  if (raw > FX_MAX) raw = FX_MAX - (raw - FX_MAX); // 범위 밖으로 나가면 안쪽으로 튕겨요 (끝에 달라붙지 않게)
  if (raw < FX_MIN) raw = FX_MIN + (FX_MIN - raw);
  const rate = +Math.min(FX_MAX, Math.max(FX_MIN, raw)).toFixed(2);
  const next = { rate, prev: prev.rate, at: now };
  await setDoc(env, FX_PATH, next);
  fxCache = { at: 0, doc: null };

  if (FX_ANNOUNCE && env.ALLOWED_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
    try {
      const arrow = rate > prev.rate ? "📈" : rate < prev.rate ? "📉" : "➖";
      if (FX_REPLACE) {
        const old = await getDoc(env, FX_MSG_PATH).catch(() => null);
        if (old?.messageId) {
          await discordRequest(env, "DELETE", `/channels/${env.ALLOWED_CHANNEL_ID}/messages/${old.messageId}`).catch(() => {});
        }
      }
      const nextUnix = Math.floor((Math.ceil((now + 1) / FX_HOUR_MS) * FX_HOUR_MS) / 1000);
      const posted = await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
        content: `💵 **환율 변경** ${arrow} ${prev.rate}해정 → **${rate}해정** (1달러 기준)\n다음 변경: <t:${nextUnix}:t> (<t:${nextUnix}:R>)`,
        flags: 4096,
        allowed_mentions: { parse: [] },
      });
      if (FX_REPLACE && posted?.id) await setDoc(env, FX_MSG_PATH, { messageId: posted.id });
    } catch (err) {
      console.error("환율 공지 실패:", err.message);
    }
  }
  return next;
}

// /환율
export async function fxInfoText(env, userId) {
  const [fx, user] = await Promise.all([getFxRate(env), getUser(env, userId)]);
  const diff = +(fx.rate - fx.prev).toFixed(2);
  const arrow = diff > 0 ? UP_MARK : diff < 0 ? DOWN_MARK : "➖";
  const nextUnix = Math.floor((Math.ceil((Date.now() + 1) / FX_HOUR_MS) * FX_HOUR_MS) / 1000);
  return [
    `💵 **현재 환율** ${rateText(fx.rate)} ${arrow} (지난 환율 ${fx.prev} 대비 ${diff > 0 ? "+" : ""}${diff})`,
    `범위 ${FX_MIN}~${FX_MAX}해정 · 다음 변경 <t:${nextUnix}:t> (<t:${nextUnix}:R>)`,
    `환전 수수료 ${+(FX_FEE_RATE * 100).toFixed(2)}% (받는 쪽 금액에서 떼요)`,
    `내 달러: **${centsText(user.usd)}** (≈ ${Math.floor(((user.usd || 0) * fx.rate) / 100).toLocaleString()}해정)`,
    "`/환전`으로 해정과 달러를 바꿀 수 있어요. 외국자산(🌐₿)은 달러로 사고팔아요.",
  ].join("\n");
}

// /환전  dir: "toUsd"(해정→달러, amount=낼 해정) | "toKrw"(달러→해정, amount=낼 달러, 정수)
export async function exchangeMoney(env, userId, dir, amount) {
  if (dir !== "toUsd" && dir !== "toKrw") return { ok: false, message: "환전 방향을 골라 주세요." };
  if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false, message: "환전할 금액은 1 이상의 정수로 입력해 주세요." };
  const [user, fx] = await Promise.all([getUser(env, userId), getFxRate(env)]);
  const rate = fx.rate;
  const krwBefore = user.balance;
  const usdBefore = user.usd || 0;

  if (dir === "toUsd") {
    if (amount < FX_MIN_KRW) return { ok: false, message: `해정 → 달러는 ${FX_MIN_KRW}해정 이상부터 바꿀 수 있어요.` };
    if (krwBefore < amount) return { ok: false, message: `잔고가 부족해요. (필요: ${amount.toLocaleString()}해정, 보유: ${krwBefore.toLocaleString()}해정)` };
    const cents = Math.floor(((amount * 100) / rate) * (1 - FX_FEE_RATE));
    if (cents < 1) return { ok: false, message: "금액이 너무 작아서 1센트도 받을 수 없어요. 더 많이 바꿔 주세요." };
    user.balance = krwBefore - amount;
    user.usd = usdBefore + cents;
    await Promise.all([
      saveUser(env, userId, user),
      addHistory(env, userId, `환전: ${amount.toLocaleString()}해정 → ${centsText(cents)} (환율 ${rate})`),
    ]);
    return {
      ok: true,
      message: [
        `💱 **환전 완료** ${amount.toLocaleString()}해정 → **${centsText(cents)}** (${rateText(rate)}, 수수료 ${+(FX_FEE_RATE * 100).toFixed(2)}%)`,
        balanceLine(krwBefore, user.balance),
        usdLine(usdBefore, user.usd),
      ].join("\n"),
    };
  }

  const cents = amount * 100;
  if (usdBefore < cents) return { ok: false, message: `달러가 부족해요. (필요: ${centsText(cents)}, 보유: ${centsText(usdBefore)})` };
  const krw = Math.floor(((cents * rate) / 100) * (1 - FX_FEE_RATE));
  if (krw < 1) return { ok: false, message: "금액이 너무 작아요. 더 많이 바꿔 주세요." };
  user.usd = usdBefore - cents;
  user.balance = krwBefore + krw;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `환전: ${centsText(cents)} → ${krw.toLocaleString()}해정 (환율 ${rate})`),
  ]);
  return {
    ok: true,
    message: [
      `💱 **환전 완료** ${centsText(cents)} → **${krw.toLocaleString()}해정** (${rateText(rate)}, 수수료 ${+(FX_FEE_RATE * 100).toFixed(2)}%)`,
      balanceLine(krwBefore, user.balance),
      usdLine(usdBefore, user.usd),
    ].join("\n"),
  };
}

// ============================================================
// [bank.js]
// ============================================================
// ---------- 해정 은행 (예금 / 대출 / 이자 / 연체) ----------
// 이자는 "시간이 흐른 만큼" 계산해요. 명령어를 쓰는 순간이나 크론이 돌 때마다 마지막 계산 이후의
// 이자를 더하기 때문에, 언제 조회해도 그 시각 기준으로 정확한 금액이 나와요. (실시간)
//  - 예금: 일 DEPOSIT_RATE 이자. 쌓인 이자는 예금에 바로 합쳐져요.
//  - 대출: 원금 × 일 이자율 × 지난 시간(일). 기간(1/3/7일)마다 이자율이 달라요.
//    만기가 지나면 일 이자율에 LOAN_PENALTY_RATE(연체 이자)가 더 붙어요.
//  - 상환: 이자 먼저, 그다음 원금. 일찍 갚으면 그때까지 쌓인 이자만 내요.
//  - 만기: 잔고 → 예금 순서로 자동 회수. 모자라면 연체, 연체 LIQUIDATE_AFTER_HOURS시간 뒤에는 보유 주식 강제 매도.
//  - 저장: bank/{유저ID} = { deposit, depositAt, earned, loans: { 번호: 대출 } }
//    대출 = { principal, unpaid, rate, term, takenAt, due, lastAt, borrowed, warned? }
export const DEPOSIT_RATE = 0.01; // 예금 일 1% (시장 배율 0.2~2.0배 → 0.2%~2%)
export const LOAN_TERMS = { 1: 0.12, 3: 0.1, 7: 0.08 }; // 기간(일) -> 일 이자율
export const LOAN_PENALTY_RATE = 0.15; // 연체 시 일 +15%p
export const LOAN_MIN = 100;
export const MAX_LOANS_PER_USER = 3;
export const LOAN_LIMIT_RATIO = 0.3; // 한도 = 순자산의 30%
export const LOAN_FEE_RATE = 0.01; // 대출 수수료: 빌릴 때 원금의 1%를 먼저 떼고 받아요 (빚은 원금 그대로)
export const LOAN_LIMIT_MIN = 1000; // 순자산이 적어도 이만큼은 빌릴 수 있어요
export const LIQUIDATE_AFTER_HOURS = 6; // 연체 후 이 시간이 지나면 보유 주식 강제 매도
export const REMIND_BEFORE_HOURS = 6; // 만기 이 시간 전에 DM으로 알려줘요
const BANK_HOUR_MS = 60 * 60 * 1000;

// ---------- 시장 금리 (은행 이자 랜덤화) ----------
// 매시 정각 크론이 배율(0.2~2.0배)을 하나 뽑아서 예금/대출 기준금리에 함께 곱해요.
//  - 예금 1% 기준 → 0.2%~2.0% 사이에서 움직여요.
//  - index: 예금 복리 계산용 누적 지수. 금리가 바뀔 때마다 그 구간만큼 곱해서 쌓아요.
//    (유저가 오래 안 들어와도 index 비율 하나로 정확히 계산 가능)
//  - 저장: config/bankRate = { mult, depositRate, loanRates, index, indexAt }
export const MARKET_RATE_MIN_MULT = 0.2;
export const MARKET_RATE_MAX_MULT = 2.0;
// 대출 금리 하한(일): 예금이 가장 높을 때(1% × 2.0배 = 2.0%)보다 항상 비싸게 해서
// "싸게 빌려서 예금" 차익거래를 막아요. 신용등급 배율까지 곱한 뒤에도 이 아래로는 안 내려가요.
export const LOAN_RATE_FLOOR = +(DEPOSIT_RATE * MARKET_RATE_MAX_MULT * 1.2).toFixed(4); // 일 2.4%

const bankRatePath = "config/bankRate";

export async function getBankRate(env) {
  const doc = await getDoc(env, bankRatePath);
  if (doc?.index) return doc;
  // 아직 한 번도 안 돌았으면 배율 1.0(=기존 고정금리)으로 초기화하고 "저장"해요.
  // (저장하지 않으면 indexAt이 매번 지금 시각으로 바뀌어서 예금 이자가 쌓이지 않아요)
  const init = { mult: 1, depositRate: DEPOSIT_RATE, loanRates: { ...LOAN_TERMS }, index: 1, indexAt: Date.now() };
  await setDoc(env, bankRatePath, init);
  return init;
}

// 지금 시각의 누적 예금 지수 = 마지막 금리 변경 때까지의 index × 그 이후 현재 금리로 쌓인 만큼
function indexNow(rate, now) {
  const days = Math.max(0, now - rate.indexAt) / DAY_MS;
  return rate.index * (1 + rate.depositRate * days);
}

function randomMult() {
  return +(MARKET_RATE_MIN_MULT + Math.random() * (MARKET_RATE_MAX_MULT - MARKET_RATE_MIN_MULT)).toFixed(3);
}

// 매시 1번 호출: 지난 구간 이자를 index에 반영하고 새 배율을 뽑아 저장해요
export async function rollBankRate(env) {
  const now = Date.now();
  const prev = await getBankRate(env);

  const elapsedDays = Math.max(0, now - prev.indexAt) / DAY_MS;
  const index = prev.index * (1 + prev.depositRate * elapsedDays);

  const mult = randomMult();
  const depositRate = +(DEPOSIT_RATE * mult).toFixed(5);
  const loanRates = Object.fromEntries(
    Object.entries(LOAN_TERMS).map(([term, base]) => [term, +(base * mult).toFixed(5)])
  );

  const next = { mult, depositRate, loanRates, index, indexAt: now };
  await setDoc(env, bankRatePath, next);

  // 주식채널에 무음 한 줄 공지 (실패해도 금리 변경 자체는 그대로)
  if (BANK_RATE_ANNOUNCE && env.ALLOWED_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
    try {
      const arrow = mult > prev.mult ? "📈" : mult < prev.mult ? "📉" : "➖";
      // 지난번 금리 공지가 있으면 먼저 지워서, 채널에 금리 공지가 항상 1개만 남게 해요 (도배 방지)
      if (BANK_RATE_REPLACE) {
        const old = await getDoc(env, BANK_RATE_MSG_PATH).catch(() => null);
        if (old?.messageId) {
          await discordRequest(env, "DELETE", `/channels/${env.ALLOWED_CHANNEL_ID}/messages/${old.messageId}`).catch(() => {});
        }
      }
      const posted = await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
        content:
          `🏦 **은행 금리 변경** ${arrow} 시장금리 ×${prev.mult ?? 1} → ×${mult}\n` +
          `예금 일 ${pctText(depositRate)} · 대출 ${loanRatesText(next)} (신용등급 B 기준)`,
        flags: 4096,
        allowed_mentions: { parse: [] },
      });
      if (BANK_RATE_REPLACE && posted?.id) await setDoc(env, BANK_RATE_MSG_PATH, { messageId: posted.id });
    } catch (err) {
      console.error("은행 금리 공지 실패:", err.message);
    }
  }
  return next;
}

const bankPath = (userId) => `bank/${userId}`;
const pctText = (r) => `${+(r * 100).toFixed(2)}%`;
const unixOf = (ms) => Math.floor(ms / 1000);

// ---------- 시장금리 표시용 도우미 ----------
const BANK_RATE_ANNOUNCE = true; // false로 바꾸면 금리 변경 공지를 안 올려요
const BANK_RATE_REPLACE = true; // true: 새 금리 공지를 올리기 전에 지난 금리 공지를 지워요 (채널에 1개만 남음). false: 예전처럼 계속 쌓여요
const BANK_RATE_MSG_PATH = "config/bankRateMsg"; // 마지막 금리 공지 메시지 ID를 저장하는 곳
// 대출 이자율(일): 시장금리 × 신용등급 배율, 단 하한(LOAN_RATE_FLOOR) 아래로는 안 내려가요 (takeLoan과 같은 계산)
const loanRateOf = (base, mul = 1) => +Math.max(base * mul, LOAN_RATE_FLOOR).toFixed(4);
// 다음 금리 변경 시각 = 다음 정각 (크론이 매시 정각에 돌아요)
const nextRateChangeMs = (now) => Math.ceil((now + 1) / BANK_HOUR_MS) * BANK_HOUR_MS;
const nextChangeText = (now) => `<t:${unixOf(nextRateChangeMs(now))}:t> (<t:${unixOf(nextRateChangeMs(now))}:R>)`;
function loanRatesText(rate, mul = 1) {
  return Object.keys(LOAN_TERMS)
    .map((d) => `${d}일 ${pctText(loanRateOf(rate?.loanRates?.[d] ?? LOAN_TERMS[d], mul))}`)
    .join(" / ");
}
// 한 줄 요약: 현재 시장금리 (배율 · 예금 · 대출 3종 · 다음 변경)
function marketRateLine(rate, now, mul = 1) {
  const depositRate = rate?.depositRate ?? DEPOSIT_RATE;
  return `🏦 **현재 시장금리** ×${rate?.mult ?? 1} · 예금 일 ${pctText(depositRate)} · 대출 ${loanRatesText(rate, mul)} · 다음 변경 ${nextChangeText(now)}`;
}
// 디스코드가 알아서 "3일 뒤"처럼 실시간으로 바꿔 보여주는 시각 표시
const dueText = (ms) => `<t:${unixOf(ms)}:f> (<t:${unixOf(ms)}:R>)`;
const depositOf = (bank) => Math.floor(bank.deposit + 1e-9);

// ---------- 신용등급 ----------
// 신용점수(0~1000, 처음 600점)가 등급(S~F)을 정하고, 등급이 대출 한도와 이자를 바꿔요.
//  - 제때 완납: +25점 (500해정 이상 빌렸고 6시간 이상 쓴 대출만 인정 → 빌리자마자 갚는 점수 노가다 방지)
//  - 연체 시작: -100점 (대출 1건당 1번), 강제 매도 발생: -150점 (대출 1건당 1번), 연체 후 완납: +5점
//  - 저장: bank/{유저ID}.credit = { score, onTime, late }
export const CREDIT_START = 600;
export const CREDIT_MAX = 1000;
export const CREDIT_ON_TIME = 25;
export const CREDIT_AFTER_LATE = 5;
export const CREDIT_LATE_PENALTY = -100;
export const CREDIT_LIQUIDATE_PENALTY = -150;
export const CREDIT_MIN_LOAN = 500;
export const CREDIT_MIN_HOLD_HOURS = 6;
export const CREDIT_GRADES = [
  { name: "S", min: 900, limitMul: 1.2, rateMul: 0.8 },
  { name: "A", min: 750, limitMul: 1.1, rateMul: 0.9 },
  { name: "B", min: 600, limitMul: 1.0, rateMul: 1.0 },
  { name: "C", min: 450, limitMul: 0.8, rateMul: 1.1 },
  { name: "D", min: 300, limitMul: 0.6, rateMul: 1.25 },
  { name: "F", min: 0, limitMul: 0.4, rateMul: 1.5 },
];

export function creditGrade(credit) {
  const score = credit?.score ?? CREDIT_START;
  return CREDIT_GRADES.find((g) => score >= g.min) || CREDIT_GRADES[CREDIT_GRADES.length - 1];
}

function addCredit(bank, delta) {
  const c = (bank.credit = { score: CREDIT_START, onTime: 0, late: 0, ...(bank.credit || {}) });
  c.score = Math.max(0, Math.min(CREDIT_MAX, c.score + delta));
  return c.score;
}

const creditText = (bank, delta) => {
  const score = bank.credit.score;
  return `💳 신용점수 ${delta > 0 ? "+" : ""}${delta} → **${score}점** (등급 ${creditGrade(bank.credit).name})`;
};

// 완납했을 때 점수 (loan은 완납된 대출). 점수 변화가 없으면 null
function creditOnRepaid(bank, loan, now) {
  if (loan.lateMarked) {
    addCredit(bank, CREDIT_AFTER_LATE);
    return creditText(bank, CREDIT_AFTER_LATE);
  }
  const heldHours = (now - loan.takenAt) / BANK_HOUR_MS;
  if ((loan.borrowed || 0) >= CREDIT_MIN_LOAN && heldHours >= CREDIT_MIN_HOLD_HOURS && now <= loan.due) {
    addCredit(bank, CREDIT_ON_TIME);
    bank.credit.onTime++;
    return creditText(bank, CREDIT_ON_TIME);
  }
  return null;
}

// 연체가 처음 확인될 때 한 번만 깎아요
function markLate(bank, loan) {
  if (loan.lateMarked) return "";
  loan.lateMarked = true;
  addCredit(bank, CREDIT_LATE_PENALTY);
  bank.credit.late++;
  return `\n${creditText(bank, CREDIT_LATE_PENALTY)} — 연체 기록이 남았어요. 대출 한도가 줄고 이자가 비싸질 수 있어요.`;
}

// 강제 매도가 일어났을 때 한 번만 깎아요
function markLiquidated(bank, loan) {
  if (loan.liqMarked) return "";
  loan.liqMarked = true;
  addCredit(bank, CREDIT_LIQUIDATE_PENALTY);
  return creditText(bank, CREDIT_LIQUIDATE_PENALTY) + " (강제 매도)";
}

function creditLine(bank) {
  const g = creditGrade(bank.credit);
  const score = bank.credit?.score ?? CREDIT_START;
  const next = [...CREDIT_GRADES].reverse().find((x) => x.min > score);
  const hint = next ? ` · ${next.name}등급까지 ${next.min - score}점` : " · 최고 등급!";
  return `💳 **신용등급 ${g.name}** (${score}점${hint}) · 대출 한도 ×${g.limitMul} · 대출 이자 ×${g.rateMul}`;
}

export async function getBank(env, userId) {
  const [doc, rate] = await Promise.all([getDoc(env, bankPath(userId)), getBankRate(env)]);
  const bank = { deposit: 0, depositAt: 0, depositIndex: 0, earned: 0, loans: {}, credit: { score: CREDIT_START, onTime: 0, late: 0 }, ...(doc || {}) };
  if (!bank.loans) bank.loans = {};
  bank.rate = rate; // accrueBank이 예금 이자를 계산할 때 써요 (DB에는 저장 안 됨)
  return bank;
}

async function saveBank(env, userId, bank) {
  await setDoc(env, bankPath(userId), {
    deposit: bank.deposit,
    depositAt: bank.depositAt,
    depositIndex: Number.isFinite(bank.depositIndex) ? bank.depositIndex : 0,
    earned: bank.earned || 0,
    loans: bank.loans,
    credit: bank.credit || { score: CREDIT_START, onTime: 0, late: 0 },
  });
}

// 대출 한 건의 이자를 now까지 계산해서 unpaid에 더해요 (만기 이후 구간은 연체 이자율)
function accrueLoan(loan, now) {
  const from = loan.lastAt || loan.takenAt;
  if (now <= from) return loan;
  const normalMs = Math.max(0, Math.min(now, loan.due) - from);
  const lateMs = Math.max(0, now - Math.max(from, loan.due));
  loan.unpaid += (loan.principal * (loan.rate * normalMs + (loan.rate + LOAN_PENALTY_RATE) * lateMs)) / DAY_MS;
  loan.lastAt = now;
  return loan;
}

// 예금 이자 + 모든 대출 이자를 now까지 계산 (bank를 직접 바꿔요. 조회만 할 때는 복사본을 넘기세요)
function accrueBank(bank, now) {
  const idx = indexNow(bank.rate, now);
  if (bank.deposit > 0) {
    let gain = 0;
    if (Number.isFinite(bank.depositIndex) && bank.depositIndex > 0) {
      // 새 방식: 마지막 정산 때의 지수 대비 지금 지수의 비율만큼 불어나요 (구간별 금리가 전부 반영됨)
      gain = bank.deposit * Math.max(0, idx / bank.depositIndex - 1);
    } else if (bank.depositAt && now > bank.depositAt) {
      // 마이그레이션: depositIndex가 없는 예전 계정은 지금까지를 예전 고정금리로 정산해요 (딱 한 번)
      gain = (bank.deposit * DEPOSIT_RATE * (now - bank.depositAt)) / DAY_MS;
    }
    bank.deposit += gain;
    bank.earned = (bank.earned || 0) + gain;
  }
  bank.depositIndex = idx; // 예금이 0원이어도 기록해서, 새로 맡길 때 그 시점부터 계산되게 해요
  bank.depositAt = now;
  for (const loan of Object.values(bank.loans)) accrueLoan(loan, now);
  return bank;
}

const loanOwed = (loan) => loan.principal + Math.max(0, Math.ceil(loan.unpaid - 1e-9)); // 지금 다 갚으려면 필요한 돈
const interestOwed = (loan) => Math.max(0, Math.ceil(loan.unpaid - 1e-9)); // -0 방지
const isOverdue = (loan, now) => now > loan.due;

// 이자 먼저, 남으면 원금. 실제로 낸 { toInterest, toPrincipal } 반환
function payLoan(loan, amount) {
  const toInterest = Math.min(amount, interestOwed(loan));
  loan.unpaid = Math.max(0, loan.unpaid - toInterest);
  const toPrincipal = Math.min(amount - toInterest, loan.principal);
  loan.principal -= toPrincipal;
  return { toInterest, toPrincipal };
}

function newLoanId(loans) {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 6);
  } while (!id || loans[id]);
  return id;
}

const loansByDue = (bank) =>
  Object.entries(bank.loans)
    .map(([id, l]) => ({ id, l }))
    .sort((a, b) => a.l.due - b.l.due);

// 순자산 = 잔고 + 주식 + 예금 + 선물 평가금 - 대출(원금+이자)
async function netWorthOf(env, userId, user, bank, stocks) {
  const fx = await getFxRate(env);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const krwMap = krwPriceMap(stocks, fx.rate); // 외국자산은 환율로 해정 환산
  const holdingsValue = Object.entries(user.holdings).reduce((sum, [name, qty]) => sum + (krwMap[name] || 0) * qty, 0);
  const futs = futureList(await getFutureItems(env, userId));
  const futuresValue = futs.reduce((sum, f) => sum + (priceMap[f.stock] === undefined ? f.margin : futureEquity(f, priceMap[f.stock])) * fxMul(f, fx.rate), 0);
  const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
  const deposit = depositOf(bank);
  const usdValue = ((user.usd || 0) * fx.rate) / 100;
  return { net: Math.floor(user.balance + holdingsValue + usdValue + deposit + futuresValue - debt), debt, deposit };
}

// 대출 한도: 순자산의 30% (최소 1,000해정). 이미 빌린 원금은 빼요.
function loanLimitOf(net, bank) {
  const ratio = LOAN_LIMIT_RATIO * creditGrade(bank.credit).limitMul;
  const total = Math.max(LOAN_LIMIT_MIN, Math.floor(Math.max(net, 0) * ratio));
  const used = Object.values(bank.loans).reduce((sum, l) => sum + l.principal, 0);
  return { total, used, available: Math.max(0, total - used), ratio };
}

// 랭킹/총자산용: 예금 + 선물 평가금 - 대출. { 유저ID: 해정 }
export async function extraAssets(env, priceMap, fxRate = FX_BASE) {
  const [banks, futs, rate] = await Promise.all([listCollection(env, "bank"), listCollection(env, "futures"), getBankRate(env)]);
  const now = Date.now();
  const extra = {};
  for (const b of banks) {
    const bank = accrueBank({ deposit: b.deposit || 0, depositAt: b.depositAt || 0, depositIndex: b.depositIndex || 0, earned: 0, loans: structuredClone(b.loans || {}), rate }, now);
    const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
    extra[b.id] = (extra[b.id] || 0) + depositOf(bank) - debt;
  }
  for (const f of futs) {
    for (const p of Object.values(f.items || {})) {
      const price = priceMap[p.stock];
      extra[f.id] = (extra[f.id] || 0) + (price === undefined ? p.margin : futureEquity(p, price)) * fxMul(p, fxRate);
    }
  }
  return extra;
}

// 한 명분 (/내정보용)
export async function userExtraAsset(env, userId, priceMap, rate = FX_BASE) {
  const [bank0, futItems] = await Promise.all([getBank(env, userId), getFutureItems(env, userId)]);
  const bank = accrueBank(structuredClone(bank0), Date.now());
  const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
  const futuresValue = futureList(futItems).reduce(
    (sum, f) => sum + (priceMap[f.stock] === undefined ? f.margin : futureEquity(f, priceMap[f.stock])) * fxMul(f, rate),
    0
  );
  return depositOf(bank) + futuresValue - debt;
}

// ---------- 예금 ----------
export async function depositMoney(env, userId, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false, message: "예금할 금액은 1 이상의 정수로 입력해 주세요." };
  const user = await getUser(env, userId);
  if (user.balance < amount) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${amount.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }
  const bank = accrueBank(await getBank(env, userId), Date.now());
  const balanceBefore = user.balance;

  // 잔고에서 먼저 빼고 예금에 넣어요. 예금 저장이 실패하면 잔고를 돌려줘요.
  user.balance -= amount;
  await saveUser(env, userId, user);
  bank.deposit += amount;
  try {
    await saveBank(env, userId, bank);
  } catch (err) {
    console.error(`예금 저장 실패 (${userId}):`, err.message);
    user.balance += amount;
    await saveUser(env, userId, user).catch(() => {});
    return { ok: false, message: "예금하는 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }
  await addHistory(env, userId, `예금: ${amount.toLocaleString()}해정 → 예금 ${depositOf(bank).toLocaleString()}해정`);

  return {
    ok: true,
    message: [
      `🏦 **예금 완료** +${amount.toLocaleString()}해정`,
      balanceLine(balanceBefore, user.balance),
      `🐷 예금 총액: **${depositOf(bank).toLocaleString()}해정** (지금 일 ${pctText(bank.rate.depositRate)} · 이 금리가 이어지면 하루 약 +${Math.floor(bank.deposit * bank.rate.depositRate).toLocaleString()}해정)`,
      marketRateLine(bank.rate, Date.now()),
      "- 예금 금리는 매시 정각에 바뀌고, 이자는 바뀐 금리대로 구간마다 쌓여요.",
    ].join("\n"),
  };
}

// amount가 비어 있으면 전액 출금
export async function withdrawMoney(env, userId, amount) {
  const bank = accrueBank(await getBank(env, userId), Date.now());
  const have = depositOf(bank);
  if (have < 1) return { ok: false, message: "예금이 없어요. `/예금`으로 먼저 맡겨 보세요." };
  const pay = amount === undefined || amount === null ? have : amount;
  if (!Number.isSafeInteger(pay) || pay < 1) return { ok: false, message: "출금할 금액은 1 이상의 정수로 입력해 주세요." };
  if (pay > have) return { ok: false, message: `예금이 부족해요. (출금 가능: ${have.toLocaleString()}해정)` };

  const user = await getUser(env, userId);
  const balanceBefore = user.balance;

  // 예금에서 먼저 빼고 잔고에 넣어요. 잔고 저장이 실패하면 예금을 되돌려요.
  const bankBefore = structuredClone(bank);
  bank.deposit -= pay;
  await saveBank(env, userId, bank);
  user.balance += pay;
  try {
    await saveUser(env, userId, user);
  } catch (err) {
    console.error(`출금 저장 실패 (${userId}):`, err.message);
    await saveBank(env, userId, bankBefore).catch(() => {});
    return { ok: false, message: "출금하는 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }
  await addHistory(env, userId, `출금: ${pay.toLocaleString()}해정 → 잔고 ${user.balance.toLocaleString()}해정`);

  return {
    ok: true,
    message: [
      `🏦 **출금 완료** -${pay.toLocaleString()}해정`,
      balanceLine(balanceBefore, user.balance),
      `🐷 남은 예금: ${depositOf(bank).toLocaleString()}해정`,
    ].join("\n"),
  };
}

// ---------- 대출 ----------
export async function takeLoan(env, userId, amount, termDays) {
  if (LOAN_TERMS[termDays] === undefined) return { ok: false, message: `기간은 ${Object.keys(LOAN_TERMS).join(", ")}일 중에서 골라 주세요.` };
  if (!Number.isSafeInteger(amount) || amount < LOAN_MIN) {
    return { ok: false, message: `대출은 ${LOAN_MIN.toLocaleString()}해정 이상 정수로 신청해 주세요.` };
  }

  const now = Date.now();
  const [user, bank0, stocks, market] = await Promise.all([
    getUser(env, userId), getBank(env, userId), listStocks(env), getBankRate(env),
  ]);
  const bank = accrueBank(bank0, now);
  const grade = creditGrade(bank.credit);
  // 신청한 "지금" 시장금리를 기준으로 삼아요. (금리 정보가 없으면 예전 고정금리로 대신)
  const baseRate = market?.loanRates?.[termDays] ?? LOAN_TERMS[termDays];
  const marketMult = market?.mult ?? 1;
  // 신용등급이 좋을수록 싸고, 나쁠수록 비싸요. 단, 하한(LOAN_RATE_FLOOR) 밑으로는 안 내려가요.
  const rate = +Math.max(baseRate * grade.rateMul, LOAN_RATE_FLOOR).toFixed(4);

  if (Object.values(bank.loans).some((l) => isOverdue(l, now))) {
    return { ok: false, message: "🚨 연체 중인 대출이 있어서 새로 빌릴 수 없어요. `/상환`으로 먼저 갚아 주세요." };
  }
  if (Object.keys(bank.loans).length >= MAX_LOANS_PER_USER) {
    return { ok: false, message: `대출은 최대 ${MAX_LOANS_PER_USER}건까지 가능해요. 먼저 갚아 주세요.` };
  }

  const { net } = await netWorthOf(env, userId, user, bank, stocks);
  const limit = loanLimitOf(net, bank);
  if (amount > limit.available) {
    return {
      ok: false,
      message: `대출 한도를 넘었어요. (신청: ${amount.toLocaleString()}해정, 남은 한도: ${limit.available.toLocaleString()}해정 / 전체 ${limit.total.toLocaleString()}해정)`,
    };
  }

  const id = newLoanId(bank.loans);
  const due = now + termDays * DAY_MS;
  bank.loans[id] = { principal: amount, unpaid: 0, rate, term: termDays, takenAt: now, due, lastAt: now, borrowed: amount };

  // 대출 기록을 먼저 저장하고 해정을 지급해요. 지급이 실패하면 기록을 지워요.
  await saveBank(env, userId, bank);
  const balanceBefore = user.balance;
  const fee = Math.max(1, Math.floor(amount * LOAN_FEE_RATE)); // 수수료는 먼저 떼고 받아요 (빚은 amount 그대로)
  user.balance += amount - fee;
  try {
    await saveUser(env, userId, user);
  } catch (err) {
    console.error(`대출 지급 실패 (${userId}):`, err.message);
    delete bank.loans[id];
    await saveBank(env, userId, bank).catch(() => {});
    return { ok: false, message: "대출 처리 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }
  await addHistory(env, userId, `대출: ${amount.toLocaleString()}해정 (${termDays}일 · 일 ${pctText(rate)} · 수수료 ${fee.toLocaleString()}) → 잔고 ${user.balance.toLocaleString()}해정`);

  const expected = Math.round(amount * rate * termDays);
  return {
    ok: true,
    message: [
      `💸 **대출 실행!** \`${id}\` ${amount.toLocaleString()}해정 (${termDays}일)`,
      balanceLine(balanceBefore, user.balance),
      `- 💰 수수료 ${fee.toLocaleString()}해정(${pctText(LOAN_FEE_RATE)})을 먼저 떼서 **${(amount - fee).toLocaleString()}해정**을 받았어요. 빚은 ${amount.toLocaleString()}해정이에요.`,
      `- 이자: 하루 ${pctText(rate)} (${termDays}일 꽉 채우면 약 ${expected.toLocaleString()}해정, 시간 단위로 계속 쌓여요)`,
      `- 🏦 신청 시점 시장금리 ×${marketMult} · 💳 신용등급 ${grade.name} ×${grade.rateMul} → 이 이자율은 만기까지 **고정**이에요 (이후 시장금리가 바뀌어도 그대로)`,
      `- 📅 갚을 날: ${dueText(due)}`,
      `- 일찍 갚으면 그때까지 쌓인 이자만 내요. 만기가 지나면 하루 ${pctText(rate + LOAN_PENALTY_RATE)}로 연체 이자가 붙어요.`,
    ].join("\n"),
  };
}

// ---------- 상환 ----------
// target: 대출 번호 또는 "all"(만기 빠른 순서로 잔고가 닿는 만큼). amount: 비우면 전액
export async function repayLoans(env, userId, target, amount) {
  const now = Date.now();
  const [user, bank0] = await Promise.all([getUser(env, userId), getBank(env, userId)]);
  const bank = accrueBank(bank0, now);

  const plan = []; // [{ id, pay }]
  if (target === "all") {
    let funds = user.balance;
    for (const { id, l } of loansByDue(bank)) {
      const pay = Math.min(loanOwed(l), funds);
      if (pay < 1) break;
      plan.push({ id, pay });
      funds -= pay;
    }
    if (Object.keys(bank.loans).length === 0) return { ok: false, message: "갚을 대출이 없어요. 👍" };
    if (plan.length === 0) return { ok: false, message: "잔고가 없어서 갚을 수 없어요. `/출금`으로 예금을 찾아 보세요." };
  } else {
    const loan = bank.loans[target];
    if (!loan) return { ok: false, message: "해당 대출을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요." };
    const owed = loanOwed(loan);
    const want = amount === undefined || amount === null ? owed : amount;
    if (!Number.isSafeInteger(want) || want < 1) return { ok: false, message: "상환 금액은 1 이상의 정수로 입력해 주세요." };
    const pay = Math.min(want, owed);
    if (user.balance < pay) {
      return { ok: false, message: `잔고가 부족해요. (필요: ${pay.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정) 금액을 줄여서 일부만 갚을 수도 있어요.` };
    }
    plan.push({ id: target, pay });
  }

  const balanceBefore = user.balance;
  const lines = [];
  const creditLines = [];
  let total = 0;
  for (const { id, pay } of plan) {
    const loan = bank.loans[id];
    const { toInterest, toPrincipal } = payLoan(loan, pay);
    total += pay;
    if (loan.principal <= 0) {
      const cn = creditOnRepaid(bank, loan, now);
      if (cn) creditLines.push(cn);
      delete bank.loans[id];
      lines.push(`- \`${id}\` 이자 ${toInterest.toLocaleString()} + 원금 ${toPrincipal.toLocaleString()} 상환 → ✅ **완납!**`);
    } else {
      lines.push(`- \`${id}\` 이자 ${toInterest.toLocaleString()} + 원금 ${toPrincipal.toLocaleString()} 상환 → 남은 빚 ${loanOwed(loan).toLocaleString()}해정`);
    }
  }

  // 잔고에서 먼저 빼고 대출을 줄여요. 대출 저장이 실패하면 잔고를 돌려줘요.
  user.balance -= total;
  await saveUser(env, userId, user);
  try {
    await saveBank(env, userId, bank);
  } catch (err) {
    console.error(`상환 저장 실패 (${userId}):`, err.message);
    user.balance += total;
    await saveUser(env, userId, user).catch(() => {});
    return { ok: false, message: "상환 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }
  await addHistory(env, userId, `대출 상환: ${total.toLocaleString()}해정 → 잔고 ${user.balance.toLocaleString()}해정`);

  return { ok: true, message: [`💳 **상환 완료** -${total.toLocaleString()}해정`, ...lines, ...creditLines, balanceLine(balanceBefore, user.balance)].join("\n") };
}

// ---------- /은행 : 내 현황 (조회하는 순간 기준) ----------
export async function bankStatus(env, userId) {
  const now = Date.now();
  const [user, bank0, stocks] = await Promise.all([getUser(env, userId), getBank(env, userId), listStocks(env)]);
  const bank = accrueBank(structuredClone(bank0), now);
  const { net, debt, deposit } = await netWorthOf(env, userId, user, bank, stocks);
  const limit = loanLimitOf(net, bank);

  const lines = ["**🏦 내 은행 현황** (지금 이 순간 기준, 이자는 계속 쌓여요)", ""];
  lines.push(`🐷 **예금**: ${deposit.toLocaleString()}해정 (지금 일 ${pctText(bank.rate.depositRate)} · 지금까지 받은 이자 +${Math.floor(bank.earned || 0).toLocaleString()}해정)`);

  const loans = loansByDue(bank);
  if (loans.length === 0) {
    lines.push("💸 **대출**: 없음");
  } else {
    lines.push(`💸 **대출 ${loans.length}건** · 갚을 돈 합계 **${debt.toLocaleString()}해정**`);
    for (const { id, l } of loans) {
      const late = isOverdue(l, now);
      lines.push(
        `\`${id}\` ${l.term}일 대출 · 원금 ${l.principal.toLocaleString()} + 이자 ${interestOwed(l).toLocaleString()} = **${loanOwed(l).toLocaleString()}해정**`,
        late
          ? `  🚨 **연체 중!** 하루 ${pctText(l.rate + LOAN_PENALTY_RATE)}씩 이자가 붙고 있어요 (만기 ${dueText(l.due)})`
          : `  일 ${pctText(l.rate)} · 📅 만기 ${dueText(l.due)}`
      );
    }
  }
  lines.push("", `📋 **대출 한도**: 남은 ${limit.available.toLocaleString()}해정 / 전체 ${limit.total.toLocaleString()}해정 (순자산 ${net.toLocaleString()}해정의 ${Math.round(limit.ratio * 100)}%, 최소 ${LOAN_LIMIT_MIN.toLocaleString()})`);
  lines.push(creditLine(bank));
  lines.push(marketRateLine(bank.rate, now, creditGrade(bank.credit).rateMul) + " (내 신용등급 배율 적용)");
  return lines.join("\n");
}

// ---------- 크론: 시세 변동 직후에 호출 ----------
// 1) 만기 전 알림  2) 만기 지난 대출 자동 회수(잔고 → 예금)  3) 연체가 길면 보유 주식 강제 매도
// 반환: { collected: 자동 회수 건수, liquidated: 강제 매도로 갚은 건수, overdue: 연체 중 건수, reminded: 알림 수 }
function forceSell(user, priceMap, need) {
  const lines = [];
  let raised = 0;
  const list = Object.entries(user.holdings)
    .map(([name, qty]) => ({ name, qty, price: priceMap[name] || 0 }))
    .filter((h) => h.qty > 0 && h.price > 0)
    .sort((a, b) => b.qty * b.price - a.qty * a.price);
  for (const h of list) {
    if (raised >= need) break;
    const qty = Math.min(h.qty, Math.ceil((need - raised) / h.price));
    const prevCost = costOf(user, h.name, h.price);
    const basis = Math.round((prevCost * qty) / h.qty);
    const earned = h.price * qty;
    user.holdings[h.name] = h.qty - qty;
    if (user.holdings[h.name] === 0) {
      delete user.holdings[h.name];
      delete user.costs[h.name];
    } else {
      user.costs[h.name] = prevCost - basis;
    }
    user.realizedProfit = (user.realizedProfit || 0) + (earned - basis);
    raised += earned;
    lines.push(`${h.name} ${qty.toLocaleString()}주 강제 매도 (+${earned.toLocaleString()}해정)`);
  }
  user.balance += raised;
  return { raised, lines };
}

export async function processBank(env) {
  const [docs, stocks] = await Promise.all([listCollection(env, "bank"), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.filter((s) => !isForeign(s)).map((s) => [s.name, s.price])); // 외국자산(달러)은 강제매도에서 빼요
  const summary = { collected: 0, liquidated: 0, overdue: 0, reminded: 0 };
  const now = Date.now();

  await Promise.all(
    docs.map(async (doc) => {
      const userId = doc.id;
      const loans = doc.loans || {};
      const needWork = Object.values(loans).some(
        (l) => l.due <= now || (!l.warned && l.due - now <= REMIND_BEFORE_HOURS * BANK_HOUR_MS)
      );
      if (!needWork) return;

      try {
        const bank = accrueBank(await getBank(env, userId), now);
        const user = await getUser(env, userId);
        const notes = [];
        let userChanged = false;

        for (const { id, l } of loansByDue(bank)) {
          // 만기 전 알림 (한 번만)
          if (l.due > now) {
            if (!l.warned && l.due - now <= REMIND_BEFORE_HOURS * BANK_HOUR_MS) {
              l.warned = true;
              summary.reminded++;
              notes.push(`⏰ **[만기 임박]** \`${id}\` 대출 ${loanOwed(l).toLocaleString()}해정을 ${dueText(l.due)}까지 갚아야 해요. 안 갚으면 잔고에서 자동으로 빠져나가요.`);
            }
            continue;
          }

          // 만기 지남: 1) 잔고
          let owed = loanOwed(l);
          let paid = 0;
          const fromBalance = Math.min(user.balance, owed);
          if (fromBalance > 0) {
            payLoan(l, fromBalance);
            user.balance -= fromBalance;
            userChanged = true;
            paid += fromBalance;
          }
          // 2) 예금
          owed = loanOwed(l);
          if (l.principal > 0 && owed > 0 && depositOf(bank) > 0) {
            const fromDeposit = Math.min(depositOf(bank), owed);
            payLoan(l, fromDeposit);
            bank.deposit -= fromDeposit;
            paid += fromDeposit;
          }
          // 3) 연체가 길어지면 보유 주식 강제 매도
          let soldLines = [];
          owed = loanOwed(l);
          if (l.principal > 0 && now >= l.due + LIQUIDATE_AFTER_HOURS * BANK_HOUR_MS) {
            const sold = forceSell(user, priceMap, owed);
            if (sold.raised > 0) {
              userChanged = true;
              soldLines = sold.lines;
              const pay = Math.min(user.balance, owed);
              payLoan(l, pay);
              user.balance -= pay;
              paid += pay;
              summary.liquidated++;
              const cl = markLiquidated(bank, l);
              if (cl) notes.push(cl);
            }
          }

          if (l.principal <= 0) {
            delete bank.loans[id];
            summary.collected++;
            notes.push(`🏦 **[대출 자동 상환]** \`${id}\` 대출이 만기가 되어 ${paid.toLocaleString()}해정이 자동으로 상환됐어요.${soldLines.length ? `\n보유 주식을 강제로 팔았어요: ${soldLines.join(", ")}` : ""}`);
          } else {
            summary.overdue++;
            const lateCredit = markLate(bank, l);
            notes.push(
              `🚨 **[연체]** \`${id}\` 대출이 만기를 넘겼어요. 남은 빚 ${loanOwed(l).toLocaleString()}해정 (하루 ${pctText(l.rate + LOAN_PENALTY_RATE)}씩 연체 이자)` +
                (paid > 0 ? `\n자동으로 ${paid.toLocaleString()}해정을 회수했어요.` : "") +
                (soldLines.length ? `\n보유 주식을 강제로 팔았어요: ${soldLines.join(", ")}` : "") +
                `\n해정이 들어오면 자동으로 갚아지고, ${LIQUIDATE_AFTER_HOURS}시간이 지나면 보유 주식이 강제로 팔려요.` +
                lateCredit
            );
          }
        }

        if (notes.length === 0) return;
        if (userChanged) await saveUser(env, userId, user);
        await saveBank(env, userId, bank);
        await addHistory(env, userId, `은행 자동 처리: ${notes.length}건 → 잔고 ${user.balance.toLocaleString()}해정`);
        await logAction(env, { u: userId, cmd: "상환", a: `${notes.length}건`, r: "은행 자동 처리 (알림/회수/연체)" });
        await safeDM(env, userId, notes.join("\n\n"));
      } catch (err) {
        console.error(`은행 처리 실패 (${userId}):`, err.message);
      }
    })
  );

  return summary;
}

// ============================================================
// [commands.js]
// ============================================================
// ---- 1) Discord에 등록할 커맨드 정의 ----
// autocomplete: true 인 옵션은 칸을 누르기만 해도 예시 목록이 떠요. 목록에 없는 값도 직접 입력할 수 있어요.
// 여러 종목/상품을 한 번에: 첫 번째 칸(종목, 수량 …) 뒤에 [2번째]~[5번째] 칸을 자동으로 붙여요.
// ---------- 송금 (유저끼리 해정 보내기 + 은행 수수료) ----------
//  - 보내는 사람이 "금액 + 수수료"를 내고, 받는 사람은 "금액" 전부를 받아요. 수수료는 은행이 가져가요(사라짐).
//  - 수수료율/최소 금액은 아래 숫자만 바꾸면 돼요.
export const TRANSFER_FEE_RATE = 0.03; // 수수료 3% (올림, 최소 1해정)
export const TRANSFER_FEE_MIN = 1;
export const TRANSFER_MIN = 10; // 한 번에 최소 송금액

export const transferFee = (amount) => Math.max(TRANSFER_FEE_MIN, Math.ceil(amount * TRANSFER_FEE_RATE));

// 잔고로 보낼 수 있는 최대 금액 (수수료 포함해서 잔고를 넘지 않는 가장 큰 값)
export function maxTransferable(balance) {
  let a = Math.floor(balance / (1 + TRANSFER_FEE_RATE));
  while (a > 0 && a + transferFee(a) > balance) a--;
  while (a + 1 + transferFee(a + 1) <= balance) a++;
  return Math.max(0, a);
}

export async function transferMoney(env, fromId, toId, amount, { toIsBot = false } = {}) {
  if (!toId) return { ok: false, message: "받는 사람을 골라 주세요." };
  if (toIsBot) return { ok: false, message: "봇에게는 송금할 수 없어요." };
  if (toId === fromId) return { ok: false, message: "자기 자신에게는 송금할 수 없어요." };
  if (!Number.isSafeInteger(amount) || amount < TRANSFER_MIN) {
    return { ok: false, message: `송금액은 ${TRANSFER_MIN.toLocaleString()}해정 이상의 정수로 입력해 주세요.` };
  }

  // 아직 한 번도 봇을 안 쓴 유저에게는 보낼 수 없어요 (없는 계정이 새로 만들어지는 걸 막음)
  const target = await getDoc(env, `users/${toId}`);
  if (!target) return { ok: false, message: "받는 사람이 아직 해정 봇을 쓴 적이 없어요. 먼저 명령어를 한 번 써보라고 알려주세요." };

  const fee = transferFee(amount);
  const total = amount + fee;
  const sender = await getUser(env, fromId);
  if (sender.balance < total) {
    return {
      ok: false,
      message: `잔고가 부족해요. (필요: ${total.toLocaleString()}해정 = 송금 ${amount.toLocaleString()} + 수수료 ${fee.toLocaleString()}, 보유: ${sender.balance.toLocaleString()}해정)`,
    };
  }

  const balanceBefore = sender.balance;
  // 보내는 사람에게서 먼저 빼고, 받는 사람에게 넣어요. 받는 쪽 저장이 실패하면 보낸 쪽을 되돌려요.
  sender.balance -= total;
  await saveUser(env, fromId, sender);
  try {
    const receiver = await getUser(env, toId);
    receiver.balance += amount;
    await saveUser(env, toId, receiver);
  } catch (err) {
    console.error(`송금 저장 실패 (${fromId} -> ${toId}):`, err.message);
    sender.balance += total;
    await saveUser(env, fromId, sender).catch(() => {});
    return { ok: false, message: "송금하는 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }

  await Promise.all([
    addHistory(env, fromId, `송금: <@${toId}>에게 ${amount.toLocaleString()}해정 (수수료 ${fee.toLocaleString()}) → 잔고 ${sender.balance.toLocaleString()}해정`),
    addHistory(env, toId, `송금 받음: <@${fromId}>에게서 +${amount.toLocaleString()}해정`),
  ]);

  // 받는 사람에게 DM (실패해도 송금은 그대로)
  try {
    await sendDM(env, toId, `💸 <@${fromId}>님이 **${amount.toLocaleString()}해정**을 보냈어요!`);
  } catch (err) {
    console.error(`송금 DM 실패 (${toId}):`, err.message);
  }

  return {
    ok: true,
    message: [
      `💸 **송금 완료** <@${toId}>님에게 ${amount.toLocaleString()}해정`,
      `🏦 은행 수수료: -${fee.toLocaleString()}해정 (${pctText(TRANSFER_FEE_RATE)})`,
      balanceLine(balanceBefore, sender.balance),
    ].join("\n"),
  };
}

// ---------- 보험 (상장폐지 보험) ----------
//  - 가지고 있는 종목이 "보험 기간 안에" 상장폐지되면, 가입할 때 정해둔 금액을 보험금으로 받아요.
//  - 보험금 = 가입 때 현재가 × INSURANCE_COVER_RATE (주당). 폐지 순간 실제로 들고 있는 수량까지만 줘요.
//    (보험 들고 주식을 팔아버리면 판 만큼은 보험금이 없어요)
//  - 보험료는 "폐지될 확률 × 보험금 × INSURANCE_LOAD"로 계산해요. 확률은 시세 변동 시뮬레이션으로 뽑은 표예요.
//    싼 종목일수록, 기간이 길수록 비싸요. 위기 종목(300해정 이하)은 가입할 수 없어요.
//  - 종목 하나에 보험은 1개, 한 사람이 동시에 INSURANCE_MAX개까지. 보험료는 돌려받지 못해요.
//  - 저장: users/{id}.insurance = { 종목이름: { qty, payout, premium, term, expiresAt, boughtAt } }
export const INSURANCE_COVER_RATE = 0.5; // 보험금 = 가입 때 현재가의 50%
export const INSURANCE_LOAD = 1.15; // 보험료 = 공정한 값 × 1.15 (보험사 몫)
export const INSURANCE_MAX = 5; // 동시에 가질 수 있는 보험 수
export const INSURANCE_MIN_TERM = 1; // 최소 가입 기간(일)
export const INSURANCE_MAX_TERM = 30; // 최대 가입 기간(일) — 길게 가입할수록 복리로 비싸져요
export const INSURANCE_CANCEL_REFUND_RATE = 0.4; // 해지 시 "남은 기간 비율 × 보험료"의 40%만 환급 (나머지는 위약금)
// 가격대별 "하루 동안 폐지될 확률"(일일 위험률). 기존 1일/3일 시뮬레이션 결과를 묶어서 추정했어요.
const INSURANCE_PRICE_POINTS = [350, 500, 1000, 2000, 5000];
const INSURANCE_DAILY_PROB = [0.434, 0.364, 0.237, 0.152, 0.08];

// 가격대별 일일 위험률(로그보간)
function insuranceDailyProb(price) {
  const probs = INSURANCE_DAILY_PROB;
  const xs = INSURANCE_PRICE_POINTS;
  if (price <= xs[0]) return probs[0];
  if (price >= xs[xs.length - 1]) return probs[probs.length - 1]; // 더 비싼 종목도 가장 낮은 값으로(보험사에 유리하게)
  let i = 0;
  while (price > xs[i + 1]) i++;
  const t = (Math.log(price) - Math.log(xs[i])) / (Math.log(xs[i + 1]) - Math.log(xs[i]));
  return probs[i] + (probs[i + 1] - probs[i]) * t;
}

// 기간이 길어질수록 "그 기간 안에 폐지될 확률"이 복리로 커져요: 1 - (1-일일위험률)^기간
function insuranceProb(price, term) {
  const daily = insuranceDailyProb(price);
  return 1 - Math.pow(1 - daily, term);
}

// 주당 견적: { payout: 주당 보험금, perShare: 주당 보험료 }. 기간(일)이 늘어날수록 확률이 복리로 커져서 보험료도 같이 비싸져요.
export function insuranceQuote(price, term) {
  const payout = Math.floor(price * INSURANCE_COVER_RATE);
  const chance = Math.min(0.9, insuranceProb(price, term) * INSURANCE_LOAD); // 보험료가 보험금의 90%를 넘지 않게
  return { payout, perShare: Math.max(1, Math.ceil(payout * chance)) };
}

// 만료된 보험을 걷어낸 새 지도 (원본은 건드리지 않아요)
function activeInsurance(user, now = Date.now()) {
  const out = {};
  for (const [name, p] of Object.entries(user.insurance || {})) {
    if (p && p.expiresAt > now) out[name] = p;
  }
  return out;
}

function leftText(ms) {
  const h = Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
  if (h < 24) return `${h}시간`;
  return h % 24 === 0 ? `${h / 24}일` : `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

export async function buyInsurance(env, userId, stockName, qty, term) {
  const name = String(stockName ?? "").trim();
  term = Number(term);
  if (!Number.isInteger(term) || term < INSURANCE_MIN_TERM || term > INSURANCE_MAX_TERM) {
    return { ok: false, message: `보험 기간은 ${INSURANCE_MIN_TERM}~${INSURANCE_MAX_TERM}일 사이의 정수로 적어주세요. (길게 가입할수록 보험료가 비싸져요)` };
  }

  const [user, stocks] = await Promise.all([getUser(env, userId), listStocks(env)]);
  const stock = stocks.find((s) => s.name === name);
  if (!stock) return { ok: false, message: `"${name}" 종목을 찾을 수 없어요.` };
  if (isForeign(stock)) return { ok: false, message: "외국자산(코인·미국주식)은 보험에 들 수 없어요." };

  const held = user.holdings[name] || 0;
  if (held <= 0) return { ok: false, message: `${name} 주식을 가지고 있지 않아요. 보험은 보유한 종목에만 들 수 있어요.` };
  if (stock.price <= DANGER_PRICE) {
    return { ok: false, message: `${DANGER_MARK} ${name}은(는) 위기 종목(${DANGER_PRICE.toLocaleString()}해정 이하)이라 보험에 들 수 없어요.` };
  }

  const covered = qty === undefined || qty === null ? held : Number(qty);
  if (!Number.isInteger(covered) || covered < 1) return { ok: false, message: "수량은 1 이상의 정수로 적어주세요." };
  if (covered > held) return { ok: false, message: `${name}을(를) ${held.toLocaleString()}주만 가지고 있어서 ${covered.toLocaleString()}주는 보장할 수 없어요.` };

  const now = Date.now();
  const active = activeInsurance(user, now);
  if (active[name]) {
    return { ok: false, message: `${name}은(는) 이미 보험이 있어요. (${leftText(active[name].expiresAt - now)} 남음) 끝난 뒤에 다시 들 수 있어요.` };
  }
  if (Object.keys(active).length >= INSURANCE_MAX) {
    return { ok: false, message: `보험은 동시에 ${INSURANCE_MAX}개까지 가질 수 있어요. ${commandPath("보험")}에서 내 보험을 확인해 보세요.` };
  }

  const { payout, perShare } = insuranceQuote(stock.price, term);
  const premium = perShare * covered;
  if (user.balance < premium) {
    return { ok: false, message: `보험료가 모자라요. 필요 ${premium.toLocaleString()}해정 / 보유 ${user.balance.toLocaleString()}해정 (수량을 줄이면 싸져요)` };
  }

  const balanceBefore = user.balance;
  user.balance -= premium;
  active[name] = { qty: covered, payout, premium, term, expiresAt: now + term * DAY_MS, boughtAt: now };
  user.insurance = active;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `보험 가입: ${name} ${covered.toLocaleString()}주 ${term}일 (보험료 -${premium.toLocaleString()}해정)`),
  ]);

  return {
    ok: true,
    message: [
      `🛡️ **${name}** 폐지 보험에 가입했어요!`,
      `- 보장: ${covered.toLocaleString()}주 · ${term}일 (${leftText(term * DAY_MS)} 뒤 만료)`,
      `- 폐지되면 받는 보험금: 주당 ${payout.toLocaleString()}해정 → 최대 **${(payout * covered).toLocaleString()}해정**`,
      `- 보험료: ${premium.toLocaleString()}해정 (주당 ${perShare.toLocaleString()}해정)`,
      balanceLine(balanceBefore, user.balance),
    ].join("\n"),
  };
}

export async function insuranceInfo(env, userId) {
  const [user, stocks] = await Promise.all([getUser(env, userId), listStocks(env)]);
  const now = Date.now();
  const active = activeInsurance(user, now);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));

  const lines = [
    "**🛡️ 상장폐지 보험**",
    `가진 종목이 보험 기간 안에 상장폐지되면 **가입할 때 현재가의 ${pctText(INSURANCE_COVER_RATE)}**를 주당 보험금으로 받아요.`,
    `싼 종목일수록, 기간이 길수록 보험료가 비싸요(기간 ${INSURANCE_MIN_TERM}~${INSURANCE_MAX_TERM}일 자유 선택). 위기 종목(⚠️ ${DANGER_PRICE.toLocaleString()}해정 이하)은 못 들어요.`,
    `종목마다 1개씩, 동시에 ${INSURANCE_MAX}개까지. 해지하면 남은 기간 비율만큼 보험료의 ${pctText(INSURANCE_CANCEL_REFUND_RATE)}를 환급해요.`,
    `가입: \`${commandPath("보험가입")} 종목 기간\` · 해지: \`${commandPath("보험해지")} 종목\` (수량을 안 적으면 가진 만큼 전부)`,
    "",
    "**내 보험**",
  ];

  const entries = Object.entries(active);
  if (entries.length === 0) {
    lines.push("가입한 보험이 없어요.");
  } else {
    for (const [name, p] of entries) {
      const price = priceMap[name];
      lines.push(
        `- ${name} ${p.qty.toLocaleString()}주 · ${p.term}일 · ${leftText(p.expiresAt - now)} 남음 · 최대 ${(p.qty * p.payout).toLocaleString()}해정 (현재가 ${price === undefined ? "?" : price.toLocaleString()}해정)`
      );
    }
  }

  if (user.insuranceTotal) lines.push("", `💰 지금까지 받은 보험금 합계: ${Number(user.insuranceTotal).toLocaleString()}해정`);
  return lines.join("\n");
}

// 보험 해지: 남은 기간 비율만큼 보험료의 INSURANCE_CANCEL_REFUND_RATE를 환급해요.
// (전액 돌려주면 "일단 들고 안 터지면 바로 해지"로 사실상 공짜 보험이 되니, 비율+위약금으로 손해는 남게 함)
export async function cancelInsurance(env, userId, stockName) {
  const name = String(stockName ?? "").trim();
  const user = await getUser(env, userId);
  const now = Date.now();
  const active = activeInsurance(user, now);
  const policy = active[name];
  if (!policy) return { ok: false, message: `${name}에 가입한 보험이 없어요.` };

  const totalMs = policy.term * DAY_MS;
  const remainMs = Math.max(0, policy.expiresAt - now);
  const refund = Math.floor(policy.premium * (remainMs / totalMs) * INSURANCE_CANCEL_REFUND_RATE);

  delete active[name];
  const balanceBefore = user.balance;
  user.balance += refund;
  user.insurance = active;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `보험 해지: ${name} (환급 +${refund.toLocaleString()}해정)`),
  ]);

  return {
    ok: true,
    message: [
      `🛡️ **${name}** 보험을 해지했어요.`,
      `- 환급: ${refund.toLocaleString()}해정 (남은 기간 ${leftText(remainMs)} · 낸 보험료 ${policy.premium.toLocaleString()}해정의 ${pctText(INSURANCE_CANCEL_REFUND_RATE)})`,
      balanceLine(balanceBefore, user.balance),
    ].join("\n"),
  };
}

// ---------- 배당금 (보유 종목 가치의 일정 %를 매일 지급) ----------
//  - 매일 한국시간 DIVIDEND_HOUR시 이후 첫 시세 변동(크론) 때 한 번만 지급해요. (지급 기록: config/dividend)
//  - 지급 시점에 가지고 있는 주식 기준으로, 종목 가치(가격×수량)의 DIVIDEND_RATE만큼 받아요.
//  - 위기 종목(300해정 이하)은 무배당이에요. 한 명이 하루에 받는 합계는 DIVIDEND_MAX_PER_USER까지예요.
export const DIVIDEND_RATE = 0.01; // 하루 1%
export const DIVIDEND_HOUR = 9; // 한국시간 오전 9시
export const DIVIDEND_MAX_PER_USER = 10000;
const DIVIDEND_PATH = "config/dividend";

// 배당소득세: 배당금에서 이 비율을 떼고 받아요. (세금을 뗀 뒤 금액이 dividendOf 결과예요. 0이면 세금 없음)
export const DIVIDEND_TAX_RATE = 0.154;

export const dividendOf = (price, qty) => (price > DANGER_PRICE ? Math.floor(price * qty * DIVIDEND_RATE * (1 - DIVIDEND_TAX_RATE)) : 0);

export async function processDividends(env) {
  if (currentHourKST() < DIVIDEND_HOUR) return { ran: false, reason: "아직 배당 시각이 아니에요" };
  const day = todayKST();
  const state = (await getDoc(env, DIVIDEND_PATH)) || {};
  if (state.lastDay === day) return { ran: false, reason: "오늘은 이미 지급했어요" };
  // 지급 전에 먼저 기록해서 크론이 겹쳐도 두 번 주지 않게 해요
  await setDoc(env, DIVIDEND_PATH, { lastDay: day });

  const [users, stocks] = await Promise.all([listCollection(env, "users"), listStocks(env)]);
  // 외국자산(코인·해외주식)은 배당이 없어요. (priceMap에서 빼면 아래 반복문에서 자동으로 건너뛰어요)
  const priceMap = Object.fromEntries(stocks.filter((s) => !isForeign(s)).map((s) => [s.name, s.price]));
  // 배당 확대(×2)/무배당(×0) 공시가 있으면 이번 지급에 반영해요
  const newsDoc = (await getDoc(env, NEWS_PATH).catch(() => null)) || {};
  const divMods = newsDoc.divMods || {};
  const targets = [];
  for (const u of users) {
    let sum = 0;
    const parts = [];
    for (const [name, qty] of Object.entries(u.holdings || {})) {
      const price = priceMap[name];
      if (!(qty > 0) || price === undefined) continue;
      const pay = Math.floor(dividendOf(price, qty) * (divMods[name] ?? 1));
      if (pay > 0) {
        sum += pay;
        parts.push(`${name} +${pay.toLocaleString()}`);
      }
    }
    sum = Math.min(sum, DIVIDEND_MAX_PER_USER);
    if (sum > 0) targets.push({ id: u.id, sum, parts, balance: u.balance || 0, total: u.totalDividend || 0 });
  }

  let paid = 0;
  let total = 0;
  for (let i = 0; i < targets.length; i += 10) {
    await Promise.all(
      targets.slice(i, i + 10).map(async (t) => {
        try {
          await setDoc(env, `users/${t.id}`, {
            balance: t.balance + t.sum,
            lastDividend: { day, amount: t.sum },
            totalDividend: t.total + t.sum,
          });
          await addHistory(env, t.id, `배당금: +${t.sum.toLocaleString()}해정 (${t.parts.join(", ")})`);
          paid++;
          total += t.sum;
        } catch (err) {
          console.error(`배당금 지급 실패 (${t.id}):`, err.message);
        }
      })
    );
  }

  if (Object.keys(divMods).length) await setDoc(env, NEWS_PATH, { divMods: {} }).catch(() => {}); // 공시 반영 끝

  // 주식채널에 무음으로 한 줄 공지 (실패해도 지급은 끝난 상태)
  if (paid > 0 && env.ALLOWED_CHANNEL_ID) {
    try {
      await discordPost(env, `/channels/${env.ALLOWED_CHANNEL_ID}/messages`, {
        content: `💰 **오늘의 배당금 지급!** ${paid.toLocaleString()}명에게 총 ${total.toLocaleString()}해정을 나눠줬어요. (자세한 내용은 \`/배당\`)`,
        flags: 4096,
        allowed_mentions: { parse: [] },
      });
    } catch (err) {
      console.error("배당금 공지 실패:", err.message);
    }
  }
  return { ran: true, day, paid, total };
}

// /배당 : 내 예상 배당금과 받은 내역
export async function dividendInfo(env, userId) {
  const [user, stocks, state, newsDoc] = await Promise.all([getUser(env, userId), listStocks(env), getDoc(env, DIVIDEND_PATH), getDoc(env, NEWS_PATH).catch(() => null)]);
  const mods = newsDoc?.divMods || {};
  const priceMap = Object.fromEntries(stocks.filter((s) => !isForeign(s)).map((s) => [s.name, s.price])); // 외국자산은 배당 없음
  const rows = [];
  let sum = 0;
  for (const [name, qty] of Object.entries(user.holdings)) {
    const price = priceMap[name];
    if (!(qty > 0) || price === undefined) continue;
    const mul = mods[name] ?? 1;
    const pay = Math.floor(dividendOf(price, qty) * mul);
    sum += pay;
    rows.push({ name, qty, pay, mul, danger: price <= DANGER_PRICE });
  }
  rows.sort((a, b) => b.pay - a.pay || compareKo(a.name, b.name));
  const capped = Math.min(sum, DIVIDEND_MAX_PER_USER);

  const kstNow = Date.now() + 9 * 60 * 60 * 1000;
  const dayStart = Math.floor(kstNow / DAY_MS) * DAY_MS;
  const paidToday = state?.lastDay === todayKST();
  const nextKst = dayStart + (currentHourKST() < DIVIDEND_HOUR && !paidToday ? 0 : DAY_MS) + DIVIDEND_HOUR * 60 * 60 * 1000;
  const nextUnix = Math.floor((nextKst - 9 * 60 * 60 * 1000) / 1000);

  const lines = [
    "**💰 내 배당금**",
    `보유 종목 가치의 하루 ${pctText(DIVIDEND_RATE)}를 매일 오전 ${DIVIDEND_HOUR}시(한국시간) 이후 첫 시세 변동 때 줘요. 배당소득세 ${pctText(DIVIDEND_TAX_RATE)}를 떼고 받아요. 위기 종목(⚠️ ${DANGER_PRICE}해정 이하)은 무배당이에요.`,
    `⏰ 다음 지급: <t:${nextUnix}:f> (<t:${nextUnix}:R>)`,
    "",
  ];
  if (rows.length === 0) {
    lines.push("지금 보유한 주식이 없어요. 주식을 사면 배당을 받을 수 있어요!");
  } else {
    lines.push("**지금 지급한다면**");
    for (const r of rows) {
      lines.push(`- ${r.name} ${r.qty.toLocaleString()}주 → ${r.danger ? "무배당 (위기 종목)" : r.mul === 0 ? "무배당 (공시)" : `+${r.pay.toLocaleString()}해정${r.mul !== 1 ? ` (공시: ×${r.mul})` : ""}`}`);
    }
    lines.push(`합계 **+${capped.toLocaleString()}해정**${sum > capped ? ` (하루 상한 ${DIVIDEND_MAX_PER_USER.toLocaleString()}해정 적용)` : ""}`);
  }
  if (user.lastDividend) {
    lines.push("", `🧾 마지막으로 받은 배당: ${user.lastDividend.day} · +${Number(user.lastDividend.amount).toLocaleString()}해정`);
  }
  if (user.totalDividend) lines.push(`📈 지금까지 받은 배당 합계: ${Number(user.totalDividend).toLocaleString()}해정`);
  return lines.join("\n");
}

// ---------- 공시/뉴스 ----------
//  - 하루 3~4건(관리자가 /공시설정으로 변경)을 랜덤으로 올려요. 시세 변동 5분 전에 주식채널에 공지하고,
//    다음 시세 변동에 "확률 편향"으로 반영돼요. (호재 = 무조건 상승이 아니라 변동 범위가 위쪽으로 기울어요)
//  - 같은 종목은 NEWS_COOLDOWN_HOURS시간 동안 다시 안 나와요.
//  - 위기 종목(300해정 이하)에는 큰 악재가 안 나오고, 상장폐지 경고 / 구제 소식만 나와요.
//  - 배당 확대/무배당 공시는 다음 배당금 지급액에도 반영돼요. (processDividends)
//  - 루머는 NEWS_RUMOR_TRUE_RATE 확률로만 사실이에요. (헛소문이면 반대로 살짝 움직여요)
//  - 호출: cron-job.org에서 10,25,40,55분마다 /api/cron?task=news (시세 변동이 0,15,30,45분일 때 5분 전)
//  - 저장: config/news = { enabled, perDay, day, target, count, queue, cool, recent, divMods }
const NEWS_PATH = "config/news";
export const NEWS_PER_DAY = 4;
export const NEWS_COOLDOWN_HOURS = 6;
const NEWS_SHIFT = { 1: 6, 2: 10, 3: 14 }; // 기울기 세기(퍼센트포인트). 평소 변동이 -20~+20%라면 중간 호재는 -10~+30%
const NEWS_MAX_SHIFT = 20; // 한 종목에 겹쳐도 이 이상은 안 기울어요
const NEWS_RUMOR_TRUE_RATE = 0.6;
const NEWS_KEEP = 12; // /공시목록에 남겨두는 최근 공시 수
const NEWS_HOUR_MS = 60 * 60 * 1000;

// 관리자가 /공시로 직접 올릴 때 고르는 성격
const NEWS_MANUAL = {
  good1: { tone: "good", shift: NEWS_SHIFT[1], label: "호재 (소)" },
  good2: { tone: "good", shift: NEWS_SHIFT[2], label: "호재 (중)" },
  good3: { tone: "good", shift: NEWS_SHIFT[3], label: "호재 (대)" },
  bad1: { tone: "bad", shift: NEWS_SHIFT[1], label: "악재 (소)" },
  bad2: { tone: "bad", shift: NEWS_SHIFT[2], label: "악재 (중)" },
  bad3: { tone: "bad", shift: NEWS_SHIFT[3], label: "악재 (대)" },
  none: { tone: "none", shift: 0, label: "정보만 알림 (효과 없음)" },
};

// 자동 공시 문구 모음. 서버 분위기에 맞게 texts에 문장을 마음껏 추가/수정하세요. ({n} = 종목 이름)
//  tone: good(호재) / bad(악재), tilt: 세기 1~3, weight: 나올 확률 가중치
//  scope: normal(일반 종목만) / danger(위기 종목만) / both
//  div: 2 = 다음 배당 2배, 0 = 다음 배당 없음   rumor: true = 확인 안 된 소문
const NEWS_TEMPLATES = [
  { kind: "실적 발표", tone: "good", tilt: 2, weight: 2, scope: "normal", texts: [
    "{n} 이번 분기 실적이 시장 예상을 크게 웃돌았어요",
    "{n} 역대 최대 분기 매출을 달성했어요",
    "{n} 영업이익이 전년 대비 큰 폭으로 늘었어요",
  ] },
  { kind: "실적 발표", tone: "bad", tilt: 2, weight: 2, scope: "normal", texts: [
    "{n} 이번 분기 실적이 시장 예상에 못 미쳤어요",
    "{n} 영업이익이 줄어 어닝 쇼크를 기록했어요",
    "{n} 적자 전환 소식이 전해졌어요",
  ] },
  { kind: "신제품/계약", tone: "good", tilt: 1, weight: 2, scope: "normal", texts: [
    "{n} 신제품이 출시 첫날부터 품절 대란을 일으켰어요",
    "{n} 대형 공급 계약을 따냈다고 밝혔어요",
    "{n} 해외 시장 진출 계획을 발표했어요",
  ] },
  { kind: "사업 차질", tone: "bad", tilt: 1, weight: 1, scope: "normal", texts: [
    "{n} 신제품 출시가 무기한 연기됐어요",
    "{n} 주요 거래처가 계약을 해지했어요",
  ] },
  { kind: "횡령/사고", tone: "bad", tilt: 3, weight: 1, scope: "normal", texts: [
    "{n} 임원의 횡령 의혹이 제기됐어요",
    "{n} 공장 화재로 생산이 중단됐어요",
    "{n} 개인정보 유출 사고가 발생했어요",
  ] },
  { kind: "배당 확대", tone: "good", tilt: 1, weight: 1, scope: "normal", div: 2, texts: [
    "{n} 다음 배당을 2배로 늘리겠다고 발표했어요",
    "{n} 주주환원 정책으로 배당 확대를 결정했어요",
  ] },
  { kind: "무배당", tone: "bad", tilt: 1, weight: 1, scope: "normal", div: 0, texts: [
    "{n} 투자 재원 마련을 위해 다음 배당을 하지 않기로 했어요",
    "{n} 이번에는 배당을 건너뛰겠다고 밝혔어요",
  ] },
  { kind: "상장폐지 경고", tone: "bad", tilt: 2, weight: 2, scope: "danger", texts: [
    "{n} 상장폐지 심사 대상에 올랐어요",
    "{n} 감사의견 거절 가능성이 제기됐어요",
  ] },
  { kind: "구제 소식", tone: "good", tilt: 2, weight: 1, scope: "danger", texts: [
    "{n} 대형 투자자가 인수를 검토 중이라는 소식이에요",
    "{n} 구조조정 계획이 승인됐어요",
  ] },
  { kind: "루머", tone: "good", tilt: 2, weight: 1, scope: "both", rumor: true, texts: [
    "{n} 곧 대형 계약을 따낼 거라는 소문이 돌고 있어요",
    "{n} 호실적 발표가 임박했다는 소문이 있어요",
  ] },
  { kind: "루머", tone: "bad", tilt: 2, weight: 1, scope: "both", rumor: true, texts: [
    "{n} 경영진 불화설이 퍼지고 있어요",
    "{n} 실적이 안 좋다는 이야기가 돌고 있어요",
  ] },
];

const newsPickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];
function newsPickWeighted(list) {
  const total = list.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of list) {
    r -= t.weight;
    if (r < 0) return t;
  }
  return list[list.length - 1];
}
const newsId = (at) => `n${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// 종목 하나에 붙일 공시를 만들어요 (위기 종목이면 위기용 문구만)
function buildNewsItem(stock, at) {
  const danger = isDelistDanger(stock.price);
  const pool = NEWS_TEMPLATES.filter((t) => t.scope === "both" || t.scope === (danger ? "danger" : "normal"));
  const t = newsPickWeighted(pool);
  const sign = t.tone === "good" ? 1 : -1;
  let shift = NEWS_SHIFT[t.tilt] * sign;
  const item = {
    id: newsId(at),
    stock: stock.name,
    kind: t.kind,
    text: newsPickOne(t.texts).replaceAll("{n}", stock.name) + (t.rumor ? " (확인되지 않았어요)" : ""),
    tone: t.tone,
    rumor: !!t.rumor,
    manual: false,
    at,
  };
  if (t.rumor) {
    item.rumorTrue = Math.random() < NEWS_RUMOR_TRUE_RATE;
    if (!item.rumorTrue) shift = -shift / 2; // 헛소문이면 반대로 살짝
  }
  item.shift = shift;
  if (t.div !== undefined) item.div = t.div;
  return item;
}

const newsAnnounceLine = (it) => `📰 **[${it.rumor ? "루머" : it.kind}]** **${it.stock}** — ${it.text}`;

// 주식채널의 마지막 공지 메시지 맨 아래에 덧붙여요. 덧붙일 공간이 없으면 새 메시지로 올려요. (급등락 예고와 같은 방식)
async function appendToAnnouncement(env, line) {
  if (!env.DISCORD_BOT_TOKEN) return { sent: false, reason: "DISCORD_BOT_TOKEN 환경변수가 없어요" };
  if (!env.ALLOWED_CHANNEL_ID) return { sent: false, reason: "ALLOWED_CHANNEL_ID 환경변수가 없어요" };
  const doc = await readAnnounceDoc(env);
  if (doc.enabled === false) return { sent: false, reason: "가격 변동 공지가 꺼져 있어요 (공시도 같이 쉬어요)" };

  const channel = env.ALLOWED_CHANNEL_ID;
  try {
    const ids = doc.channelId === channel ? String(doc.messageIds || "").split(",").filter(Boolean) : [];
    const lastId = ids[ids.length - 1];
    if (lastId) {
      const msg = await discordRequest(env, "GET", `/channels/${channel}/messages/${lastId}`);
      const merged = `${msg.content}\n\n${line}`;
      if (merged.length <= 1900) {
        await discordRequest(env, "PATCH", `/channels/${channel}/messages/${lastId}`, { content: merged });
        return { sent: true, mode: "edit" };
      }
    }
    const message = await discordPost(env, `/channels/${channel}/messages`, { content: line, flags: 4096 });
    await setDoc(env, ANNOUNCE_PATH, { messageIds: [...ids, message.id].join(","), channelId: channel });
    return { sent: true, mode: "new" };
  } catch (err) {
    console.error("공시 공지 실패:", err.message);
    return { sent: false, reason: err.message };
  }
}

// queue / recent / cool / divMods에 새 공시를 기록해요
async function saveNewsItems(env, doc, items, patch = {}) {
  const now = Date.now();
  const queue = { ...(doc.queue || {}) };
  const recent = { ...(doc.recent || {}) };
  const cool = Object.fromEntries(Object.entries(doc.cool || {}).filter(([, t]) => now - t < 24 * NEWS_HOUR_MS));
  const divMods = { ...(doc.divMods || {}) };
  for (const it of items) {
    queue[it.id] = it;
    recent[it.id] = { stock: it.stock, kind: it.kind, text: it.text, tone: it.tone, rumor: it.rumor, at: it.at, done: false };
    cool[it.stock] = it.at;
    if (it.div !== undefined) divMods[it.stock] = it.div;
  }
  const keep = Object.entries(recent).sort(([, a], [, b]) => b.at - a.at).slice(0, NEWS_KEEP);
  await setDoc(env, NEWS_PATH, { queue, recent: Object.fromEntries(keep), cool, divMods, ...patch });
}

// 크론(10,25,40,55분마다): 하루 목표 건수를 하루 동안 고르게 퍼뜨려서 올려요
export async function publishNews(env) {
  const now = Date.now();
  const doc = (await getDoc(env, NEWS_PATH)) || {};
  const perDay = doc.perDay ?? NEWS_PER_DAY;
  if (doc.enabled === false || perDay <= 0) return { published: 0, reason: "공시가 꺼져 있어요" };
  if (isSurgeMoment(now)) return { published: 0, reason: "급등락 시각이라 쉬어요" };

  // 하루 목표(예: 4건이면 3~4건)를 날짜가 바뀔 때 한 번 정해요
  const day = todayKST();
  let target = doc.target ?? perDay;
  let count = doc.count ?? 0;
  if (doc.day !== day) {
    target = Math.max(1, perDay - (Math.random() < 0.5 ? 1 : 0));
    count = 0;
    await setDoc(env, NEWS_PATH, { day, target, count });
  }
  const remaining = target - count;
  if (remaining <= 0) return { published: 0, reason: "오늘 공시를 다 올렸어요" };

  // 남은 건수 / 남은 호출 횟수(15분 간격) 확률로 올려서 하루 동안 고르게 퍼져요
  const kst = new Date(now + 9 * NEWS_HOUR_MS);
  const minutesNow = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const callsLeft = Math.max(1, Math.ceil((1440 - minutesNow) / 15));
  if (Math.random() >= Math.min(1, remaining / callsLeft)) return { published: 0, reason: "이번엔 공시가 없어요" };

  const stocks = await listStocks(env);
  const queued = new Set(Object.values(doc.queue || {}).map((i) => i.stock));
  const cool = doc.cool || {};
  const eligible = stocks.filter(
    (s) => !isForeign(s) && s.price > DELIST_PRICE && !queued.has(s.name) && !(cool[s.name] && now - cool[s.name] < NEWS_COOLDOWN_HOURS * NEWS_HOUR_MS)
  );
  if (eligible.length === 0) return { published: 0, reason: "공시할 수 있는 종목이 없어요 (쿨다운 중)" };

  eligible.sort(() => Math.random() - 0.5);
  const n = Math.min(eligible.length, remaining >= 2 && Math.random() < 0.2 ? 2 : 1);
  const items = eligible.slice(0, n).map((s, i) => buildNewsItem(s, now + i));

  // 공지가 먼저 올라가야 유저가 알 수 있어요. 공지가 실패하면 효과도 기록하지 않아요.
  const post = await appendToAnnouncement(env, items.map(newsAnnounceLine).join("\n"));
  if (!post.sent) return { published: 0, reason: post.reason };

  await saveNewsItems(env, doc, items, { day, target, count: count + items.length });
  return { published: items.length, stocks: items.map((i) => i.stock) };
}

// 관리자가 직접 올리는 공시 (/공시). 하루 횟수·쿨다운과 상관없이 바로 올라가요.
export async function postManualNews(env, stockName, text, toneKey) {
  const m = NEWS_MANUAL[toneKey];
  if (!m) return { ok: false, message: "성격을 목록에서 골라 주세요." };
  const content = String(text || "").trim();
  if (content.length < 1 || content.length > 150) return { ok: false, message: "공시 내용은 1~150자로 적어 주세요." };
  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾지 못했어요.` };
  if (isForeign(stock)) return { ok: false, message: "외국자산(코인·해외주식)은 실제 시세를 따라가서 공시를 올릴 수 없어요." };

  const now = Date.now();
  const item = {
    id: newsId(now),
    stock: stock.name ?? stockName,
    kind: "공시",
    text: content,
    tone: m.tone,
    shift: m.tone === "bad" ? -m.shift : m.shift,
    rumor: false,
    manual: true,
    at: now,
  };
  const post = await appendToAnnouncement(env, newsAnnounceLine(item));
  if (!post.sent) return { ok: false, message: `공지를 올리지 못해서 공시를 취소했어요. (${post.reason})` };

  const doc = (await getDoc(env, NEWS_PATH)) || {};
  await saveNewsItems(env, doc, [item]);
  return { ok: true, message: `📰 공시를 올렸어요: **${item.stock}** (${m.label}) — 다음 시세 변동에 반영돼요.` };
}

// 시세 변동 직전에 호출: 올라와 있는 공시를 읽어서 종목별 기울기를 돌려줘요
export async function takeNews(env) {
  const doc = await getDoc(env, NEWS_PATH);
  const items = Object.values(doc?.queue || {});
  if (items.length === 0) return null;
  const shifts = {};
  for (const it of items) shifts[it.stock] = (shifts[it.stock] || 0) + (it.shift || 0);
  for (const k of Object.keys(shifts)) shifts[k] = Math.max(-NEWS_MAX_SHIFT, Math.min(NEWS_MAX_SHIFT, shifts[k]));
  // fv에도 반영할 몫: 실적 발표 공시(fvDone)는 fv를 이미 바꿔 놓았으니 빼요
  const fvShifts = {};
  for (const it of items) if (!it.fvDone) fvShifts[it.stock] = (fvShifts[it.stock] || 0) + (it.shift || 0);
  for (const k of Object.keys(fvShifts)) fvShifts[k] = Math.max(-NEWS_MAX_SHIFT, Math.min(NEWS_MAX_SHIFT, fvShifts[k]));
  return { items, shifts, fvShifts };
}

// 시세 변동 직후에 호출: 반영된 공시를 비우고, 결과 문구를 만들어요
export async function finishNews(env, news, changes) {
  if (!news) return { lines: [], count: 0 };
  const byName = Object.fromEntries(changes.map((c) => [c.name, c]));
  const doc = (await getDoc(env, NEWS_PATH)) || {};
  const queue = { ...(doc.queue || {}) };
  const recent = { ...(doc.recent || {}) };
  const lines = [];

  for (const it of news.items) {
    delete queue[it.id];
    const c = byName[it.stock];
    let line = `**${it.stock}** ${it.rumor ? "루머" : it.kind}`;
    let pct = 0;
    if (!c) {
      line += " → 종목이 사라졌어요";
    } else if (c.delisted) {
      line += " → 🚫 상장폐지";
    } else {
      pct = ((c.after - c.before) / c.before) * 100;
      line += ` → ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
      if (it.rumor) line += it.rumorTrue ? " · 소문이 사실이었어요" : " · 헛소문이었어요";
      else if (it.tone === "good") line += pct > 0 ? " · 공시대로 올랐어요" : " · 호재인데 안 올랐어요";
      else if (it.tone === "bad") line += pct < 0 ? " · 공시대로 내렸어요" : " · 악재인데 안 내렸어요";
    }
    lines.push(line);
    if (recent[it.id]) {
      recent[it.id] = { ...recent[it.id], done: true, pct: Math.round(pct * 10) / 10, delisted: !!c?.delisted, ...(it.rumor ? { rumorTrue: !!it.rumorTrue } : {}) };
    }
  }
  await setDoc(env, NEWS_PATH, { queue, recent });
  return { lines, count: news.items.length };
}

// ---------- 실적 시즌 ----------
// 일정 주기(EARNINGS_INTERVAL_DAYS일)마다 실적 발표 이벤트를 열어요.
//  1) 시작: 대상 종목을 뽑아서 주식채널에 "누가 발표하는지" 미리 알려요. (대상은 일반 종목 중 EARNINGS_TARGET_RATIO 비율)
//  2) 발표(예고 EARNINGS_LEAD_MIN분 뒤 첫 호출): 종목마다 "예상 대비 서프라이즈"를 뽑아서 fv를 한 번에 크게 바꾸고,
//     공시 기록(queue)에 "실적 호조/부진"으로 올려요. 다음 시세 변동 때 가격이 그 방향으로 기울고(공시 방식 그대로),
//     끝나면 평소 공시처럼 "→ +12.3%" 결과가 주식채널 공지에 붙어요. 그 뒤로는 fv 쪽으로 서서히 끌려가요.
//  - 서프라이즈는 0 중심 좌우 대칭이라 호조와 부진이 같은 확률이에요. (한쪽으로 쏠리지 않아요)
//  - 같은 주기에 두 번 실행되지 않게 Firestore config/earnings 에 기록해요:
//      { nextAt: 다음 시작 시각(ms), pending: { key, targets(줄바꿈 구분), releaseAt, announcedAt } | null, lastKey, lastAt }
//  - 호출: cron-job.org에서 5,20,35,50분마다 /api/cron?task=earnings (시세 변동이 0,15,30,45분이라 겹치지 않게 5분 뒤)
//    (평소엔 문서 1개만 읽고 끝나요. 급등락 시각 근처에는 쉬어요.)
//    테스트: /api/cron?task=earnings&force=1 → 주기·시각과 상관없이 지금 바로 시작해요. (진행 중이면 무시)
//  EARNINGS_INTERVAL_DAYS: 실적 시즌 주기(일)    EARNINGS_HOUR_KST: 시작 시각(한국시간 시)
//  EARNINGS_LEAD_MIN: 예고 후 발표까지 최소 대기(분)    EARNINGS_TARGET_RATIO: 대상 종목 비율 (1이면 전부)
//  EARNINGS_SIGMA / EARNINGS_MAX: fv 서프라이즈(로그)의 표준편차 / 최대 크기. (0.18이면 ±20% 안팎, 최대 ±49%쯤)
//  EARNINGS_SHIFT_FACTOR: 서프라이즈의 몇 %를 다음 변동의 가격 기울기로 줄지. (공시 최대 기울기 NEWS_MAX_SHIFT까지만)
//  EARNINGS_ITEMS_PER_POST: 결과 공지를 한 번에 올리는 종목 수 (디스코드 글자 수 제한 때문에 나눠 올려요)
const EARNINGS_PATH = "config/earnings";
const EARNINGS_INTERVAL_DAYS = 7;
const EARNINGS_HOUR_KST = 20;
const EARNINGS_LEAD_MIN = 30;
const EARNINGS_TARGET_RATIO = 0.5;
const EARNINGS_SIGMA = 0.18;
const EARNINGS_MAX = 0.4;
const EARNINGS_SHIFT_FACTOR = 0.5;
const EARNINGS_NAMES_SHOWN = 20;
const EARNINGS_ITEMS_PER_POST = 10;

// 한국시간 EARNINGS_HOUR_KST시 시각(ms). days=0이면 지금 이후 가장 가까운 시각, days>0이면 오늘로부터 days일 뒤 그 시각이에요.
function earningsStartAfter(now, days = 0) {
  const dayStart = Math.floor((now + IDX_KST_MS) / IDX_DAY_MS) * IDX_DAY_MS - IDX_KST_MS;
  let t = dayStart + days * IDX_DAY_MS + EARNINGS_HOUR_KST * NEWS_HOUR_MS;
  if (days === 0 && t <= now) t += IDX_DAY_MS;
  return t;
}

// 크론(5,20,35,50분마다): 시작 / 발표 중 지금 할 일을 해요
export async function runEarnings(env, { force = false } = {}) {
  const now = Date.now();
  if (isSurgeMoment(now)) return { ok: true, skipped: true, reason: "급등락 시각이라 쉬어요" };

  const doc = (await getDoc(env, EARNINGS_PATH)) || {};

  // 예고를 올리고 발표를 기다리는 중
  if (doc.pending) {
    if (now < doc.pending.releaseAt) return { ok: true, phase: "waiting", releaseAt: doc.pending.releaseAt };
    return releaseEarnings(env, doc, now);
  }

  if (!force) {
    if (!Number.isFinite(doc.nextAt)) {
      // 처음 실행: 다음 EARNINGS_HOUR_KST시를 첫 시작으로 정해 둬요
      const nextAt = earningsStartAfter(now);
      await setDoc(env, EARNINGS_PATH, { nextAt });
      return { ok: true, skipped: true, reason: "첫 실행이라 시작 시각만 정해 뒀어요", nextAt };
    }
    if (now < doc.nextAt) return { ok: true, skipped: true, reason: "아직 실적 시즌이 아니에요", nextAt: doc.nextAt };
  }
  return startEarnings(env, doc, now);
}

// 1단계: 대상 뽑기 + 예고 공지
async function startEarnings(env, doc, now) {
  const stocks = await listStocks(env);
  const pool = stocks.filter((s) => !isForeign(s) && s.price > DELIST_PRICE);
  if (pool.length === 0) return { ok: true, skipped: true, reason: "실적을 발표할 일반 종목이 없어요" };

  pool.sort(() => Math.random() - 0.5);
  const count = Math.min(pool.length, Math.max(1, Math.round(pool.length * EARNINGS_TARGET_RATIO)));
  const targets = pool.slice(0, count).map((s) => s.name).sort(compareKo);
  const releaseAt = now + EARNINGS_LEAD_MIN * 60 * 1000;

  // 먼저 기록해서(두 번 시작 방지) 다음 시즌 시각까지 정해 두고, 공지가 실패하면 되돌려요
  const prevNextAt = Number.isFinite(doc.nextAt) ? doc.nextAt : earningsStartAfter(now);
  await setDoc(env, EARNINGS_PATH, {
    pending: { key: String(now), targets: targets.join("\n"), releaseAt, announcedAt: now },
    nextAt: earningsStartAfter(now, EARNINGS_INTERVAL_DAYS),
  });

  const shown = targets.slice(0, EARNINGS_NAMES_SHOWN).map((n) => `**${n}**`).join(", ");
  const more = targets.length > EARNINGS_NAMES_SHOWN ? ` 외 ${targets.length - EARNINGS_NAMES_SHOWN}개` : "";
  const post = await appendToAnnouncement(
    env,
    [
      `📊 **[실적 시즌 예고]** 약 ${EARNINGS_LEAD_MIN}분 뒤 실적을 발표해요!`,
      `발표 대상 ${targets.length}개: ${shown}${more}`,
      "-# 실적이 예상보다 좋으면 기업 가치가 크게 오르고, 나쁘면 크게 내려가요. 발표 결과는 다음 시세 변동에 반영돼요.",
    ].join("\n")
  );
  if (!post.sent) {
    await setDoc(env, EARNINGS_PATH, { pending: null, nextAt: prevNextAt });
    return { ok: false, phase: "announce", reason: post.reason };
  }
  return { ok: true, phase: "announced", targets: targets.length, releaseAt };
}

// 2단계: 서프라이즈 뽑기 → fv 변경 + 공시 기록 + 결과 공지
async function releaseEarnings(env, doc, now) {
  const pending = doc.pending;
  // 두 번 발표되지 않게 먼저 비워요. (공지가 실패하면 아래에서 되돌려서 다음 호출 때 다시 시도해요)
  await setDoc(env, EARNINGS_PATH, { pending: null, lastKey: pending.key, lastAt: now });

  invalidateStocksCache(); // 예고 이후 종목이 바뀌었을 수 있어요
  const stocks = await listStocks(env);
  const byName = Object.fromEntries(stocks.map((s) => [s.name, s]));
  const names = String(pending.targets || "").split("\n").filter(Boolean);

  const items = [];
  const fvChanges = [];
  names.forEach((name, i) => {
    const s = byName[name];
    if (!s || isForeign(s) || s.price <= DELIST_PRICE) return; // 그 사이 사라졌거나 상장폐지된 종목은 빼요
    const surprise = randomSymNormal(EARNINGS_SIGMA, EARNINGS_MAX); // 예상 대비 서프라이즈(로그)
    const pct = (Math.exp(surprise) - 1) * 100;
    const fvOld = Number.isFinite(s.fv) && s.fv > 0 ? s.fv : s.price;
    const fvNew = Math.max(1, Math.round(fvOld * Math.exp(surprise) * 100) / 100);
    const good = surprise >= 0;
    const shift = Math.max(-NEWS_MAX_SHIFT, Math.min(NEWS_MAX_SHIFT, pct * EARNINGS_SHIFT_FACTOR));
    const at = now + i;
    fvChanges.push({ name, fv: fvNew });
    items.push({
      id: newsId(at),
      stock: name,
      kind: good ? "실적 호조" : "실적 부진",
      text: `${name} 이번 분기 실적이 시장 예상보다 약 ${Math.round(Math.abs(pct))}% ${good ? "좋았어요" : "나빴어요"}`,
      tone: good ? "good" : "bad",
      shift: Math.round(shift * 10) / 10,
      rumor: false,
      manual: false,
      earnings: true,
      fvDone: true, // fv는 여기서 이미 바꿨어요. 다음 변동에서 공시로 fv를 또 움직이지 않아요.
      at,
    });
  });
  if (items.length === 0) return { ok: true, phase: "released", released: 0, reason: "발표할 종목이 남아 있지 않았어요" };

  // 결과 공지가 먼저 올라가야 유저가 알 수 있어요. 첫 공지가 실패하면 되돌려서 다음 호출 때 다시 시도해요.
  const chunks = [];
  for (let i = 0; i < items.length; i += EARNINGS_ITEMS_PER_POST) chunks.push(items.slice(i, i + EARNINGS_ITEMS_PER_POST));
  for (let c = 0; c < chunks.length; c++) {
    const lines = chunks[c].map(newsAnnounceLine);
    const head = c === 0 ? [`📊 **[실적 발표]** ${items.length}개 종목의 실적이 나왔어요! 다음 시세 변동에 반영돼요.`] : [];
    const post = await appendToAnnouncement(env, [...head, ...lines].join("\n"));
    if (!post.sent) {
      if (c === 0) {
        await setDoc(env, EARNINGS_PATH, { pending, lastKey: doc.lastKey ?? "" });
        return { ok: false, phase: "release", reason: post.reason };
      }
      console.error("실적 발표 공지 일부 실패:", post.reason); // 일부만 실패해도 효과는 그대로 기록해요
    }
  }

  // 공시 기록(다음 변동에 반영) + 기업 가치 변경
  const newsDoc = (await getDoc(env, NEWS_PATH)) || {};
  await saveNewsItems(env, newsDoc, items);
  const results = await Promise.allSettled(fvChanges.map((f) => setDoc(env, `stocks/${encodeURIComponent(f.name)}`, { fv: f.fv })));
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`실적 fv 저장 실패 (${fvChanges[i].name}):`, r.reason?.message);
  });
  invalidateStocksCache();
  return { ok: true, phase: "released", released: items.length, stocks: items.map((it) => `${it.stock} ${it.kind}`) };
}

// /공시설정 (관리자)
export async function setNewsConfig(env, { enabled, perDay }) {
  const patch = {};
  if (enabled !== undefined) patch.enabled = enabled;
  if (perDay !== undefined) {
    patch.perDay = perDay;
    // 오늘 목표도 바로 바꿔요 (안 바꾸면 내일부터 적용돼요). 오늘 이미 올린 건수(count)는 그대로 두고 목표만 새로 정해요.
    const cur = (await getDoc(env, NEWS_PATH)) || {};
    if (cur.day === todayKST()) patch.target = perDay <= 0 ? 0 : Math.max(1, perDay - (Math.random() < 0.5 ? 1 : 0));
  }
  if (Object.keys(patch).length) await setDoc(env, NEWS_PATH, patch);
  const doc = (await getDoc(env, NEWS_PATH)) || {};
  return { enabled: doc.enabled !== false, perDay: doc.perDay ?? NEWS_PER_DAY, queued: Object.keys(doc.queue || {}).length };
}

// /공시목록: 최근 공시와 결과
export async function newsListText(env) {
  const doc = (await getDoc(env, NEWS_PATH)) || {};
  const list = Object.values(doc.recent || {}).sort((a, b) => b.at - a.at).slice(0, 10);
  if (list.length === 0) return "아직 올라온 공시가 없어요.";
  const lines = ["**📰 최근 공시**", ""];
  for (const r of list) {
    let result = "⏳ 다음 변동에 반영 예정";
    if (r.done) {
      if (r.delisted) result = "🚫 상장폐지";
      else {
        result = `${r.pct > 0 ? "+" : ""}${r.pct}%`;
        if (r.rumor) result += r.rumorTrue ? " · 사실이었어요" : " · 헛소문이었어요";
      }
    }
    lines.push(`- ${formatKST(r.at)} **${r.stock}** [${r.rumor ? "루머" : r.kind}] ${r.text}\n  → ${result}`);
  }
  return lines.join("\n");
}

// 디스코드는 같은 이름의 옵션을 반복할 수 없어서 종목2, 수량2 … 처럼 이름을 나눠요.
const MAX_SLOTS = 5;
const slotSuffix = (i) => (i <= 1 ? "" : String(i));
function multi(base, count = MAX_SLOTS) {
  const out = [...base];
  for (let i = 2; i <= count; i++) {
    for (const o of base) {
      out.push({ ...o, name: o.name + i, required: false, description: `[${i}번째] ${o.description}`.slice(0, 100) });
    }
  }
  return out;
}

export const commandDefinitions = [
  { name: "도움말", description: "사용할 수 있는 명령어 목록을 봅니다." },
  { name: "출석체크", description: "오늘 출석하고 해정을 받습니다. 하루 1회." },
  { name: "채굴", description: "채굴장에서 노가다로 해정을 법니다. (체력 소모, 출석보다 훨씬 효율이 좋아요)" },
  { name: "채굴정보", description: "내 채굴 레벨, 체력, 다음 업그레이드 조건을 봅니다." },
  { name: "채굴업그레이드", description: "채굴 장비를 업그레이드합니다. (해정 지불 또는 노가다 조건 달성)" },
  {
    name: "주식목록",
    description: "현재 거래 가능한 종목과 가격을 봅니다. (기본: 이름순)",
    options: [
      {
        name: "정렬",
        description: "정렬 방식 (안 고르면 이름순)",
        type: 3,
        required: false,
        choices: [
          { name: "이름순", value: "name" },
          { name: "가격 낮은순 (오름차순)", value: "price_asc" },
          { name: "가격 높은순 (내림차순)", value: "price_desc" },
          { name: "변동 큰순 (상승률 높은순)", value: "change_desc" },
          { name: "변동 낮은순 (하락률 큰순)", value: "change_asc" },
        ],
      },
    ],
  },
  {
    name: "그래프",
    description: "종목의 시세 그래프를 그립니다. 종목2~5로 여러 종목을 한 번에 봐요.",
    options: multi([
      { name: "종목", description: "그래프를 볼 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
    ]),
  },
  {
    name: "상장폐지종류",
    description: "상장폐지된 종목과 하락률을 봅니다. 종목(2~5까지)을 고르면 그래프도 그려요. (최신순)",
    options: [
      ...multi([{ name: "종목", description: "그래프를 볼 폐지 종목 (안 고르면 목록)", type: 3, required: false, autocomplete: true }]),
      { name: "개수", description: "볼 종목 개수 (기본 10, 최대 20)", type: 4, required: false, autocomplete: true },
    ],
  },
  { name: "보유종목", description: "유저들이 어떤 주식을 보유 중인지 모두에게 보여줍니다. (알림 없이 표시)" },
  { name: "잔고", description: "내 해정 잔고와 보유 종목을 봅니다." },
  { name: "내정보", description: "내 잔고, 보유 종목 평가액, 총자산, 순위를 한 번에 봅니다." },
  {
    name: "종목정보",
    description: "종목의 상장일, 최고가, 오늘 변동폭, 배당 예상을 한 화면에 봅니다.",
    options: [{ name: "종목", description: "정보를 볼 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true }],
  },
  { name: "지수", description: "해정지수(전체 종목 평균 주가)와 오늘 시장이 올랐는지 한눈에 봅니다." },
  { name: "봇현황", description: "시장에 참여 중인 AI 봇의 평균 자산과 인기 종목을 봅니다." },
  { name: "랭킹", description: "총 자산 기준 랭킹을 봅니다." },
  {
    name: "내역",
    description: "내 최근 거래·출석 기록을 봅니다.",
    options: [
      { name: "개수", description: "볼 기록 개수 (기본 10, 최대 30)", type: 4, required: false, autocomplete: true },
    ],
  },
  {
    name: "매수",
    description: "종목을 매수합니다. (수수료 0.3%) 종목2~5로 여러 종목을 한 번에 사요. 수량 기본 1주.",
    options: multi([
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "매수할 수량 (기본 1, '최대'는 살 수 있는 만큼)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "매도",
    description: "종목을 매도합니다. (수수료 0.3% + 거래세 0.2%) 종목2~5로 여러 종목을 한 번에 팔아요. 수량 기본 1주.",
    options: multi([
      { name: "종목", description: "내가 가진 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "매도할 수량 (기본 1, '전량'은 보유 전부)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "예약매수",
    description: "지정가 이하가 되면 자동 매수하도록 예약합니다. 종목2~5로 여러 개를 한 번에 예약해요.",
    options: multi([
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "이 가격 이하가 되면 매수 (해정, 외국자산은 센트: 1000 = $10.00)", type: 4, required: true, autocomplete: true },
      { name: "수량", description: "매수할 수량 (기본 1)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "예약매도",
    description: "지정가 이상이 되면 자동 매도하도록 예약합니다. 종목2~5로 여러 개를 한 번에 예약해요.",
    options: multi([
      { name: "종목", description: "내가 가진 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "이 가격 이상이 되면 매도 (해정, 외국자산은 센트: 1000 = $10.00)", type: 4, required: true, autocomplete: true },
      { name: "수량", description: "매도할 수량 (기본 1)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "자동매도",
    description: "내 평균 매수가 기준으로 손절(-%)/익절(+%) 자동 매도를 걸어요. 하나가 체결되면 나머지는 취소돼요.",
    options: [
      { name: "종목", description: "내가 가진 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "손절", description: "평균 매수가보다 이만큼(%) 떨어지면 매도 (예: 20)", type: 4, required: false, autocomplete: true, min_value: 1, max_value: 99 },
      { name: "익절", description: "평균 매수가보다 이만큼(%) 오르면 매도 (예: 30)", type: 4, required: false, autocomplete: true, min_value: 1, max_value: 1000 },
      { name: "수량", description: "매도할 수량 (안 적으면 보유 전량)", type: 4, required: false, autocomplete: true, min_value: 1 },
    ],
  },
  { name: "예약목록", description: "내가 걸어둔 예약·손절·익절 목록을 봅니다." },
  {
    name: "관심추가",
    description: "관심종목에 담아둡니다. (최대 20개, 관심목록에서 한눈에 봐요)",
    options: [{ name: "종목", description: "담을 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true }],
  },
  {
    name: "관심삭제",
    description: "관심종목에서 뺍니다. (그 종목에 걸어둔 가격 알림도 같이 지워요)",
    options: [{ name: "종목", description: "뺄 종목 (목록에서 선택, '전체 삭제'도 가능)", type: 3, required: true, autocomplete: true }],
  },
  { name: "관심목록", description: "내 관심종목의 현재가·오늘 등락과 가격 알림을 한눈에 봅니다." },
  {
    name: "가격알림",
    description: "종목이 정한 가격에 도달하면 DM으로 알려줘요. (한 번 알리고 자동 삭제, 관심종목에도 담겨요)",
    options: [
      { name: "종목", description: "알림을 받을 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "이 가격에 도달하면 DM (높으면 이상, 낮으면 이하 · 외국자산은 센트)", type: 4, required: true, autocomplete: true, min_value: 1 },
    ],
  },
  {
    name: "알림취소",
    description: "걸어둔 가격 알림을 취소합니다.",
    options: [{ name: "알림", description: "취소할 알림 (목록에서 선택, '전체 취소'도 가능)", type: 3, required: true, autocomplete: true }],
  },
  {
    name: "예약취소",
    description: "걸어둔 예약을 취소합니다. 예약2~5로 여러 건을 한 번에 취소해요.",
    options: multi([
      { name: "예약", description: "취소할 예약 (목록에서 선택, '전체 취소'도 가능)", type: 3, required: true, autocomplete: true },
    ]),
  },
  {
    name: "선물",
    description: "주식 선물: 오를지(롱) 내릴지(숏)에 배율을 걸고 베팅합니다. (사용법은 /선물설명)",
    options: [
      { name: "종목", description: "베팅할 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      {
        name: "방향",
        description: "오를 것 같으면 롱, 내릴 것 같으면 숏",
        type: 3,
        required: true,
        choices: [
          { name: "📈 롱 (오르면 이득)", value: "long" },
          { name: "📉 숏 (내리면 이득)", value: "short" },
        ],
      },
      { name: "증거금", description: "걸 금액 (해정 종목은 최소 100해정, 외국자산은 달러 단위로 최소 1달러)", type: 4, required: true, autocomplete: true, min_value: 1 },
      {
        name: "배율",
        description: "배율 (클수록 많이 벌고, 많이 잃어요)",
        type: 4,
        required: true,
        choices: FUTURES_LEVERAGES.map((n) => ({ name: `${n}배`, value: n })),
      },
    ],
  },
  { name: "선물목록", description: "내 선물 포지션과 현재 손익을 봅니다." },
  {
    name: "선물청산",
    description: "선물 포지션을 정산하고 해정을 받습니다. 포지션2~3으로 여러 건을 한 번에 정산해요.",
    options: multi(
      [{ name: "포지션", description: "정산할 포지션 (목록에서 선택, '전체 정산'도 가능)", type: 3, required: true, autocomplete: true }],
      MAX_FUTURES_PER_USER
    ),
  },
  { name: "선물설명", description: "선물이 뭔지, 어떻게 쓰는지 쉽게 알려줍니다." },
  { name: "은행", description: "내 예금·대출·이자·대출 한도·신용등급을 지금 이 순간 기준으로 봅니다." },
  { name: "배당", description: "내 보유 종목의 배당금 예상액과 받은 내역을 봅니다." },
  { name: "은행설명", description: "은행 이용법을 쉽게 알려줍니다. (예금·대출·이자·연체)" },
  { name: "환율", description: "지금 환율(1달러가 몇 해정인지)과 내 달러를 봅니다. 환율은 1시간마다 바뀌어요." },
  {
    name: "환전",
    description: "해정과 달러를 서로 바꿉니다. 외국자산(코인·미국주식)은 달러로 거래해요. (수수료 1%)",
    options: [
      {
        name: "방향",
        description: "어느 쪽으로 바꿀지",
        type: 3,
        required: true,
        choices: [
          { name: "💵 해정 → 달러", value: "toUsd" },
          { name: "💰 달러 → 해정", value: "toKrw" },
        ],
      },
      { name: "금액", description: "해정→달러는 낼 해정, 달러→해정은 낼 달러(정수)", type: 4, required: true, autocomplete: true, min_value: 1 },
    ],
  },
  {
    name: "예금",
    description: "해정을 은행에 맡기고 이자를 받습니다. 이자는 시간이 흐르는 대로 쌓여요.",
    options: [{ name: "금액", description: "맡길 해정 (칸을 누르면 예시가 떠요)", type: 4, required: true, autocomplete: true, min_value: 1 }],
  },
  {
    name: "출금",
    description: "은행 예금을 찾아 잔고로 가져옵니다. 쌓인 이자도 같이 나와요.",
    options: [{ name: "금액", description: "찾을 해정 (안 적으면 전액)", type: 4, required: false, autocomplete: true, min_value: 1 }],
  },
  {
    name: "송금",
    description: `다른 유저에게 해정을 보냅니다. 은행 수수료 ${pctText(TRANSFER_FEE_RATE)}가 붙어요.`,
    options: [
      { name: "받는사람", description: "해정을 받을 유저", type: 6, required: true },
      { name: "금액", description: `보낼 해정 (최소 ${TRANSFER_MIN}, 수수료는 따로 붙어요)`, type: 4, required: true, autocomplete: true, min_value: TRANSFER_MIN },
    ],
  },
  {
    name: "대출",
    description: "은행에서 해정을 빌립니다. 기간 안에 이자와 함께 갚아야 해요. (사용법은 /은행설명)",
    options: [
      { name: "금액", description: "빌릴 해정 (칸을 누르면 한도 안의 예시가 떠요)", type: 4, required: true, autocomplete: true, min_value: LOAN_MIN },
      {
        name: "기간",
        description: "갚을 기간 (칸을 누르면 지금 시장금리가 떠요. 이자율은 빌린 순간에 고정돼요)",
        type: 4,
        required: true,
        autocomplete: true, // 금리가 매시 바뀌어서, 이름에 금리를 박아두지 않고 누를 때마다 실시간으로 보여줘요
        min_value: 1,
      },
    ],
  },
  {
    name: "상환",
    description: "대출을 갚습니다. 일부만 갚거나 전부 갚을 수 있어요. (이자 먼저, 그다음 원금)",
    options: [
      { name: "대출", description: "갚을 대출 (목록에서 선택, '전체 상환'도 가능)", type: 3, required: true, autocomplete: true },
      { name: "금액", description: "갚을 해정 (안 적으면 전액)", type: 4, required: false, autocomplete: true, min_value: 1 },
    ],
  },
  { name: "보험", description: "상장폐지 보험 설명과 내가 가입한 보험을 봅니다." },
  {
    name: "보험가입",
    description: "가진 종목이 상장폐지되면 보험금을 받는 보험에 가입합니다. (기간이 길수록 보험료가 비싸요)",
    options: [
      { name: "종목", description: "보험에 들 종목 (가진 종목만, 칸을 누르면 보험료가 떠요)", type: 3, required: true, autocomplete: true },
      { name: "기간", description: "보험 기간(일, 1~30). 길수록 보험료가 비싸져요", type: 4, required: true, min_value: 1, max_value: 30 },
      { name: "수량", description: "보장할 주식 수 (안 적으면 가진 만큼 전부)", type: 4, required: false, min_value: 1 },
    ],
  },
  {
    name: "보험해지",
    description: "가입한 보험을 해지하고 보험료 일부를 돌려받습니다.",
    options: [
      { name: "종목", description: "해지할 보험의 종목", type: 3, required: true, autocomplete: true },
    ],
  },
  { name: "주식상점", description: "구입할 수 있는 상품 목록을 모두에게 보여줍니다. (가격 낮은 순, 알림 없이 표시)" },
  {
    name: "구입",
    description: "주식상점에서 상품을 구입합니다. 상품2~5로 여러 상품을 한 번에 사요. 수량 기본 1개.",
    options: multi([
      { name: "상품", description: "상품 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "구입할 개수 (기본 1, 칸을 누르면 살 수 있는 최대 개수가 떠요)", type: 4, required: false, autocomplete: true },
    ]),
  },
  { name: "보유상품", description: "내가 구입한 상품 목록을 봅니다." },
  {
    name: "알림설정",
    description: "시세 알림과 받을 시간대를 설정합니다. 여러 개를 동시에 켤 수 있어요.",
    options: [
      { name: "전체", description: "모든 종목 시세 변동 알림", type: 5, required: false },
      { name: "상승", description: "내가 보유한 종목이 오를 때 알림", type: 5, required: false },
      { name: "하락", description: "내가 보유한 종목이 내릴 때 알림", type: 5, required: false },
      { name: "시작", description: "알림 받을 시작 시각 (한국시간 0~23)", type: 4, required: false, autocomplete: true },
      { name: "종료", description: "알림 받을 종료 시각 (한국시간 0~23, 시작과 같으면 하루 종일)", type: 4, required: false, autocomplete: true },
    ],
  },
  { name: "알림확인", description: "현재 알림 설정을 봅니다." },
  {
    name: "종목추가",
    description: "[관리자] 새 종목을 등록합니다. 종목2~5로 여러 종목을 한 번에 등록해요.",
    options: [
      ...multi([
        { name: "종목", description: "종목 이름", type: 3, required: true },
        { name: "가격", description: "초기 가격(해정)", type: 4, required: true, autocomplete: true },
      ]),
      // 업종: 안 고르면 랜덤 배정. 여러 종목을 한 번에 등록하면 모두 같은 업종이에요.
      { name: "업종", description: "업종 (안 고르면 랜덤 배정)", type: 3, required: false, choices: [...SECTORS, NO_SECTOR].map((s) => ({ name: s, value: s })) },
      // 변동성 등급: 안 고르면 가격으로 정해요. (가격이 높을수록 대형)
      { name: "등급", description: "변동성 등급 (안 고르면 가격에 맞춰 자동)", type: 3, required: false, choices: VOL_TIERS.map((t) => ({ name: t, value: t })) },
    ],
  },
  {
    name: "종목삭제",
    description: "[관리자] 종목을 삭제합니다. 종목2~5로 여러 종목을 한 번에 삭제해요.",
    options: multi([
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
    ]),
  },
  {
    name: "종목생성",
    description: "새 종목을 1000해정에 상장합니다. 이름2~5로 여러 개를 한 번에, 하루 횟수 제한이 있어요.",
    options: multi([
      { name: "이름", description: "새 종목 이름 (1~12자)", type: 3, required: true },
    ]),
  },
  {
    name: "시세설정",
    description: "[관리자] 종목 가격을 변경합니다. 종목2~5로 여러 종목을 한 번에 바꿔요.",
    options: multi([
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "새 가격(해정)", type: 4, required: true, autocomplete: true },
    ]),
  },
  {
    name: "출석설정",
    description: "[관리자] 출석 보상과 출석체크 사용 여부를 설정합니다.",
    options: [
      { name: "보상", description: "출석 보상(해정)", type: 4, required: false, autocomplete: true },
      { name: "활성화", description: "출석체크 켜기/끄기", type: 5, required: false },
    ],
  },
  {
    name: "체력회복",
    description: "[관리자] 모든 유저의 채굴 체력을 가득 채웁니다.",
  },
  {
    name: "공시",
    description: "[관리자] 종목에 공시를 올립니다. 다음 시세 변동에 호재/악재가 반영돼요.",
    options: [
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "내용", description: "공시 내용 (150자 이내)", type: 3, required: true, max_length: 150 },
      {
        name: "성격",
        description: "다음 변동에 미치는 영향",
        type: 3,
        required: true,
        choices: Object.entries(NEWS_MANUAL).map(([value, m]) => ({ name: m.label, value })),
      },
    ],
  },
  {
    name: "공시설정",
    description: "[관리자] 자동 공시를 켜고 끄거나 하루 횟수를 정합니다.",
    options: [
      { name: "활성화", description: "자동 공시 켜기/끄기", type: 5, required: false },
      { name: "하루횟수", description: "하루 평균 공시 수 (0이면 자동 공시 없음)", type: 4, required: false, min_value: 0, max_value: 30 },
    ],
  },
  { name: "공시목록", description: "최근 올라온 공시와 그 결과를 봅니다." },
  {
    name: "주식질문",
    description: "해정 주식 게임에 대해 AI에게 물어봅니다. (가이드 내용 기반)",
    options: [{ name: "질문", description: "궁금한 내용 (예: 선물 배율은 어떻게 정해져요?)", type: 3, required: true, max_length: 300 }],
  },
];

// ---- 1-2) 명령어 이름 ----
// 이제 /묶음 없이 /매수, /잔고 처럼 바로 써요.
// 다만 해정펫 봇 같은 다른 봇과 이름이 겹치는 명령어는 앞에 "주식"을 붙여서 등록해요. (예: /주식랭킹)
// 겹치는 게 더 생기면 아래 목록에 이름만 추가한 뒤 register를 다시 실행하세요.
export const STOCK_PREFIXED = new Set(["도움말", "랭킹", "출석체크"]);

// 예전 /묶음 명령어 이름 (register할 때 지워져요. tools.js의 list가 남아 있는지 확인할 때 써요)
export const ROOT_COMMAND = "주식";

// 디스코드에 실제로 등록되는 이름
export function registeredName(name) {
  return STOCK_PREFIXED.has(name) ? `주식${name}` : name;
}

// 등록된 이름 -> 원래 이름 (주식랭킹 -> 랭킹)
const originalName = {};
for (const n of STOCK_PREFIXED) originalName[`주식${n}`] = n;

// 설명 문구에 쓰는 입력 경로. 예: "매수" -> "/매수", "랭킹" -> "/주식랭킹"
export function commandPath(name) {
  return `/${registeredName(name)}`;
}

// 디스코드에 실제로 등록하는 목록 (tools.js의 register가 이걸 써요)
export function buildRegisterPayload() {
  if (commandDefinitions.length > 100) {
    throw new Error(`명령어가 ${commandDefinitions.length}개예요. 디스코드는 100개까지만 등록할 수 있어요.`);
  }
  return commandDefinitions.map((def) => {
    const cmd = { name: registeredName(def.name), description: def.description };
    if (def.options?.length) cmd.options = def.options;
    return cmd;
  });
}

// 들어온 요청의 이름을 원래 이름으로 되돌려요. (주식랭킹 -> 랭킹)
// 그래서 handlers / autocomplete / opt 같은 기존 코드는 하나도 안 고쳐도 돼요.
export function flattenInteraction(interaction) {
  const data = interaction.data;
  if (data && originalName[data.name]) data.name = originalName[data.name];
  return interaction;
}

// ---- 2) 옵션 파싱 헬퍼 ----
function opt(interaction, name) {
  const found = interaction.data.options?.find((o) => o.name === name);
  return found?.value;
}

// 여러 종목의 결과(문자열 = 안내/오류, 객체 = 임베드)를 하나의 응답으로 합쳐요.
function combineResults(results) {
  const embeds = [];
  const notes = [];
  for (const r of results) {
    if (typeof r === "string") notes.push(r);
    else embeds.push(...(r.embeds || []));
  }
  if (embeds.length === 0) return notes.join("\n");
  return { ...(notes.length ? { content: notes.join("\n") } : {}), embeds };
}

const slotLabel = (n) => (n <= 1 ? "" : `${n}번째 `);

// 종목(또는 상품)·수량·가격 칸을 번호순으로 읽어요: [{ n, name, qty, price }]
// 칸이 비어 있는데 수량/가격만 있거나, 수량이 정수가 아니면 error를 돌려줘요.
function readSlots(interaction, nameKey, { price = false } = {}) {
  const slots = [];
  for (let i = 1; i <= MAX_SLOTS; i++) {
    const s = slotSuffix(i);
    const rawName = String(opt(interaction, nameKey + s) ?? "").trim();
    const qtyRaw = opt(interaction, "수량" + s);
    const priceRaw = price ? opt(interaction, "가격" + s) : undefined;
    if (!rawName) {
      if (qtyRaw !== undefined || priceRaw !== undefined) {
        return { error: `${nameKey}${s} 없이 수량/가격만 입력했어요. ${nameKey}${s}도 골라 주세요.` };
      }
      continue;
    }
    const qty = qtyRaw ?? 1;
    if (!Number.isSafeInteger(qty) || qty <= 0) return { error: `${slotLabel(i)}수량은 1 이상의 정수여야 해요.` };
    if (price && priceRaw === undefined) return { error: `${slotLabel(i)}가격을 입력해 주세요.` };
    slots.push({ n: i, name: rawName, qty, price: priceRaw });
  }
  return { slots };
}

// 같은 이름은 수량을 합쳐요 (매수/매도/구입). 반환: { items: [{ name, qty }], merged: 합친 적 있는지, error }
function mergeSlots(slots) {
  const map = new Map();
  let merged = false;
  for (const s of slots) {
    if (map.has(s.name)) merged = true;
    map.set(s.name, (map.get(s.name) || 0) + s.qty);
  }
  const items = [...map].map(([name, qty]) => ({ name, qty }));
  if (items.some((i) => !Number.isSafeInteger(i.qty))) return { error: "수량이 너무 커요. 수량을 줄여 주세요." };
  return { items, merged };
}

// 자동완성용: 앞 칸에 이미 고른 만큼 잔고/보유 수량을 미리 빼서 보여줘요. (매수·구입은 잔고, 매도·예약매도는 보유 수량)
function priorAdjusted(command, interaction, slot, user, priceMap, foreignNames = new Set()) {
  const isBuy = command === "매수" || command === "구입";
  const isSell = command === "매도" || command === "예약매도";
  if (!isBuy && !isSell) return user;
  const cur = slot === "" ? 1 : Number(slot);
  const nameKey = command === "구입" ? "상품" : "종목";
  const copy = { ...user, holdings: { ...user.holdings } };
  for (let i = 1; i < cur; i++) {
    const s = slotSuffix(i);
    const name = String(opt(interaction, nameKey + s) ?? "").trim();
    if (!name) continue;
    const qty = Number(opt(interaction, "수량" + s) ?? 1);
    if (!Number.isSafeInteger(qty) || qty < 1) continue;
    if (isBuy) {
      const price = priceMap[name];
      if (price === undefined) continue;
      if (foreignNames.has(name)) copy.usd = (copy.usd || 0) - price * qty; // 외국자산은 달러(센트)에서 빼요
      else copy.balance -= price * qty;
    } else {
      copy.holdings[name] = Math.max(0, (copy.holdings[name] || 0) - qty);
    }
  }
  return copy;
}

function isAdmin(interaction, env) {
  return interaction.member?.user?.id === env.ADMIN_DISCORD_ID;
}

// 밀리초 타임스탬프 -> "MM-DD HH:mm" (한국시간)
function formatKST(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace("T", " ");
}

// 밀리초 타임스탬프 -> "YYYY-MM-DD HH:mm" (한국시간)
function formatKSTFull(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// 상장일 표시 (기록이 없는 예전 종목은 "기록 없음")
const listedText = (ms) => (Number.isFinite(ms) ? `\`${formatKSTFull(ms)}\`` : "기록 없음");

function notifyStatusText(s, title) {
  const mark = (on) => (on ? "✅ 켜짐" : "❌ 꺼짐");
  const hasWindow = Number.isInteger(s.start) && Number.isInteger(s.end) && s.start !== s.end;
  const windowText = hasWindow ? `${s.start}시 ~ ${s.end}시 (한국시간)` : "하루 종일";
  return [
    `**${title}**`,
    `- 전체 시세 변동: ${mark(s.all)}`,
    `- 내 보유 종목 상승: ${mark(s.up)}`,
    `- 내 보유 종목 하락: ${mark(s.down)}`,
    `- 알림 받는 시간: ${windowText}`,
  ].join("\n");
}

function helpText() {
  const user = [];
  const admin = [];
  for (const c of commandDefinitions) {
    const line = `\`${commandPath(c.name)}\` — ${c.description}`;
    (c.description.includes("[관리자]") ? admin : user).push(line);
  }
  return [
    "**📖 해정 봇 도움말**",
    "",
    "**일반 명령어**",
    ...user,
    "",
    "**관리자 명령어**",
    ...admin,
  ].join("\n");
}

// ---- 3) 자동완성 ----
// Discord는 한 번에 최대 25개, 항목 이름은 100자까지만 보여줘요.

// 글자 입력으로 거르는 목록용: items = [{ label, value }]
function textChoices(items, keyword) {
  const lower = keyword.toLowerCase();
  return items
    .filter((i) => i.value.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((i) => ({ name: i.label.slice(0, 100), value: i.value }));
}

// 숫자 옵션용: suggestions = [{ label, value(정수) }]
// 숫자를 입력하면 그 숫자를 맨 앞에 보여주고, 같은 숫자로 시작하는 예시만 남겨요.
function numberChoices(suggestions, keyword, labelFor) {
  const seen = new Set();
  const list = [];
  const push = (label, value) => {
    if (seen.has(value)) return;
    seen.add(value);
    list.push({ name: String(label).slice(0, 100), value });
  };

  if (/^\d+$/.test(keyword)) {
    const typed = Number(keyword);
    const exists = suggestions.some((s) => s.value === typed);
    if (!exists && Number.isSafeInteger(typed)) push(labelFor ? labelFor(typed) : typed.toLocaleString(), typed);
    for (const s of suggestions) {
      if (String(s.value).startsWith(keyword)) push(s.label, s.value);
    }
  } else {
    for (const s of suggestions) push(s.label, s.value);
  }
  return list.slice(0, 25);
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  label: `${h}시 (${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시)`,
  value: h,
}));

// 매수/매도 수량 예시 + 미리보기
// 수량 칸을 누르면 "이 수량으로 사고팔면 잔고가 얼마가 되는지, 이득/손해가 얼마인지"가 항목마다 보여요.
async function quantityChoices(command, interaction, env, keyword, slot = "") {
  const defaults = [1, 5, 10];

  // 구입: 고른 상품 가격으로 "몇 개 사면 잔고가 얼마가 되는지" 미리 보여줘요.
  if (command === "구입") {
    const plainItems = () => numberChoices(defaults.map((n) => ({ label: `${n}개`, value: n })), keyword);
    const productName = String(opt(interaction, "상품" + slot) ?? "").trim();
    const buyerId = interaction.member?.user?.id;
    if (!productName || !buyerId) return plainItems();

    const [products, buyerRaw] = await Promise.all([listProducts(env), getUser(env, buyerId)]);
    const buyer = priorAdjusted(command, interaction, slot, buyerRaw, Object.fromEntries(products.map((p) => [p.name, p.price])));
    const product = products.find((p) => p.name === productName);
    if (!product) return plainItems();

    const maxQty = product.price > 0 ? Math.floor(buyer.balance / product.price) : 0;
    const itemLabel = (q) => {
      if (q <= 0) return "1개 이상 입력해 주세요";
      const cost = product.price * q;
      return buyer.balance >= cost
        ? `${q.toLocaleString()}개 구입 → -${cost.toLocaleString()}해정 · 잔고 ${(buyer.balance - cost).toLocaleString()}해정`
        : `${q.toLocaleString()}개 구입 불가 (필요 ${cost.toLocaleString()} / 잔고 ${buyer.balance.toLocaleString()}해정)`;
    };
    const itemValues = maxQty > 0 ? [...defaults.filter((n) => n < maxQty), maxQty] : defaults;
    return numberChoices(
      itemValues.map((v) => ({ label: (v === maxQty && maxQty > 0 ? "최대 " : "") + itemLabel(v), value: v })),
      keyword,
      itemLabel
    );
  }

  const plain = () => numberChoices(defaults.map((n) => ({ label: `${n}주`, value: n })), keyword);

  const stockName = String(opt(interaction, "종목" + slot) ?? "").trim();
  const userId = interaction.member?.user?.id;
  if (!stockName || !userId) return plain();

  // 종목 목록은 자동완성 캐시에서 가져오고(읽기 0~30건), 종목 1건 조회는 따로 하지 않아요.
  const [all, userRaw] = await Promise.all([listStocksForAutocomplete(env), getUser(env, userId)]);
  const stock = all.find((s) => s.name === stockName);
  if (!stock) return plain();
  const user = slot ? priorAdjusted(command, interaction, slot, userRaw, Object.fromEntries(all.map((s) => [s.name, s.price])), new Set(all.filter((s) => isForeign(s)).map((s) => s.name))) : userRaw;

  let labelFor;
  let values;

  if (command === "매수") {
    const haveNow = isForeign(stock) ? user.usd || 0 : user.balance;
    const max = maxBuyQty(haveNow, stock.price);
    labelFor = (q) => {
      if (q <= 0) return "1주 이상 입력해 주세요";
      const p = previewBuy(user, stock, q);
      return p.ok
        ? `${q.toLocaleString()}주 매수 → -${moneyOf(stock, p.cost)}(수수료 ${moneyOf(stock, p.fee)}) · ${isForeign(stock) ? "달러" : "잔고"} ${moneyOf(stock, p.after)}`
        : `${q.toLocaleString()}주 매수 불가 (필요 ${moneyOf(stock, p.cost)} / ${isForeign(stock) ? "달러" : "잔고"} ${moneyOf(stock, haveNow)})`;
    };
    values = max > 0 ? [...defaults.filter((n) => n < max), max] : defaults;
    return numberChoices(
      values.map((v) => ({ label: (v === max && max > 0 ? "최대 " : "") + labelFor(v), value: v })),
      keyword,
      labelFor
    );
  }

  // 매도
  const held = user.holdings[stockName] || 0;
  labelFor = (q) => {
    if (q <= 0) return "1주 이상 입력해 주세요";
    const p = previewSell(user, stock, q);
    if (!p.ok) return `${q.toLocaleString()}주 매도 불가 (보유 ${held.toLocaleString()}주)`;
    return `${q.toLocaleString()}주 매도 → +${moneyOf(stock, p.earned)} · ${isForeign(stock) ? "달러" : "잔고"} ${moneyOf(stock, p.after)} · ${isForeign(stock) ? profitUsdLabel(p.profit, p.basis, true) : profitLabel(p.profit, p.basis, true)}`;
  };
  values = held > 0 ? [...defaults.filter((n) => n < held), held] : defaults;
  return numberChoices(
    values.map((v) => ({ label: (v === held && held > 0 ? "전량 " : "") + labelFor(v), value: v })),
    keyword,
    labelFor
  );
}

// 시세설정 가격 예시: 현재가 기준 -50% ~ +100%
async function priceSuggestions(interaction, env, slot = "") {
  const stockName = String(opt(interaction, "종목" + slot) ?? "").trim();
  if (!stockName) return [];
  const stock = (await listStocksForAutocomplete(env)).find((s) => s.name === stockName);
  if (!stock) return [];

  const p = stock.price;
  const list = [{ label: `현재가 ${moneyOf(stock, p)}`, value: p }];
  for (const m of [0.5, 0.8, 1.2, 1.5, 2]) {
    const value = Math.max(1, Math.round(p * m));
    const pct = Math.round((m - 1) * 100);
    list.push({ label: `${pct > 0 ? "+" : ""}${pct}% → ${moneyOf(stock, value)}`, value });
  }
  return list.sort((a, b) => a.value - b.value);
}

// (interaction, env) => Promise<[{ name, value }]>
export async function autocomplete(interaction, env) {
  const focused = interaction.data.options?.find((o) => o.focused);
  if (!focused) return [];

  const command = interaction.data.name;
  const keyword = String(focused.value ?? "").trim();
  // 종목2, 수량3 처럼 번호가 붙은 칸은 base(종목/수량…)와 slot(번호)로 나눠서 같은 방식으로 처리해요.
  const base = focused.name.replace(/\d+$/, "");
  const slot = focused.name.slice(base.length);

  // 같은 명령어의 다른 칸에 이미 고른 값은 목록에서 빼요 (그래프/삭제/시세설정/폐지 조회/예약취소)
  const taken = new Set();
  if (["그래프", "종목삭제", "시세설정", "상장폐지종류", "예약취소", "선물청산"].includes(command)) {
    for (const o of interaction.data.options || []) {
      if (o.focused || o.name === focused.name) continue;
      if (o.name.replace(/\d+$/, "") === base) taken.add(String(o.value).trim());
    }
  }
  const pickable = (items) => items.filter((i) => !taken.has(i.value));

  // ----- 상장폐지종류: 폐지된 종목 이름 (최신 폐지순, 같은 이름은 가장 최근 것만) -----
  if (base === "종목" && command === "상장폐지종류") {
    const delisted = await listDelisted(env, 200);
    const seen = new Set();
    const items = [];
    for (const d of delisted) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      items.push({
        label: `🚫 ${d.name} (${formatKST(d.delistedAt)} 폐지 · 최대 하락 -${d.maxDropPct}%)`,
        value: d.name,
      });
    }
    return textChoices(pickable(items), keyword);
  }

  // ----- 종목 이름 (종목추가는 새 이름을 입력하는 거라 제외) -----
  if (base === "종목" && command !== "종목추가") {
    const stocks = await listStocksForAutocomplete(env); // 이름순 (60초 캐시)
    // 미국 장이 닫혀 있으면 미국 주식 옆에 🌙장마감 표시 (자동완성은 3초 제한이라 확인은 1초까지만 기다려요)
    const usClosed = stocks.some((s) => s.kind === "us" && ["매수", "예약매수", "매도", "예약매도", "자동매도", "선물"].includes(command))
      ? !(await getUsMarketStatus(env, Date.now(), 1000)).open
      : false;
    const mTag = (s) => staleTag(s) + (usClosed && s.kind === "us" ? " 🌙장마감" : "");

    const userId = interaction.member?.user?.id;
    const rawUser = userId ? await getUser(env, userId) : { balance: 0, holdings: {}, costs: {} };
    const user = priorAdjusted(command, interaction, slot, rawUser, Object.fromEntries(stocks.map((s) => [s.name, s.price])), new Set(stocks.filter((s) => isForeign(s)).map((s) => s.name)));

    if (command === "관심삭제") {
      // 내 관심종목만 보여줌
      const w = userId ? await getWatch(env, userId) : { stocks: {}, alerts: {} };
      const items = stocks
        .filter((s) => w.stocks[s.name])
        .map((s) => ({ label: `${iconName(s)} (${moneyOf(s, s.price)})${mTag(s)}`, value: s.name }));
      if (items.length > 1) items.push({ label: "전체 삭제", value: "all" });
      return textChoices(items, keyword);
    }

    if (command === "매도" || command === "예약매도" || command === "자동매도") {
      // 매도는 내가 가진 종목만 보여줌 (현재가 기준 평가손익 함께 표시)
      return textChoices(
        stocks
          .filter((s) => (user.holdings[s.name] || 0) > 0)
          .map((s) => {
            const qty = user.holdings[s.name];
            const cost = costOf(user, s.name, s.price);
            return {
              label: `${iconName(s)}${dangerTag(s.price, true)} (보유 ${qty}주 · ${moneyOf(s, s.price)} · ${isForeign(s) ? profitUsdLabel(s.price * qty - cost, cost, true) : profitLabel(s.price * qty - cost, cost, true)})${mTag(s)}`,
              value: s.name,
            };
          }),
        keyword
      );
    }

    if (command === "보험가입") {
  const items = stocks
    .filter((s) => !isForeign(s) && (user.holdings[s.name] || 0) > 0 && s.price > DANGER_PRICE)
    .map((s) => ({
      label: `${s.name} (보유 ${user.holdings[s.name].toLocaleString()}주 · ${s.price.toLocaleString()}해정 · 주당 보험료 1일 ${insuranceQuote(s.price, 1).perShare.toLocaleString()} / 3일 ${insuranceQuote(s.price, 3).perShare.toLocaleString()} / 30일 ${insuranceQuote(s.price, 30).perShare.toLocaleString()})`,
      value: s.name,
    }));
  if (items.length === 0) {
    return [{ name: "보험에 들 수 있는 종목이 없어요 (보유 주식이 없거나 위기 종목뿐)", value: "없음" }];
  }
  return textChoices(items, keyword);
}

    if (command === "보험해지") {
      // 내가 가입 중인 보험만 자동완성으로 보여주고, 예상 환급액도 같이 보여줘요
      const active = activeInsurance(user);
      return textChoices(
        Object.entries(active).map(([name, p]) => {
          const remainMs = Math.max(0, p.expiresAt - Date.now());
          const refund = Math.floor(p.premium * (remainMs / (p.term * DAY_MS)) * INSURANCE_CANCEL_REFUND_RATE);
          return {
            label: `${name} (보장 ${p.qty.toLocaleString()}주 · ${leftText(remainMs)} 남음 · 예상 환급 ${refund.toLocaleString()}해정)`,
            value: name,
          };
        }),
        keyword
      );
    }

    if (command === "매수" || command === "예약매수") {
      // 매수는 지금 잔고로 최대 몇 주까지 살 수 있는지 함께 표시
      return textChoices(
        stocks.map((s) => ({
          label: `${iconName(s)}${dangerTag(s.price, true)} (${moneyOf(s, s.price)} · 최대 ${maxBuyQty(isForeign(s) ? user.usd || 0 : user.balance, s.price).toLocaleString()}주)${mTag(s)}`,
          value: s.name,
        })),
        keyword
      );
    }

    return textChoices(
      pickable(stocks.map((s) => ({ label: `${iconName(s)}${dangerTag(s.price, true)} (${moneyOf(s, s.price)})${mTag(s)}`, value: s.name }))),
      keyword
    );
  }

  // ----- 상품 이름: 가격 낮은 순, 설명 포함 -----
  if (base === "상품") {
    const products = await listProducts(env);
    return textChoices(
      products.map((p) => ({
        label: `${p.name} — ${p.price.toLocaleString()}해정${p.description ? ` · ${p.description}` : ""}`,
        value: p.name,
      })),
      keyword
    );
  }

  // ----- 환전: 금액 예시 (받을 금액 미리보기) -----
  if (command === "환전" && focused.name === "금액") {
    const userId = interaction.member?.user?.id;
    if (!userId) return [];
    const [user, fx] = await Promise.all([getUser(env, userId), getFxRate(env)]);
    if (opt(interaction, "방향") === "toKrw") {
      const dollars = Math.floor((user.usd || 0) / 100);
      const getKrw = (n) => Math.floor(n * fx.rate * (1 - FX_FEE_RATE));
      const list = [1, 5, 10, 50, 100]
        .filter((n) => n < dollars)
        .map((n) => ({ label: `$${n} → 약 ${getKrw(n).toLocaleString()}해정`, value: n }));
      if (dollars >= 1) list.push({ label: `전액 $${dollars} → 약 ${getKrw(dollars).toLocaleString()}해정`, value: dollars });
      return numberChoices(list, keyword);
    }
    const getUsd = (n) => centsText(Math.floor(((n * 100) / fx.rate) * (1 - FX_FEE_RATE)));
    const list = [100, 500, 1000, 5000, 10000]
      .filter((n) => n >= FX_MIN_KRW && n < user.balance)
      .map((n) => ({ label: `${n.toLocaleString()}해정 → 약 ${getUsd(n)}`, value: n }));
    if (user.balance >= FX_MIN_KRW) list.push({ label: `전액 ${user.balance.toLocaleString()}해정 → 약 ${getUsd(user.balance)}`, value: user.balance });
    return numberChoices(list, keyword);
  }

  // ----- 송금: 잔고 기준 금액 예시 (수수료까지 낼 수 있는 만큼만) -----
  if (command === "송금" && focused.name === "금액") {
    const userId = interaction.member?.user?.id;
    if (!userId) return [];
    const user = await getUser(env, userId);
    const max = maxTransferable(user.balance);
    const list = [100, 500, 1000, 5000, 10000]
      .filter((n) => n < max)
      .map((n) => ({ label: `${n.toLocaleString()}해정 (수수료 ${transferFee(n).toLocaleString()})`, value: n }));
    if (max >= TRANSFER_MIN) list.push({ label: `최대 ${max.toLocaleString()}해정 (수수료 ${transferFee(max).toLocaleString()})`, value: max });
    return numberChoices(list, keyword);
  }

  // ----- 은행: 예금/출금/대출/상환 -----
  if (["예금", "출금", "대출", "상환"].includes(command)) {
    const userId = interaction.member?.user?.id;
    if (!userId) return [];
    const now = Date.now();

    // 상환: 대출 고르기 / 금액 예시
    if (command === "상환") {
      const bank = accrueBank(await getBank(env, userId), now);
      const loans = loansByDue(bank);
      if (focused.name === "대출") {
        const items = loans.map(({ id, l }) => ({
          label: `[${id}] ${l.term}일 대출 · 갚을 돈 ${loanOwed(l).toLocaleString()}해정${isOverdue(l, now) ? " · 🚨연체" : ""}`,
          value: id,
        }));
        if (items.length > 1) items.push({ label: "전체 상환 (잔고가 닿는 만큼, 만기 빠른 순)", value: "all" });
        return textChoices(items, keyword);
      }
      const picked = bank.loans[String(opt(interaction, "대출") ?? "")];
      if (!picked) return [];
      const owed = loanOwed(picked);
      const list = [
        { label: `전액 ${owed.toLocaleString()}해정 (이자 ${interestOwed(picked).toLocaleString()} + 원금 ${picked.principal.toLocaleString()})`, value: owed },
      ];
      if (interestOwed(picked) > 0 && interestOwed(picked) < owed) list.push({ label: `이자만 ${interestOwed(picked).toLocaleString()}해정`, value: interestOwed(picked) });
      if (owed >= 200) list.push({ label: `절반 ${Math.floor(owed / 2).toLocaleString()}해정`, value: Math.floor(owed / 2) });
      return numberChoices(list, keyword);
    }

    // 예금: 잔고 기준 예시
    if (command === "예금") {
      const user = await getUser(env, userId);
      const list = [100, 500, 1000, 5000, 10000]
        .filter((n) => n < user.balance)
        .map((n) => ({ label: `${n.toLocaleString()}해정`, value: n }));
      if (user.balance >= 1) list.push({ label: `전액 ${user.balance.toLocaleString()}해정`, value: user.balance });
      return numberChoices(list, keyword);
    }

    // 출금: 예금 기준 예시
    if (command === "출금") {
      const have = depositOf(accrueBank(await getBank(env, userId), now));
      const list = [100, 500, 1000, 5000]
        .filter((n) => n < have)
        .map((n) => ({ label: `${n.toLocaleString()}해정`, value: n }));
      if (have >= 1) list.push({ label: `전액 ${have.toLocaleString()}해정`, value: have });
      return numberChoices(list, keyword);
    }

    // 대출 기간: 지금 시장금리 × 내 신용등급 배율 (빌리는 순간 이 이자율로 고정돼요)
    if (focused.name === "기간") {
      const bank = await getBank(env, userId);
      const grade = creditGrade(bank.credit);
      const choices = Object.keys(LOAN_TERMS).map((d) => ({
        name: `${d}일 (지금 이자 하루 ${pctText(loanRateOf(bank.rate?.loanRates?.[d] ?? LOAN_TERMS[d], grade.rateMul))} · 시장금리 ×${bank.rate?.mult ?? 1})`,
        value: Number(d),
      }));
      return choices.filter((c) => !keyword || String(c.value).startsWith(keyword));
    }

    // 대출: 남은 한도 안의 예시
    const [user, bank0, stocks] = await Promise.all([getUser(env, userId), getBank(env, userId), listStocksForAutocomplete(env)]);
    const bank = accrueBank(bank0, now);
    const { net } = await netWorthOf(env, userId, user, bank, stocks);
    const { available } = loanLimitOf(net, bank);
    const list = [100, 500, 1000, 5000, 10000]
      .filter((n) => n < available)
      .map((n) => ({ label: `${n.toLocaleString()}해정`, value: n }));
    if (available >= LOAN_MIN) list.push({ label: `최대 ${available.toLocaleString()}해정 (남은 한도)`, value: available });
    return numberChoices(list, keyword);
  }

  // ----- 선물청산: 내 선물 포지션 (현재 손익 표시) -----
  if (base === "포지션") {
    const userId = interaction.member?.user?.id;
    const [items, stocks] = await Promise.all([userId ? getFutureItems(env, userId) : {}, listStocksForAutocomplete(env)]);
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    const list = futureList(items).map((f) => {
      const price = priceMap[f.stock];
      const pnlText = price === undefined ? "상장폐지" : f.cur === "usd" ? profitUsdLabel(futureEquity(f, price) - f.margin, f.margin, true) : profitLabel(futureEquity(f, price) - f.margin, f.margin, true);
      return { label: `[${f.id}] ${f.stock} ${sideLabel(f.side)} x${f.lev} · ${pnlText}`, value: f.id };
    });
    const left = pickable(list);
    if (left.length > 1 && taken.size === 0) left.push({ label: "전체 정산", value: "all" }); // 전체 정산은 첫 칸에서만
    return textChoices(left, keyword);
  }

  // ----- 선물 증거금 예시 -----
  if (base === "증거금") {
    const userId = interaction.member?.user?.id;
    const user = userId ? await getUser(env, userId) : { balance: 0, usd: 0 };
    const pickedStock = (await listStocksForAutocomplete(env)).find((s) => s.name === String(opt(interaction, "종목") ?? "").trim());
    if (pickedStock && isForeign(pickedStock)) {
      // 외국자산 선물: 달러 단위 정수
      const dollars = Math.floor((user.usd || 0) / 100);
      const dl = [1, 5, 10, 50, 100].filter((n) => n < dollars).map((n) => ({ label: `$${n}`, value: n }));
      if (dollars >= 1) dl.push({ label: `전액 $${dollars}`, value: dollars });
      return numberChoices(dl, keyword);
    }
    const list = [100, 500, 1000, 5000, 10000]
      .filter((n) => n <= user.balance)
      .map((n) => ({ label: `${n.toLocaleString()}해정`, value: n }));
    if (user.balance >= MIN_FUTURES_MARGIN) list.push({ label: `전액 ${user.balance.toLocaleString()}해정`, value: user.balance });
    return numberChoices(list, keyword);
  }

  // ----- 예약취소: 내 예약 목록 -----
  if (base === "예약") {
    const userId = interaction.member?.user?.id;
    const [orders, acStocks] = await Promise.all([userId ? getOrders(env, userId) : [], listStocksForAutocomplete(env)]);
    const stockMap = Object.fromEntries(acStocks.map((s) => [s.name, s]));
    const items = orders.map((o) => ({
      label: `[${o.id}] ${o.kind ? `${o.kind} ` : ""}${sideText(o.side)} ${o.stock} · ${moneyOf(stockMap[o.stock], o.price)} ${o.side === "buy" || o.dir === "down" ? "이하" : "이상"} · ${o.qty.toLocaleString()}주`,
      value: o.id,
    }));
    const left = pickable(items);
    if (left.length > 1 && taken.size === 0) left.push({ label: "전체 취소", value: "all" }); // 전체 취소는 첫 칸에서만
    return textChoices(left, keyword);
  }

  // ----- 알림취소: 내 가격 알림 목록 -----
  if (base === "알림" && command === "알림취소") {
    const userId = interaction.member?.user?.id;
    const list = userId ? alertList((await getWatch(env, userId)).alerts) : [];
    const stockMap = Object.fromEntries((await listStocksForAutocomplete(env)).map((s) => [s.name, s]));
    const items = list.map((a) => ({
      label: `[${a.id}] ${a.stock} · ${moneyOf(stockMap[a.stock], a.price)} ${alertDirText(a.dir)}`,
      value: a.id,
    }));
    if (items.length > 1) items.push({ label: "전체 취소", value: "all" });
    return textChoices(items, keyword);
  }

  // ----- 숫자 옵션 -----
  if (base === "수량") {
    // 예약은 체결 시점 가격이 달라서 미리보기 없이 예시만 보여줌
    if (command === "예약매수" || command === "예약매도" || command === "자동매도") {
      return numberChoices([1, 5, 10, 50, 100].map((n) => ({ label: `${n}주`, value: n })), keyword);
    }
    return quantityChoices(command, interaction, env, keyword, slot);
  }

  if (command === "자동매도" && (focused.name === "손절" || focused.name === "익절")) {
    const list = focused.name === "손절" ? [5, 10, 20, 30, 50] : [10, 20, 30, 50, 100];
    const sign = focused.name === "손절" ? "-" : "+";
    return numberChoices(list.map((n) => ({ label: `${sign}${n}%`, value: n })), keyword);
  }

  if (focused.name === "개수") {
    return numberChoices([5, 10, 20, 30].map((n) => ({ label: `${n}건`, value: n })), keyword);
  }

  if (focused.name === "시작" || focused.name === "종료") {
    return numberChoices(HOURS, keyword);
  }

  if (base === "가격") {
    if (command === "시세설정" || command === "예약매수" || command === "예약매도" || command === "가격알림") {
      return numberChoices(await priceSuggestions(interaction, env, slot), keyword);
    }
    // 종목추가: 초기 가격 예시
    return numberChoices(
      [500, 1000, 5000, 10000, 50000].map((n) => ({ label: `${n.toLocaleString()}해정`, value: n })),
      keyword
    );
  }

  if (focused.name === "보상") {
    const config = await getAttendanceConfig(env);
    const list = [{ label: `현재 ${config.reward.toLocaleString()}해정`, value: config.reward }];
    for (const n of [100, 500, 1000, 5000]) {
      list.push({ label: `${n.toLocaleString()}해정`, value: n });
    }
    return numberChoices(list.sort((a, b) => a.value - b.value), keyword);
  }

  return [];
}

// 예약 매수/매도 공통 처리 (side: "buy" | "sell"). 종목/가격/수량 칸을 최대 5세트까지 한 번에 받아요.
// 하나라도 조건이 안 맞으면 아무 예약도 걸지 않고, 안 맞는 이유를 모두 알려줘요.
async function reserveOrder(side, interaction, env) {
  const userId = interaction.member.user.id;
  const { slots, error } = readSlots(interaction, "종목", { price: true });
  if (error) return error;
  if (!slots.length) return "종목을 골라 주세요.";
  for (const s of slots) {
    if (!Number.isSafeInteger(s.price) || s.price < 1) return `${slotLabel(s.n)}가격은 1 이상의 정수여야 해요.`;
  }

  // 디스코드 3초 제한 때문에 한 번에 같이 조회
  const [stocks, user, items] = await Promise.all([
    Promise.all(slots.map((s) => getStock(env, s.name))),
    getUser(env, userId),
    getOrderItems(env, userId),
  ]);

  const many = slots.length > 1;
  const tag = (s) => (many ? `[${s.n}번째 ${s.name}] ` : "");
  const errors = [];

  const missing = slots.filter((_, i) => !stocks[i]);
  if (missing.length) errors.push(...missing.map((s) => `${tag(s)}"${s.name}" 종목을 찾을 수 없어요.`));

  const current = Object.keys(items).length;
  if (current + slots.length > MAX_ORDERS_PER_USER) {
    errors.push(
      `예약은 최대 ${MAX_ORDERS_PER_USER}개까지 걸 수 있어요. (지금 ${current}개 + 이번 ${slots.length}개) \`/예약취소\`로 정리한 뒤 다시 시도해 주세요.`
    );
  }

  // 매도 예약 수량: 이미 걸어둔 것 + 이번 명령에서 앞 칸에 건 것까지 합쳐서 보유 수량을 넘지 않게
  const reserved = reservedSellQty(items);

  slots.forEach((s, i) => {
    const stock = stocks[i];
    if (!stock) return;
    if (side === "buy") {
      if (stock.price <= s.price) {
        errors.push(`${tag(s)}현재가(${moneyOf(stock, stock.price)})가 이미 예약가 이하예요. 바로 \`/매수\`를 쓰거나, 더 낮은 가격으로 예약해 주세요.`);
      } else if ((isForeign(stock) ? user.usd || 0 : user.balance) < s.price * s.qty + tradeFee(s.price * s.qty)) {
        errors.push(`${tag(s)}${isForeign(stock) ? "달러가" : "잔고가"} 부족해요. (예약가 기준 필요: ${moneyOf(stock, s.price * s.qty + tradeFee(s.price * s.qty))}(수수료 포함), 보유: ${moneyOf(stock, isForeign(stock) ? user.usd || 0 : user.balance)})`);
      }
    } else {
      if (stock.price >= s.price) {
        errors.push(`${tag(s)}현재가(${moneyOf(stock, stock.price)})가 이미 예약가 이상이에요. 바로 \`/매도\`를 쓰거나, 더 높은 가격으로 예약해 주세요.`);
        return;
      }
      const held = user.holdings[s.name] || 0;
      const already = reserved[s.name] || 0;
      if (held - already < s.qty) {
        errors.push(`${tag(s)}예약할 수 있는 보유 수량이 부족해요. (보유 ${held.toLocaleString()}주 · 이미 매도 예약 ${already.toLocaleString()}주)`);
      } else {
        reserved[s.name] = already + s.qty;
      }
    }
  });

  if (errors.length) return [...errors, ...(many ? ["(아무 예약도 걸지 않았어요.)"] : [])].join("\n");

  const next = { ...items };
  const made = slots.map((s, i) => {
    const id = newOrderId(next);
    const order = { stock: s.name, side, qty: s.qty, price: s.price, at: Date.now() + i };
    next[id] = order;
    return { id, order, now: stocks[i].price, stock: stocks[i] };
  });
  await saveOrderItems(env, userId, next);

  const footer = "시세가 변동될 때(평소 변동, 급등락)마다 확인하고, 체결되면 DM으로 알려드려요. (체결가는 그때의 현재가예요)";
  if (!many) {
    const { id, order, now, stock } = made[0];
    return [`⏰ 예약했어요. \`${id}\``, orderText(order, stock), `현재가 ${moneyOf(stock, now)} · ${footer}`].join("\n");
  }
  return [
    `⏰ ${made.length}건을 예약했어요.`,
    ...made.map((m) => `- \`${m.id}\` ${orderText(m.order, m.stock)} · 현재가 ${moneyOf(m.stock, m.now)}`),
    footer,
  ].join("\n");
}

// 종목 1개의 정보 카드: 상장일 · 최고가 · 오늘 변동폭 · 배당 예상을 한 화면에
// held: 내가 가진 수량, divMod: 공시로 정해진 배당 배수 (1 = 평소, 2 = 확대, 0 = 무배당)
function stockInfoText(stock, held = 0, divMod = 1, now = Date.now(), market = null) {
  const sgn = (n, d = 1) => `${n > 0 ? "+" : n < 0 ? "-" : ""}${Math.abs(n).toFixed(d)}`;
  const mark = (n) => (n > 0 ? UP_MARK : n < 0 ? DOWN_MARK : "➖");

  // 오늘(한국시간 0시~) 변동폭: 0시 시점 가격과 오늘 기록들 중 최고/최저
  const pts = getPriceHistory(stock);
  const dayStart = Math.floor((now + IDX_KST_MS) / IDX_DAY_MS) * IDX_DAY_MS - IDX_KST_MS;
  const open = pts.length ? priceAtTime(pts, dayStart) : stock.price;
  const todayPrices = [open, ...pts.filter((x) => x.t > dayStart).map((x) => x.p), stock.price];
  const hi = Math.max(...todayPrices);
  const lo = Math.min(...todayPrices);
  const rangePct = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
  const dayPct = open > 0 ? ((stock.price - open) / open) * 100 : 0;

  const maxPrice = Math.max(stock.maxPrice || 0, stock.price);
  const ofMax = maxPrice > 0 ? (stock.price / maxPrice) * 100 : 100;
  const days = Number.isFinite(stock.listedAt) ? Math.floor((now - stock.listedAt) / IDX_DAY_MS) + 1 : null;

  // 배당 예상 (지급은 매일 오전 DIVIDEND_HOUR시 이후 첫 시세 변동 때, 지급 시점의 가격 기준)
  let divLine;
  if (stock.price <= DANGER_PRICE) {
    divLine = `💵 배당: 위기 종목(${DANGER_PRICE.toLocaleString()}해정 이하)이라 **무배당**이에요.`;
  } else if (divMod === 0) {
    divLine = "💵 배당: 공시로 **무배당** 예정이에요.";
  } else {
    const pay = (qty) => Math.floor(dividendOf(stock.price, qty) * divMod).toLocaleString();
    divLine =
      `💵 배당 예상: 하루 ${pctText(DIVIDEND_RATE)}${divMod === 2 ? " ×2(공시 확대)" : ""} · 10주 약 **${pay(10)}해정** · 100주 약 **${pay(100)}해정**` +
      `${held > 0 ? `\n   ↳ 내 보유 ${held.toLocaleString()}주 → 약 **+${pay(held)}해정**` : ""}` +
      `\n   (매일 오전 ${DIVIDEND_HOUR}시 이후 첫 시세 변동 때 지급 · 지급 시점 가격 기준 · 배당소득세 ${pctText(DIVIDEND_TAX_RATE)} 뗀 금액)`;
  }

  return [
    `**🏷️ ${iconName(stock)} 종목정보**`,
    `${mark(dayPct)} 현재가 **${moneyOf(stock, stock.price)}**${dangerTag(stock.price) ? `${dangerTag(stock.price)} 상장폐지 위기` : ""} · 오늘 ${sgn(dayPct)}% (0시 ${moneyOf(stock, open)})`,
    `🗓️ 상장일: ${listedText(stock.listedAt)} (한국시간)${days ? ` · 상장 ${days.toLocaleString()}일째` : ""}`,
    ...(isForeign(stock) ? [] : [`🏢 업종: **${sectorOf(stock)}** · 📊 변동성 등급: **${tierOf(stock)}**`]),
    `🏆 역대 최고가: **${moneyOf(stock, maxPrice)}** (지금은 최고가의 ${ofMax.toFixed(1)}%)`,
    `📏 오늘 변동폭: 최고 ${moneyOf(stock, hi)} ~ 최저 ${moneyOf(stock, lo)} (**${rangePct.toFixed(1)}%**)`,
    ...(isForeign(stock) ? foreignInfoLines(stock, now, market) : [divLine]),
  ].join("\n");
}

// 종목 1개의 시세 그래프: 문자열(안내/오류) 또는 { embeds: [...] }
async function stockChart(env, name) {
    const stock = await getStock(env, name);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요.`;

    const points = getPriceHistory(stock);
    if (points.length < 2) {
      return `**${name}**의 시세 기록이 아직 부족해요. 시세가 한 번 더 변동된 뒤에 다시 시도해 주세요.`;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const prices = points.map((p) => p.p);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const diff = last.p - first.p;
    const pct = first.p > 0 ? (diff / first.p) * 100 : 0;
    const up = diff >= 0;
    const mark = diff > 0 ? UP_MARK : diff < 0 ? DOWN_MARK : "➖";

    const imageUrl = await renderStockChart(points, up);

    return {
      embeds: [
        {
          title: `${name} 시세 그래프`,
          description: [
            `🗓️ 상장일: ${listedText(stock.listedAt)} (한국시간)`,
            `${mark} 현재가 **${moneyOf(stock, stock.price)}**${dangerTag(stock.price) ? `${dangerTag(stock.price)} 상장폐지 위기` : ""}`,
            `구간 변동: ${mark} ${diff > 0 ? "+" : diff < 0 ? "-" : ""}${moneyOf(stock, Math.abs(diff))} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) · ${formatKST(first.t)} 시작가 ${moneyOf(stock, first.p)} 대비`,
            `구간 최고 ${moneyOf(stock, high)} / 최저 ${moneyOf(stock, low)}`,
            `역대 최고가 ${moneyOf(stock, Math.max(stock.maxPrice || 0, high))}`,
          ].join("\n"),
          color: up ? 0xe53935 : 0x1e88e5, // 오름 = 빨강, 내림 = 파랑
          image: { url: imageUrl },
          footer: { text: `최근 ${points.length}개 기록 · ${formatKST(first.t)} ~ ${formatKST(last.t)} (한국시간)` },
        },
      ],
    };
}

// ---- 4) 커맨드별 핸들러: (interaction, env) => Promise<string> ----
// /선물설명: 처음 보는 사람도 바로 이해하도록 짧게
function futuresHelpText() {
  return [
    "**📈 주식 선물 사용법**",
    "\"이 주식이 오를까, 내릴까?\"를 **배율**을 걸고 맞히는 게임이에요.",
    "`/선물 종목 방향 증거금 배율` 칸 4개만 채우면 시작!",
    "",
    "**용어는 3개만 알면 돼요**",
    "- 📈 **롱**: 오르면 이득, 내리면 손해",
    "- 📉 **숏**: 내리면 이득, 오르면 손해",
    "- **증거금**: 걸어두는 해정이에요. 잃어도 이만큼만 잃어요",
    "",
    "**예시** — 증거금 1,000해정 · 롱 · 3배",
    "- 가격 +10% → 🔺 +300해정 (3배라서 +30%)",
    "- 가격 -10% → 🔽 -300해정",
    "- 가격 약 -33% → 💥 강제청산 (증거금 전부 잃어요)",
    "",
    "**💵 코인·미국주식 선물은 달러로 해요**",
    "- 증거금을 **달러**(1달러 단위, 최소 $1)로 걸고, 정산도 달러로 돌아와요",
    "- 달러가 모자라면 `/환전`으로 해정을 바꿔 오세요",
    "- 가격은 랜덤이 아니라 실제 시세를 따라가요 (급등락 시간에도 똑같아요)",
    "- 미국주식은 미국 장이 닫혀 있으면 새로 열 수 없어요",
    "",
    "**명령어**",
    "`/선물` 시작 · `/선물목록` 내 손익 보기 · `/선물청산` 정산하고 해정 받기",
    "",
    "**꼭 알아두세요**",
    "- 시세는 15분마다 크게 움직여요. 배율이 높을수록 한 번에 강제청산되기 쉬워요",
    "- 급등락 시간(18시/21시/0시)에는 변동이 훨씬 커서 더 위험해요",
    "- 강제청산은 시세가 바뀔 때 자동으로 돼요. 시작할 때 강제청산가를 알려줘요",
    "- 상장폐지되면 폐지 가격으로 자동 정산돼요",
    `- 최대 ${MAX_FUTURES_PER_USER}개까지 열 수 있고, 증거금은 ${MIN_FUTURES_MARGIN}해정부터예요 (외국자산은 $1부터)`,
  ].join("\n");
}

// /은행설명: 처음 보는 사람도 바로 이해하도록 짧게
function bankHelpText(rate) {
  const now = Date.now();
  const depositRate = rate?.depositRate ?? DEPOSIT_RATE;
  const rate3 = loanRateOf(rate?.loanRates?.[3] ?? LOAN_TERMS[3]);
  return [
    "**🏦 해정 은행 사용법**",
    "맡기면 **이자를 받고**, 빌리면 **이자를 내요.** 이자는 시간이 흐르는 대로 실시간으로 쌓여요.",
    "",
    marketRateLine(rate, now),
    `금리는 **매시 정각**에 랜덤으로 바뀌어요 (배율 ×${MARKET_RATE_MIN_MULT}~×${MARKET_RATE_MAX_MULT}). 예금 하루 ${pctText(DEPOSIT_RATE * MARKET_RATE_MIN_MULT)}~${pctText(DEPOSIT_RATE * MARKET_RATE_MAX_MULT)}, 대출은 하루 ${pctText(LOAN_RATE_FLOOR)} 밑으로는 안 내려가요.`,
    "",
    "**🐷 예금** — 지금 하루 " + pctText(depositRate) + " (이자는 바뀐 금리대로 구간마다 쌓여요)",
    "`/예금 금액` 맡기기 · `/출금` 찾기 (금액을 안 적으면 전액)",
    "",
    "**💸 대출**",
    "`/대출 금액 기간` — 기간: 1일 / 3일 / 7일 (지금 이자율은 기간 칸을 누르면 보여요)",
    "- 이자율은 **빌린 순간의 시장금리**로 정해지고, **만기까지 안 바뀌어요** (신용등급 배율도 그때 기준)",
    `- 빌릴 때 수수료 ${pctText(LOAN_FEE_RATE)}를 먼저 떼고 받아요 (빚은 빌린 금액 그대로)`,
    "- 이자는 빌린 순간부터 시간 단위로 계속 쌓여요",
    "- 일찍 갚으면 **그때까지 쌓인 이자만** 내요",
    `- 한도: 내 순자산(해정+달러+주식+예금+선물-빚)의 ${Math.round(LOAN_LIMIT_RATIO * 100)}%(신용등급에 따라 달라져요), 최소 ${LOAN_LIMIT_MIN.toLocaleString()}해정`,
    `- 동시에 최대 ${MAX_LOANS_PER_USER}건`,
    "",
    "**예시** 지금 1,000해정을 3일로 빌리면? (신용등급 B 기준)",
    "- 하루 " + pctText(rate3) + " → 3일 꽉 채우면 이자 약 " + Math.round(1000 * rate3 * 3) + "해정",
    "- 1일 만에 갚으면 이자 약 " + Math.round(1000 * rate3) + "해정",
    "",
    "**💳 상환**",
    "`/상환 대출 금액` — 금액을 안 적으면 전액. 일부만 갚아도 돼요 (이자 먼저, 그다음 원금)",
    "",
    "**🚨 못 갚으면?**",
    "1. 만기가 되면 은행이 내 **잔고 → 예금** 순서로 자동으로 가져가요",
    `2. 그래도 모자라면 **연체**: 하루 +${pctText(LOAN_PENALTY_RATE)}p 연체 이자가 붙고, 새 대출은 막혀요`,
    `3. 연체 ${LIQUIDATE_AFTER_HOURS}시간 뒤에도 못 갚으면 **보유 주식이 강제로 팔려요** (큰 종목부터)`,
    "4. 그래도 빚이 남으면 해정이 들어올 때마다 자동으로 갚아져요",
    `⏰ 만기 ${REMIND_BEFORE_HOURS}시간 전에 DM으로 알려줘요`,
    "",
    "**💳 신용등급** (S · A · B · C · D · F)",
    `처음엔 ${CREDIT_START}점(B). 제때 갚으면 오르고, 연체하면 크게 떨어져요.`,
    `- 제때 완납 +${CREDIT_ON_TIME}점 (${CREDIT_MIN_LOAN.toLocaleString()}해정 이상, ${CREDIT_MIN_HOLD_HOURS}시간 이상 쓴 대출만)`,
    `- 연체 ${CREDIT_LATE_PENALTY}점 · 강제 매도 ${CREDIT_LIQUIDATE_PENALTY}점`,
    "- 등급이 높으면 대출 한도↑ 이자↓, 낮으면 한도↓ 이자↑",
    CREDIT_GRADES.map((g) => `${g.name}(${g.min}점~) 한도×${g.limitMul}·이자×${g.rateMul}`).join(" / "),
    "",
    "**💸 송금**",
    `\`/송금 받는사람 금액\` — 다른 유저에게 해정 보내기. 은행 수수료 ${pctText(TRANSFER_FEE_RATE)}(최소 ${TRANSFER_FEE_MIN}해정)는 보내는 사람이 따로 내고, 받는 사람은 금액을 그대로 받아요`,
    "",
    "**💵 달러는?**",
    "예금·대출·상환·송금은 **해정만** 돼요. 달러는 `/환전`으로 바꿔서 써요 (이자는 없어요)",
    "연체돼도 달러와 외국자산은 자동 회수·강제 매도되지 않아요 (잔고 → 예금, 해정 주식 순서)",
    "",
    "`/은행` — 내 예금·대출·이자·한도를 지금 이 순간 기준으로 보기",
  ].join("\n");
}

const askCooldown = new Map(); // 유저ID -> 마지막 질문 시각 (서버 인스턴스 기준의 간단한 제한)
const ASK_COOLDOWN_MS = 10_000;
const ASK_DAILY_LIMIT = 15; // 유저 한 명이 하루(한국 시간 자정 기준)에 /주식질문을 쓸 수 있는 횟수. 여기 숫자만 바꾸면 돼요. (관리자는 제한 없음)

export const handlers = {
  // 도움말은 글자가 2000자를 넘어서 일반 메시지로는 못 보내요. 임베드(4096자까지)로 보내요.
  도움말: async () => ({ embeds: [{ description: helpText().slice(0, 4096), color: 0x5865f2 }] }),

  출석체크: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await checkAttendance(env, userId);
    return result.message;
  },

  채굴: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await mineOnce(env, userId);
    return result.message;
  },

  채굴정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    return getMiningInfo(env, userId);
  },

  채굴업그레이드: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await upgradeMining(env, userId);
    return result.message;
  },

  // 정렬: 이름순(기본) / 가격 오름·내림차순 / 변동순(직전 시세 대비 %). 같으면 이름순 유지.
  // 나만 보이는 응답이라 내가 보유한 종목만 ⭐로 표시
  주식목록: async (interaction, env) => {
    const stocks = await listStocks(env); // 이름순으로 이미 정렬돼 있음
    if (stocks.length === 0) return "등록된 종목이 없어요. 관리자가 `/종목추가`로 등록할 수 있어요.";

    // 직전 시세 대비 변동률(%) 계산 (기록이 2개 미만이면 0)
    for (const s of stocks) {
      const points = getPriceHistory(s);
      const prev = points.length >= 2 ? points[points.length - 2].p : s.price;
      s.changePct = prev > 0 ? ((s.price - prev) / prev) * 100 : 0;
    }

    const sort = String(opt(interaction, "정렬") ?? "name");
    const SORT_LABEL = {
      name: "이름순",
      price_asc: "가격 낮은순",
      price_desc: "가격 높은순",
      change_desc: "변동 큰순",
      change_asc: "변동 낮은순",
    };

    // sort는 안정 정렬이라 값이 같으면 이름순이 유지돼요.
    if (sort === "price_asc") stocks.sort((a, b) => a.price - b.price);
    else if (sort === "price_desc") stocks.sort((a, b) => b.price - a.price);
    else if (sort === "change_desc") stocks.sort((a, b) => b.changePct - a.changePct);
    else if (sort === "change_asc") stocks.sort((a, b) => a.changePct - b.changePct);

    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);

    return [
      `**📈 주식 목록 (${SORT_LABEL[sort] ?? "이름순"})** · ⭐ = 내가 보유 중`,
      ...stocks.map((s) => {
        const held = user.holdings[s.name] || 0;
        const mark = held > 0 ? `⭐ (보유 ${held}주) ` : "";
        const pct = s.changePct;
        const change =
          pct === 0
            ? "➖ 0.0%"
            : `${pct > 0 ? UP_MARK : DOWN_MARK} ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
        const sec = isForeign(s) ? "" : ` \`${sectorOf(s)}\``; // 업종 (외국자산은 업종이 없어요)
        return `${mark}**${iconName(s)}**${sec}${dangerTag(s.price)} — ${moneyOf(s, s.price)} (${change})${staleTag(s)}`;
      }),
    ].join("\n");
  },

  // 상장폐지된 종목 목록 (최신 폐지순) + 하락률. 종목을 고르면 폐지된 종목도 시세 그래프를 그려줘요.
  상장폐지종류: async (interaction, env) => {
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    const picks = [...new Set(slots.map((s) => s.name))];

    // ----- 종목 지정: 하락률 + 그래프 (여러 개면 임베드를 여러 장) -----
    const showOne = async (pick) => {
      const all = await listDelisted(env, 200);
      const d = all.find((x) => x.name === pick); // 최신 폐지순이라 가장 최근 기록이 잡혀요
      if (!d) return `"${pick}" 상장폐지 기록을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요.`;

      const points = getDelistedHistory(d);
      const prices = points.map((p) => p.p);
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      const imageUrl = await renderStockChart(points, false); // 폐지 종목이라 파란색(하락)

      return {
        embeds: [
          {
            title: `🚫 ${d.name} 상장폐지`,
            description: [
              `🗓️ 상장일: ${listedText(d.listedAt)}${
                Number.isFinite(d.listedAt)
                  ? ` · 생존 ${Math.max(0, Math.floor((d.delistedAt - d.listedAt) / 86400000))}일`
                  : ""
              }`,
              `폐지 시각: \`${formatKSTFull(d.delistedAt)}\` (한국시간)`,
              `${DOWN_MARK} 폐지된 변동: ${moneyOf(d, d.lastPrice || 0)} → ${moneyOf(d, d.finalPrice || 0)} (**-${moneyOf(d, (d.lastPrice || 0) - (d.finalPrice || 0))}, -${d.dropPct}%**)`,
              `📉 역대 최고가 ${moneyOf(d, d.maxPrice || 0)} 대비 **-${d.peakDropPct}%**`,
              `⬇️ 기록 중 한 번에 가장 많이 하락: **-${d.maxDropPct}%**`,
              `구간 최고 ${moneyOf(d, high)} / 최저 ${moneyOf(d, low)} · 폐지 당시 보유자 ${(d.holders || 0).toLocaleString()}명`,
            ].join("\n"),
            color: 0x1e88e5,
            image: { url: imageUrl },
            footer: {
              text:
                points.length > 2
                  ? `최근 ${points.length}개 기록 · ${formatKST(points[0].t)} ~ ${formatKST(points[points.length - 1].t)} (한국시간)`
                  : "예전에 폐지된 종목이라 시세 기록이 없어 폐지 직전 → 폐지 가격만 보여줘요",
            },
          },
        ],
      };
    };
    if (picks.length === 1) return showOne(picks[0]);
    if (picks.length > 1) return combineResults(await Promise.all(picks.map(showOne)));

    // ----- 목록 -----
    const requested = opt(interaction, "개수") ?? 10;
    const count = Math.min(Math.max(requested, 1), 20);

    const list = await listDelisted(env, count);
    if (list.length === 0) return "아직 상장폐지된 종목이 없어요.";

    const lines = list.map(
      (d) =>
        `🚫 **${d.name}** · \`${formatKSTFull(d.delistedAt)}\` · ${moneyOf(d, d.lastPrice || 0)} → ${moneyOf(d, d.finalPrice || 0)} (**-${moneyOf(d, (d.lastPrice || 0) - (d.finalPrice || 0))}, -${d.dropPct}%**) · 최고가 ${moneyOf(d, d.maxPrice || 0)} 대비 -${d.peakDropPct}% · 최대 하락 -${d.maxDropPct}%`
    );

    // 디스코드 메시지 한도(2000자) 보호
    let text = `**🪦 상장폐지된 종목 (${list.length}건, 최신순)**\n그래프는 \`/상장폐지종류 종목:이름\`으로 볼 수 있어요.`;
    for (const line of lines) {
      if (text.length + line.length + 1 > 1900) {
        text += "\n…(이하 생략 · `개수`를 줄여 보세요)";
        break;
      }
      text += `\n${line}`;
    }
    return text;
  },

  // 종목 시세 그래프 (QuickChart 이미지를 임베드로 보여줌)
  그래프: async (interaction, env) => {
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    if (!slots.length) return "종목을 골라 주세요.";
    const names = [...new Set(slots.map((s) => s.name))];
    return combineResults(await Promise.all(names.map((name) => stockChart(env, name))));
  },

  // 전체 유저의 보유 종목 (모두에게 보이는 무음 응답 — interactions.js의 SILENT_COMMANDS에 등록)
  // 닉네임이 저장돼 있으면 닉네임, 없으면 멘션으로 표시해요. (멘션은 알림이 가지 않아요)
  보유종목: async (_interaction, env) => {
    const list = await getAllHoldings(env);
    if (list.length === 0) return "보유 중인 종목이 있는 유저가 아직 없어요.";

    let text = `**📦 유저별 보유 종목 (${list.length}명, 평가액 높은 순)**`;
    let shown = 0;
    for (const u of list) {
      const who = u.username || `<@${u.id}>`;
      const domestic = u.holdings.filter((h) => !h.foreign);
      const foreign = u.holdings.filter((h) => h.foreign);
      const stocksText = domestic
        .map((h) => `${h.name}${dangerTag(h.price)} ${h.qty.toLocaleString()}주`)
        .join(", ");
      const foreignText = foreign
        .map((h) => `${h.icon} ${h.name}${dangerTag(h.price)} ${h.qty.toLocaleString()}주`)
        .join(", ");
      const parts = [stocksText, foreignText].filter(Boolean);
      const line = `• **${who}** — ${parts.join(" | ")}`.slice(0, 500);
      // 디스코드 메시지 한도(2000자) 보호
      if (text.length + line.length + 1 > 1900) {
        text += `\n…외 ${list.length - shown}명 생략`;
        break;
      }
      text += `\n${line}`;
      shown++;
    }
    return text;
  },

  잔고: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [user, stocks] = await Promise.all([getUser(env, userId), listStocks(env)]);
    const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
    const entries = Object.entries(user.holdings).sort(([a], [b]) => compareKo(a, b));
    const domestic = entries.filter(([name]) => !isForeign(stockMap[name]));
    const foreign = entries.filter(([name]) => isForeign(stockMap[name]));
    const line = ([name, qty]) => {
      const icon = foreignIcon(stockMap[name]);
      return `- ${icon ? `${icon} ` : ""}${name}: ${qty}주`;
    };
    const holdingsText =
      [
        domestic.length ? domestic.map(line).join("\n") : "",
        foreign.length ? `**🌐 외국자산**\n${foreign.map(line).join("\n")}` : "",
      ].filter(Boolean).join("\n") || "(보유 종목 없음)";
    return `잔고: **${user.balance.toLocaleString()}해정** · 달러: **${centsText(user.usd)}**\n${holdingsText}`;
  },

  // 보유 종목은 getUserDetail에서 이름순으로 정렬됨
  내정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const detail = await getUserDetail(env, userId);

    const holdingLine = (h) =>
      h.foreign
        ? `- ${h.icon ? `${h.icon} ` : ""}${h.name}${dangerTag(h.price)}: ${h.qty}주 (현재가 ${centsText(h.price)} · 평균 매수가 ${centsText(h.avg)} · 평가금 ${centsText(h.value)} ≈ ${h.valueKrw.toLocaleString()}해정)\n  ${profitUsdLabel(h.profit, h.cost)}`
        : `- ${h.icon ? `${h.icon} ` : ""}${h.name}${dangerTag(h.price)}: ${h.qty}주 (현재가 ${h.price.toLocaleString()} · 평균 매수가 ${h.avg.toLocaleString()} · 평가금 ${h.value.toLocaleString()}해정)\n  ${profitLabel(h.profit, h.cost)}`;
    const domesticHoldings = detail.holdings.filter((h) => !h.foreign);
    const foreignHoldings = detail.holdings.filter((h) => h.foreign);
    const holdingsText =
      [
        domesticHoldings.length ? domesticHoldings.map(holdingLine).join("\n") : "",
        foreignHoldings.length ? `**🌐 외국자산**\n${foreignHoldings.map(holdingLine).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "(보유 종목 없음)";

    const rankText = detail.rank > 0 ? `${detail.rank}위 / ${detail.totalUsers}명` : "(순위 없음)";

    let changeText = "📊 지난 조회 대비: 첫 조회예요. 다음 조회부터 증감이 표시돼요.";
    if (detail.assetChange !== null) {
      const mark =
        detail.assetChange > 0 ? `${UP_MARK} 증가` : detail.assetChange < 0 ? `${DOWN_MARK} 감소` : "➖ 변동 없음";
      changeText = `📊 지난 조회 대비 총자산: ${mark} ${fmtSigned(detail.assetChange)}해정 (${formatKST(detail.prevAssetAt)} 조회 시점: ${detail.prevAsset.toLocaleString()}해정)`;
    }

    return [
      "**내 상세정보**",
      `현금 잔고: ${detail.balance.toLocaleString()}해정`,
      `💵 달러 잔고: ${centsText(detail.usd)} (≈ ${detail.usdValue.toLocaleString()}해정 · ${rateText(detail.rate)})`,
      `보유 종목 평가액: ${detail.holdingsValue.toLocaleString()}해정 (외국자산은 현재 환율로 환산)`,
      ...(detail.extraAsset ? [`🏦 예금·선물 평가금 - 대출: ${detail.extraAsset.toLocaleString()}해정`] : []),
      `총 자산: ${detail.totalAsset.toLocaleString()}해정`,
      changeText,
      `보유 종목 평가손익: ${profitLabel(detail.holdingsProfit, detail.holdingsCost)}`,
      `누적 실현 손익(매도 확정분): ${fmtSigned(detail.realizedProfit)}해정`,
      `전체 순위: ${rankText}`,
      "",
      "보유 종목 (이름순):",
      holdingsText,
    ].join("\n");
  },

  // AI 봇 현황 (봇은 랭킹에 포함되지 않고 여기서만 요약으로 보여줘요)
  지수: async (_interaction, env) => marketIndexText(await listStocks(env)),
  관심추가: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "종목") ?? "").trim();
    const [stock, w] = await Promise.all([getStock(env, name), getWatch(env, userId)]);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요.`;
    if (w.stocks[name]) return `**${name}**은(는) 이미 관심종목이에요. \`/관심목록\`으로 확인해 보세요.`;
    const count = Object.keys(w.stocks).length;
    if (count >= MAX_WATCH_STOCKS) return `관심종목은 최대 ${MAX_WATCH_STOCKS}개까지 담을 수 있어요. \`/관심삭제\`로 정리한 뒤 다시 시도해 주세요.`;
    w.stocks[name] = Date.now();
    await saveWatch(env, userId, w);
    return [
      `⭐ **${name}**을(를) 관심종목에 담았어요. (${count + 1}/${MAX_WATCH_STOCKS}) · 현재가 ${moneyOf(stock, stock.price)}`,
      "원하는 가격에 DM을 받으려면 `/가격알림`을 써 보세요.",
    ].join("\n");
  },

  관심삭제: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "종목") ?? "").trim();
    const w = await getWatch(env, userId);
    if (name === "all") {
      const n = Object.keys(w.stocks).length;
      if (n === 0 && Object.keys(w.alerts).length === 0) return "관심종목이 비어 있어요.";
      await saveWatch(env, userId, { stocks: {}, alerts: {} });
      return `관심종목 ${n}개와 가격 알림을 모두 지웠어요.`;
    }
    if (!w.stocks[name]) return `**${name}**은(는) 관심종목이 아니에요. 칸을 눌러 목록에서 골라 주세요.`;
    delete w.stocks[name];
    let removedAlerts = 0;
    for (const [id, a] of Object.entries(w.alerts)) {
      if (a.stock === name) {
        delete w.alerts[id];
        removedAlerts++;
      }
    }
    await saveWatch(env, userId, w);
    return `**${name}**을(를) 관심종목에서 뺐어요.${removedAlerts ? ` (가격 알림 ${removedAlerts}개도 같이 지웠어요.)` : ""}`;
  },

  관심목록: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [w, stocks] = await Promise.all([getWatch(env, userId), listStocks(env)]);
    const names = Object.keys(w.stocks).sort((a, b) => w.stocks[a] - w.stocks[b]);
    const alerts = alertList(w.alerts);
    if (names.length === 0 && alerts.length === 0) {
      return "관심종목이 없어요. `/관심추가`로 담거나 `/가격알림`으로 알림을 걸어 보세요.";
    }

    const byName = Object.fromEntries(stocks.map((s) => [s.name, s]));
    const now = Date.now();
    const dayStart = Math.floor((now + IDX_KST_MS) / IDX_DAY_MS) * IDX_DAY_MS - IDX_KST_MS;
    const lines = [`**⭐ 내 관심종목 (${names.length}/${MAX_WATCH_STOCKS}개)**`];
    for (const n of names) {
      const s = byName[n];
      if (!s) {
        lines.push(`- ${n} · 상장폐지`);
        continue;
      }
      const pts = getPriceHistory(s);
      const open = pts.length ? priceAtTime(pts, dayStart) : s.price;
      const pct = open > 0 ? ((s.price - open) / open) * 100 : 0;
      const mark = pct > 0 ? UP_MARK : pct < 0 ? DOWN_MARK : "➖";
      lines.push(`- **${iconName(s)}**${dangerTag(s.price)} ${moneyOf(s, s.price)} ${mark} 오늘 ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%${staleTag(s)}`);
    }
    if (alerts.length) {
      lines.push("", `**🔔 가격 알림 (${alerts.length}/${MAX_PRICE_ALERTS}개)**`);
      for (const a of alerts) {
        const s = byName[a.stock];
        const left = s && s.price > 0 ? ` · 현재가 ${moneyOf(s, s.price)} (목표까지 ${(((a.price - s.price) / s.price) * 100).toFixed(1)}%)` : " · 상장폐지";
        lines.push(`- \`${a.id}\` ${alertText(a, s)}${left}`);
      }
    }
    return lines.join("\n");
  },

  가격알림: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "종목") ?? "").trim();
    const price = opt(interaction, "가격");
    if (!Number.isSafeInteger(price) || price < 1) return "가격은 1 이상의 정수여야 해요.";

    const [stock, w] = await Promise.all([getStock(env, name), getWatch(env, userId)]);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요.`;
    if (price === stock.price) return `현재가(${moneyOf(stock, stock.price)})와 같은 가격이에요. 다른 가격으로 걸어 주세요.`;

    const dir = price > stock.price ? "up" : "down";
    if (Object.keys(w.alerts).length >= MAX_PRICE_ALERTS) {
      return `가격 알림은 최대 ${MAX_PRICE_ALERTS}개까지 걸 수 있어요. \`/알림취소\`로 정리한 뒤 다시 시도해 주세요.`;
    }
    if (Object.values(w.alerts).some((a) => a.stock === name && a.price === price && a.dir === dir)) {
      return "같은 알림이 이미 걸려 있어요. `/관심목록`으로 확인해 보세요.";
    }

    const id = newOrderId(w.alerts);
    w.alerts[id] = { stock: name, price, dir, at: Date.now() };
    const added = !w.stocks[name] && Object.keys(w.stocks).length < MAX_WATCH_STOCKS;
    if (added) w.stocks[name] = Date.now();
    await saveWatch(env, userId, w);

    const gap = ((price - stock.price) / stock.price) * 100;
    return [
      `🔔 알림을 걸었어요. \`${id}\``,
      alertText(w.alerts[id], stock),
      `현재가 ${moneyOf(stock, stock.price)} (목표까지 ${gap > 0 ? "+" : ""}${gap.toFixed(1)}%)${added ? " · 관심종목에도 담았어요." : ""}`,
      "시세가 변동될 때(평소 변동, 급등락)마다 확인하고, 도달하면 DM으로 한 번 알려드려요. DM을 받을 수 있게 서버 개인 메시지 허용을 켜 두세요.",
    ].join("\n");
  },

  알림취소: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const target = String(opt(interaction, "알림") ?? "").trim();
    const w = await getWatch(env, userId);
    const ids = target === "all" ? Object.keys(w.alerts) : w.alerts[target] ? [target] : [];
    if (ids.length === 0) return "해당 알림을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요.";
    const removed = ids.map((id) => ({ id, ...w.alerts[id] }));
    for (const id of ids) delete w.alerts[id];
    await saveWatch(env, userId, w);
    const stockMap = Object.fromEntries((await listStocksForAutocomplete(env)).map((s) => [s.name, s]));
    return [`**가격 알림 ${removed.length}건을 취소했어요.**`, ...removed.map((a) => `- \`${a.id}\` ${alertText(a, stockMap[a.stock])}`)].join("\n");
  },

  종목정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "종목") ?? "").trim();
    const [stock, user, newsDoc] = await Promise.all([getStock(env, name), getUser(env, userId), getDoc(env, NEWS_PATH).catch(() => null)]);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요. (상장폐지된 종목은 \`/상장폐지종류\`에서 볼 수 있어요)`;
    const market = stock.kind === "us" ? await getUsMarketStatus(env) : null;
    return stockInfoText(stock, user.holdings[name] || 0, (newsDoc?.divMods || {})[name] ?? 1, Date.now(), market);
  },
  봇현황: async (_interaction, env) => getCrowdStats(env),

  랭킹: async (_interaction, env) => {
    const ranking = await getRanking(env);
    if (ranking.length === 0) return "아직 랭킹 데이터가 없어요.";
    return ranking
      .slice(0, 10)
      .map((r, i) => `${i + 1}위 — <@${r.id}> (${r.total.toLocaleString()}해정)`)
      .join("\n");
  },

  내역: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const requested = opt(interaction, "개수") ?? 10;
    const count = Math.min(Math.max(requested, 1), 30);

    const list = await getHistory(env, userId, count);
    if (list.length === 0) {
      return "아직 기록이 없어요. 매수·매도·구입·출석체크를 하면 여기에 남아요.";
    }

    const lines = list.map((h) => `\`${formatKST(h.t)}\` ${h.text}`);
    return [`**📜 내 최근 기록 (${list.length}건, 최신순)**`, ...lines].join("\n");
  },

  // 종목 1개면 예전과 똑같이, 2개 이상이면 한 번에 계산해서 전부 성공할 때만 체결해요.
  매수: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    if (!slots.length) return "종목을 골라 주세요.";
    const { items, merged, error: mergeError } = mergeSlots(slots);
    if (mergeError) return mergeError;
    const note = merged ? "ℹ️ 같은 종목은 수량을 합쳤어요.\n" : "";
    const result = items.length === 1 ? await buyStock(env, userId, items[0].name, items[0].qty) : await buyStocks(env, userId, items);
    return { message: note + result.message, amount: result.ok ? result.amount : undefined };
  },

  매도: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    if (!slots.length) return "종목을 골라 주세요.";
    const { items, merged, error: mergeError } = mergeSlots(slots);
    if (mergeError) return mergeError;
    const note = merged ? "ℹ️ 같은 종목은 수량을 합쳤어요.\n" : "";
    const result = items.length === 1 ? await sellStock(env, userId, items[0].name, items[0].qty) : await sellStocks(env, userId, items);
    return { message: note + result.message, amount: result.ok ? result.amount : undefined };
  },

  예약매수: (interaction, env) => reserveOrder("buy", interaction, env),
  예약매도: (interaction, env) => reserveOrder("sell", interaction, env),

  자동매도: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "종목") ?? "").trim();
    const stopPct = opt(interaction, "손절");
    const takePct = opt(interaction, "익절");
    const hasStop = stopPct !== undefined && stopPct !== null;
    const hasTake = takePct !== undefined && takePct !== null;

    if (!hasStop && !hasTake) return "손절(%) 또는 익절(%) 중 하나는 꼭 입력해 주세요. 예: 손절 20, 익절 30";
    if (hasStop && (!Number.isSafeInteger(stopPct) || stopPct < 1 || stopPct > 99)) return "손절은 1~99 사이의 정수(%)여야 해요.";
    if (hasTake && (!Number.isSafeInteger(takePct) || takePct < 1 || takePct > 1000)) return "익절은 1~1000 사이의 정수(%)여야 해요.";

    const [stock, user, items] = await Promise.all([getStock(env, name), getUser(env, userId), getOrderItems(env, userId)]);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요.`;

    const held = user.holdings[name] || 0;
    if (held < 1) return `${name} 종목을 가지고 있지 않아요. 보유한 종목만 손절/익절을 걸 수 있어요.`;

    const qtyInput = opt(interaction, "수량");
    const qty = qtyInput === undefined || qtyInput === null ? held : qtyInput;
    if (!Number.isSafeInteger(qty) || qty < 1) return "수량은 1 이상의 정수여야 해요.";

    const already = reservedSellQty(items)[name] || 0;
    if (held - already < qty) {
      return `걸 수 있는 보유 수량이 부족해요. (보유 ${held.toLocaleString()}주 · 이미 매도 예약 ${already.toLocaleString()}주)`;
    }

    const need = (hasStop ? 1 : 0) + (hasTake ? 1 : 0);
    const current = Object.keys(items).length;
    if (current + need > MAX_ORDERS_PER_USER) {
      return `예약은 최대 ${MAX_ORDERS_PER_USER}개까지 걸 수 있어요. (지금 ${current}개 + 이번 ${need}개) \`/예약취소\`로 정리한 뒤 다시 시도해 주세요.`;
    }

    // 기준은 내 평균 매수가
    const avg = Math.round(costOf(user, name, stock.price) / held);
    const stopPrice = hasStop ? Math.max(1, Math.round(avg * (1 - stopPct / 100))) : null;
    const takePrice = hasTake ? Math.round(avg * (1 + takePct / 100)) : null;

    const errors = [];
    if (hasStop && stock.price <= stopPrice) {
      errors.push(`현재가(${moneyOf(stock, stock.price)})가 이미 손절가(${moneyOf(stock, stopPrice)}) 이하예요. 바로 \`/매도\`를 쓰거나 손절 %를 줄여 주세요.`);
    }
    if (hasTake && stock.price >= takePrice) {
      errors.push(`현재가(${moneyOf(stock, stock.price)})가 이미 익절가(${moneyOf(stock, takePrice)}) 이상이에요. 바로 \`/매도\`를 쓰거나 익절 %를 높여 주세요.`);
    }
    if (errors.length) return errors.join("\n");

    const next = { ...items };
    const link = newOrderId(next);
    const made = [];
    const base = Date.now();
    if (hasStop) {
      const id = newOrderId(next);
      next[id] = { stock: name, side: "sell", dir: "down", kind: "손절", link, qty, price: stopPrice, at: base };
      made.push({ id, order: next[id], pct: `-${stopPct}%` });
    }
    if (hasTake) {
      const id = newOrderId(next);
      next[id] = { stock: name, side: "sell", kind: "익절", link, qty, price: takePrice, at: base + 1 };
      made.push({ id, order: next[id], pct: `+${takePct}%` });
    }
    await saveOrderItems(env, userId, next);

    return [
      `🛡️ **${name}** ${qty.toLocaleString()}주에 자동 매도를 걸었어요.`,
      `평균 매수가 ${moneyOf(stock, avg)} · 현재가 ${moneyOf(stock, stock.price)}`,
      ...made.map((m) => `- \`${m.id}\` ${orderText(m.order, stock)} (평균 매수가 ${m.pct})`),
      made.length > 1 ? "둘 중 하나가 체결되면 나머지는 자동으로 취소돼요." : "",
      "시세가 변동될 때(평소 변동, 급등락)마다 확인하고, 체결되면 DM으로 알려드려요. 체결가는 그때의 현재가라서, 급락하면 손절가보다 더 낮게 팔릴 수 있어요.",
    ].filter(Boolean).join("\n");
  },

  예약목록: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [orders, stocks] = await Promise.all([getOrders(env, userId), listStocks(env)]);
    if (orders.length === 0) {
      return "걸어둔 예약이 없어요. `/예약매수`, `/예약매도`로 가격을 정해 예약해 보세요.";
    }
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
    const orderLine = (o) => {
      const now = priceMap[o.stock];
      const nowText = now === undefined ? "상장폐지" : `현재가 ${moneyOf(stockMap[o.stock], now)}`;
      return `\`${o.id}\` ${orderText(o, stockMap[o.stock])} · ${nowText}`;
    };
    const domesticOrders = orders.filter((o) => !isForeign(stockMap[o.stock]));
    const foreignOrders = orders.filter((o) => isForeign(stockMap[o.stock]));
    return [
      `**⏰ 내 예약 (${orders.length}/${MAX_ORDERS_PER_USER}개)**`,
      ...domesticOrders.map(orderLine),
      ...(foreignOrders.length ? ["", "**🌐 외국자산**", ...foreignOrders.map(orderLine)] : []),
    ].join("\n");
  },

  예약취소: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "예약");
    if (error) return error;
    const targets = slots.map((s) => s.name);
    if (!targets.length) return "취소할 예약을 골라 주세요.";
    const { removed, missing } = await cancelOrders(env, userId, targets);
    if (removed.length === 0) return "해당 예약을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요.";
    const stockMap = Object.fromEntries((await listStocksForAutocomplete(env)).map((s) => [s.name, s]));
    return [
      `**예약 ${removed.length}건을 취소했어요.**`,
      ...removed.map((o) => `- \`${o.id}\` ${orderText(o, stockMap[o.stock])}`),
      ...(missing.length ? [`(찾지 못한 예약: ${missing.map((m) => `\`${m}\``).join(", ")})`] : []),
    ].join("\n");
  },

  선물: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await openFuture(env, userId, {
      stock: String(opt(interaction, "종목") ?? "").trim(),
      side: opt(interaction, "방향"),
      margin: opt(interaction, "증거금"),
      lev: opt(interaction, "배율"),
    });
    return { message: result.message, amount: result.ok ? result.amount : undefined };
  },

  선물목록: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [items, stocks] = await Promise.all([getFutureItems(env, userId), listStocks(env)]);
    const list = futureList(items);
    if (list.length === 0) return "열어둔 선물이 없어요. `/선물`로 시작하거나 `/선물설명`을 읽어 보세요.";
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    const stockMap = Object.fromEntries(stocks.map((s) => [s.name, s]));
    const futureLine = (f) => {
      const price = priceMap[f.stock];
      if (price === undefined) return `\`${f.id}\` ${futureText(f)}\n  상장폐지`;
      const equity = futureEquity(f, price);
      const isUsd = f.cur === "usd";
      const m = (n) => (isUsd ? centsText(n) : `${n.toLocaleString()}해정`);
      return [
        `\`${f.id}\` ${futureText(f)}`,
        `  현재가 ${m(price)} · 평가금 ${m(equity)} · ${isUsd ? profitUsdLabel(equity - f.margin, f.margin) : profitLabel(equity - f.margin, f.margin)}`,
        `  💥 강제청산가 ${m(futureLiqPrice(f))} ${f.side === "long" ? "이하" : "이상"}`,
      ].join("\n");
    };
    const domesticFutures = list.filter((f) => !isForeign(stockMap[f.stock]));
    const foreignFutures = list.filter((f) => isForeign(stockMap[f.stock]));
    return [
      `**📊 내 선물 (${list.length}/${MAX_FUTURES_PER_USER}개)**`,
      ...domesticFutures.map(futureLine),
      ...(foreignFutures.length ? ["", "**🌐 외국자산**", ...foreignFutures.map(futureLine)] : []),
    ].join("\n");
  },

  선물청산: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "포지션");
    if (error) return error;
    const targets = slots.map((s) => s.name);
    if (!targets.length) return "정산할 포지션을 골라 주세요.";
    const result = await closeFutures(env, userId, targets);
    return { message: result.message, amount: result.ok ? result.amount : undefined };
  },

  선물설명: async () => futuresHelpText(),

  환율: async (interaction, env) => fxInfoText(env, interaction.member.user.id),

  환전: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await exchangeMoney(env, userId, opt(interaction, "방향"), opt(interaction, "금액"));
    return result.message;
  },

  은행: async (interaction, env) => bankStatus(env, interaction.member.user.id),

  배당: async (interaction, env) => dividendInfo(env, interaction.member.user.id),

  공시: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    return (await postManualNews(env, String(opt(interaction, "종목") ?? "").trim(), opt(interaction, "내용"), opt(interaction, "성격"))).message;
  },

  공시설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const perDay = opt(interaction, "하루횟수");
    const enabled = opt(interaction, "활성화");
    const cfg = await setNewsConfig(env, { enabled, perDay });
    return [
      "**공시 설정을 저장했어요.**",
      `- 자동 공시: ${cfg.enabled ? "✅ 켜짐" : "❌ 꺼짐"}`,
      `- 하루 평균: ${cfg.perDay}건 (실제로는 ${Math.max(1, cfg.perDay - 1)}~${cfg.perDay}건)`,
      `- 다음 변동을 기다리는 공시: ${cfg.queued}건`,
    ].join("\n");
  },

  공시목록: async (_interaction, env) => newsListText(env),

  주식질문: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const now = Date.now();
    const wait = (askCooldown.get(userId) || 0) + ASK_COOLDOWN_MS - now;
    if (wait > 0) return `질문은 ${Math.ceil(wait / 1000)}초 뒤에 다시 할 수 있어요.`;
    askCooldown.set(userId, now);
    if (askCooldown.size > 2000) askCooldown.clear();
    const question = String(opt(interaction, "질문") ?? "").trim();
    if (!question) return "질문을 입력해 주세요.";

    // 하루 질문 횟수: askQuota/{유저ID} 문서에 { day, n } 으로 저장해요. (날짜가 바뀌면 자동으로 0부터)
    const unlimited = isAdmin(interaction, env);
    const day = todayKST();
    const path = `askQuota/${userId}`;
    let used = 0;
    if (!unlimited) {
      const saved = await getDoc(env, path);
      used = saved?.day === day ? Number(saved.n) || 0 : 0;
      if (used >= ASK_DAILY_LIMIT) return `오늘 질문 횟수(${ASK_DAILY_LIMIT}번)를 다 썼어요. 내일 0시(한국 시간)에 다시 물어볼 수 있어요.`;
      await setDoc(env, path, { day, n: used + 1 }); // 먼저 차감해서 연타로 한도를 넘기지 못하게 해요
    }
    try {
      const answer = (await askGuide(question)).slice(0, 1800);
      return unlimited ? answer : `${answer}\n-# 오늘 남은 질문 ${ASK_DAILY_LIMIT - used - 1}/${ASK_DAILY_LIMIT}번`;
    } catch (err) {
      // AI 쪽 오류면 차감한 횟수를 돌려줘요
      if (!unlimited) await setDoc(env, path, { day, n: used }).catch(() => {});
      return err.message; // askGuide가 사용자에게 보여줄 문장으로 던져요
    }
  },

  은행설명: async (interaction, env) => ({ embeds: [{ description: bankHelpText(await getBankRate(env)).slice(0, 4096), color: 0x5865f2 }] }),

  예금: async (interaction, env) => (await depositMoney(env, interaction.member.user.id, opt(interaction, "금액"))).message,

  출금: async (interaction, env) => (await withdrawMoney(env, interaction.member.user.id, opt(interaction, "금액"))).message,

  송금: async (interaction, env) => {
    const toId = opt(interaction, "받는사람");
    const toIsBot = !!interaction.data.resolved?.users?.[toId]?.bot;
    return (await transferMoney(env, interaction.member.user.id, toId, opt(interaction, "금액"), { toIsBot })).message;
  },

  보험: async (interaction, env) => insuranceInfo(env, interaction.member.user.id),

  보험가입: async (interaction, env) =>
    (await buyInsurance(env, interaction.member.user.id, opt(interaction, "종목"), opt(interaction, "수량"), opt(interaction, "기간"))).message,

  보험해지: async (interaction, env) =>
    (await cancelInsurance(env, interaction.member.user.id, opt(interaction, "종목"))).message,

  대출: async (interaction, env) =>
    (await takeLoan(env, interaction.member.user.id, opt(interaction, "금액"), opt(interaction, "기간"))).message,

  상환: async (interaction, env) =>
    (await repayLoans(env, interaction.member.user.id, String(opt(interaction, "대출") ?? "").trim(), opt(interaction, "금액"))).message,

  // 가격 낮은 순 (listProducts가 정렬해서 줌)
  // 모두에게 보이는 무음 응답 (interactions.js의 SILENT_COMMANDS에 "주식상점" 등록)
  주식상점: async (_interaction, env) => {
    const products = await listProducts(env);
    if (products.length === 0) return "판매 중인 상품이 없어요.";
    return [
      "**🛒 주식상점 (가격 낮은 순)**",
      ...products.map(
        (p) => `**${p.name}** — ${p.price.toLocaleString()}해정${p.description ? `\n> ${p.description}` : ""}`
      ),
    ].join("\n");
  },

  구입: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "상품");
    if (error) return error;
    if (!slots.length) return "상품을 골라 주세요.";
    const { items, merged, error: mergeError } = mergeSlots(slots);
    if (mergeError) return mergeError;
    const note = merged ? "ℹ️ 같은 상품은 수량을 합쳤어요.\n" : "";
    if (items.length === 1) return note + (await buyProduct(env, userId, items[0].name, items[0].qty)).message;
    return note + (await buyProducts(env, userId, items)).message;
  },

  보유상품: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const entries = Object.entries(user.items).sort(([a], [b]) => compareKo(a, b));
    if (entries.length === 0) return "보유한 상품이 없어요. `/주식상점`에서 구경해 보세요.";
    return entries.map(([name, count]) => `- ${name} x${count}`).join("\n");
  },

  알림설정: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const current = user.notify || { all: false, up: false, down: false };

    // 시작/종료는 0~23 정수만 허용 (자동완성은 예시일 뿐 직접 입력도 가능하므로 검사)
    const rawStart = opt(interaction, "시작");
    const rawEnd = opt(interaction, "종료");
    for (const v of [rawStart, rawEnd]) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 23)) {
        return "시작/종료는 0~23 사이의 정수로 입력해 주세요.";
      }
    }

    const next = {
      all: opt(interaction, "전체") ?? current.all,
      up: opt(interaction, "상승") ?? current.up,
      down: opt(interaction, "하락") ?? current.down,
    };

    // 알림 시간대: 안 넘긴 값은 기존 설정을 유지
    const start = rawStart ?? current.start;
    const end = rawEnd ?? current.end;
    if (Number.isInteger(start)) next.start = start;
    if (Number.isInteger(end)) next.end = end;

    if (Number.isInteger(next.start) !== Number.isInteger(next.end)) {
      return "알림 시간대는 `시작`과 `종료`를 함께 입력해 주세요. (예: 시작 9, 종료 22)";
    }

    await setNotify(env, userId, next);
    return notifyStatusText(next, "알림 설정을 저장했어요.");
  },

  알림확인: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    return notifyStatusText(user.notify || { all: false, up: false, down: false }, "현재 알림 설정");
  },

  // 아래 관리자 명령은 종목2~5까지 여러 개를 한 번에 처리해요. 하나라도 잘못되면 아무것도 바꾸지 않아요.
  종목추가: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const { slots, error } = readSlots(interaction, "종목", { price: true });
    if (error) return error;
    if (!slots.length) return "종목 이름을 입력해 주세요.";
    for (const s of slots) {
      if (!Number.isSafeInteger(s.price) || s.price < 1) return `${slotLabel(s.n)}가격은 1 이상의 정수여야 해요.`;
    }
    const dup = slots.find((s, i) => slots.findIndex((x) => x.name === s.name) !== i);
    if (dup) return `같은 종목이 두 번 들어 있어요: "${dup.name}"`;

    const sectorOpt = opt(interaction, "업종"); // 없으면 새 종목에 랜덤 배정 (upsertStock이 처리)
    const tierOpt = opt(interaction, "등급");
    const extra = {
      ...(sectorOpt && (SECTORS.includes(sectorOpt) || sectorOpt === NO_SECTOR) ? { sector: sectorOpt } : {}),
      ...(VOL_TIERS.includes(tierOpt) ? { volTier: tierOpt } : {}),
    };
    await Promise.all(slots.map((s) => upsertStock(env, s.name, s.price, undefined, extra)));
    const secText = extra.sector || extra.volTier ? ` (${[extra.sector && `업종 ${extra.sector}`, extra.volTier && `등급 ${extra.volTier}`].filter(Boolean).join(", ")})` : "";
    if (slots.length === 1) return `"${slots[0].name}" 종목을 ${slots[0].price.toLocaleString()}해정에 등록했어요.${secText}`;
    return [`${slots.length}개 종목을 등록했어요.${secText}`, ...slots.map((s) => `- "${s.name}" ${s.price.toLocaleString()}해정`)].join("\n");
  },

  종목삭제: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    if (!slots.length) return "삭제할 종목을 골라 주세요.";
    const names = [...new Set(slots.map((s) => s.name))];

    if (names.length === 1) {
      await removeStock(env, names[0]);
      await ensureMinimumStocks(env); // 종목 수가 기준 이하면 자동 상장
      return `"${names[0]}" 종목을 삭제했어요.`;
    }

    // 여러 개: 없는 종목은 빼고 알려줘요
    const found = await Promise.all(names.map((n) => getStock(env, n)));
    const exist = names.filter((_, i) => found[i]);
    const missing = names.filter((_, i) => !found[i]);
    await Promise.all(exist.map((n) => removeStock(env, n)));
    if (exist.length) await ensureMinimumStocks(env); // 마지막에 한 번만 확인
    return [
      exist.length ? `${exist.length}개 종목을 삭제했어요: ${exist.map((n) => `"${n}"`).join(", ")}` : "삭제된 종목이 없어요.",
      ...(missing.length ? [`(찾지 못한 종목: ${missing.map((n) => `"${n}"`).join(", ")})`] : []),
    ].join("\n");
  },

  // 유저 종목 생성: 이름만 정하고 가격은 LISTING_PRICE 고정, 하루 dailyLimit회 (무료)
  // 이름2~5로 여러 개를 만들면 개수만큼 횟수를 써요. 남은 횟수보다 많이 요청하면 아무것도 만들지 않아요.
  // 디스코드는 3초 안에 응답이 없으면 "응답하지 않았다"고 표시해서, Firestore 호출을 최대한 묶어서 처리해요.
  종목생성: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "이름");
    if (error) return error;
    if (!slots.length) return "종목 이름은 1~12자로 입력해 주세요.";
    const names = slots.map((s) => s.name);
    if (names.some((n) => n.length > 12)) return "종목 이름은 1~12자로 입력해 주세요.";
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return `같은 이름이 두 번 들어 있어요: "${dup}"`;

    // 설정 / 유저 / 같은 이름 종목 확인을 동시에 조회
    const [cfg, user, ...exists] = await Promise.all([
      getListingConfig(env),
      getUser(env, userId),
      ...names.map((n) => getStock(env, n)),
    ]);

    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const used = user.listingDay === today ? user.listingCount || 0 : 0;
    const remaining = Math.max(0, cfg.dailyLimit - used);
    if (remaining === 0) {
      return `오늘은 종목 생성을 ${cfg.dailyLimit}회 모두 썼어요. 내일 다시 시도해 주세요.`;
    }
    if (names.length > remaining) {
      return `오늘 남은 생성 횟수는 ${remaining}회인데 ${names.length}개를 요청했어요. (오늘 ${used}/${cfg.dailyLimit}회 사용)\n아무것도 상장하지 않았어요.`;
    }
    const taken = names.filter((_, i) => exists[i]);
    if (taken.length) {
      return taken.length === 1 && names.length === 1
        ? `"${taken[0]}" 종목이 이미 있어요. 다른 이름을 골라 주세요.`
        : `이미 있는 종목이 있어요: ${taken.map((n) => `"${n}"`).join(", ")}\n다른 이름을 골라 주세요. (아무것도 상장하지 않았어요.)`;
    }

    const newUsed = used + names.length;

    // 상장 / 횟수 저장 / 기록을 동시에 처리 (upsertStock에 {}를 넘겨 이미 없는 걸 아니까 다시 읽지 않게 함)
    await Promise.all([
      ...names.map((n) => upsertStock(env, n, LISTING_PRICE, {})),
      // 유저 문서 전체가 아니라 바뀐 두 필드만 저장 (쓰기 용량↓, 다른 필드 덮어쓰기 위험↓)
      setDoc(env, `users/${userId}`, { listingDay: today, listingCount: newUsed }),
      addHistory(env, userId, `종목 생성: ${names.join(", ")} (${LISTING_PRICE.toLocaleString()}해정 상장)`),
    ]);

    if (names.length === 1) {
      return `"${names[0]}" 종목을 ${LISTING_PRICE.toLocaleString()}해정에 상장했어요. (오늘 ${newUsed}/${cfg.dailyLimit}회)`;
    }
    return `${names.length}개 종목을 ${LISTING_PRICE.toLocaleString()}해정에 상장했어요: ${names.map((n) => `"${n}"`).join(", ")} (오늘 ${newUsed}/${cfg.dailyLimit}회)`;
  },

  시세설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const { slots, error } = readSlots(interaction, "종목", { price: true });
    if (error) return error;
    if (!slots.length) return "종목을 골라 주세요.";
    for (const s of slots) {
      if (!Number.isSafeInteger(s.price) || s.price < 1) return `${slotLabel(s.n)}가격은 1 이상의 정수여야 해요.`;
    }
    const dup = slots.find((s, i) => slots.findIndex((x) => x.name === s.name) !== i);
    if (dup) return `같은 종목이 두 번 들어 있어요: "${dup.name}"`;

    await Promise.all(slots.map((s) => upsertStock(env, s.name, s.price)));
    if (slots.length === 1) return `"${slots[0].name}" 가격을 ${slots[0].price.toLocaleString()}해정으로 변경했어요.`;
    return [`${slots.length}개 종목 가격을 변경했어요.`, ...slots.map((s) => `- "${s.name}" → ${s.price.toLocaleString()}해정`)].join("\n");
  },

  체력회복: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const { refilled } = await refillAllStamina(env);
    return `🔋 채굴 기록이 있는 유저 ${refilled.toLocaleString()}명의 체력을 가득 채웠어요.`;
  },

  출석설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";

    const reward = opt(interaction, "보상");
    const enabled = opt(interaction, "활성화");

    if (reward !== undefined && (!Number.isInteger(reward) || reward < 0)) {
      return "보상은 0 이상의 정수여야 해요.";
    }

    const next = await setAttendanceConfig(env, { enabled, reward });
    return [
      "**출석 설정을 저장했어요.**",
      `- 상태: ${next.enabled ? "✅ 켜짐" : "❌ 꺼짐"}`,
      `- 보상: ${next.reward.toLocaleString()}해정`,
    ].join("\n");
  },
};