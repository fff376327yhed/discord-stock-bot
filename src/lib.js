// 통합 라이브러리: env / firebase / listing / economy / actionlog / attendance / mining / chart / crowd / notify / orders / commands
// (예전 src/*.js 12개를 한 파일로 합쳤어요. 파일 안 순서는 의존 순서예요.)

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
    listedAt: Date.now(),
    history: { [String(Date.now()).padStart(13, "0")]: price },
    updatedAt: new Date(),
  });
}

// 종목 수가 triggerCount 이하면 names 목록에서 addCount개를 자동 상장
// 반환: { added: [상장된 이름들] }
export async function ensureMinimumStocks(env) {
  const cfg = await getListingConfig(env);
  const stocks = await listCollection(env, "stocks");
  if (stocks.length > cfg.triggerCount) return { added: [] };

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

  // 처음 만들어지는 종목일 때만 상장일(listedAt)을 기록 (기존 종목의 상장일은 건드리지 않음)
  const isNew = !Number.isFinite(base.price);

  await setDoc(env, `stocks/${encodeURIComponent(name)}`, {
    name,
    price,
    maxPrice,
    history,
    updatedAt: new Date(),
    ...(isNew ? { listedAt: Date.now() } : {}),
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

  const rows = items.map((it, i) => ({ name: it.name, qty: it.qty, price: stocks[i].price, cost: stocks[i].price * it.qty }));
  const total = rows.reduce((sum, r) => sum + r.cost, 0);
  if (!Number.isSafeInteger(total)) return { ok: false, message: "금액이 너무 커서 처리할 수 없어요. 수량을 줄여 주세요." };
  if (user.balance < total) {
    return {
      ok: false,
      message: [
        `잔고가 부족해요. (합계 필요: ${fmt(total)}해정, 보유: ${fmt(user.balance)}해정, 부족: ${fmt(total - user.balance)}해정)`,
        ...rows.map((r) => `- ${r.name} ${fmt(r.qty)}주 × ${fmt(r.price)} = ${fmt(r.cost)}해정`),
        "(아무것도 매수하지 않았어요.)",
      ].join("\n"),
    };
  }

  const balanceBefore = user.balance;
  const lines = rows.map((r) => {
    const prevCost = costOf(user, r.name, r.price); // 수량을 늘리기 전에 기존 원가를 먼저 구함
    user.holdings[r.name] = (user.holdings[r.name] || 0) + r.qty;
    user.costs[r.name] = prevCost + r.cost;
    const avg = Math.round(user.costs[r.name] / user.holdings[r.name]);
    return `- ${r.name} ${fmt(r.qty)}주 (-${fmt(r.cost)}해정) · 평균 매수가 ${fmt(avg)}해정 (보유 ${fmt(user.holdings[r.name])}주)`;
  });
  user.balance -= total;

  const summary = `${rows.length}종목 매수 완료 (-${fmt(total)}해정)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `매수: ${rows.map((r) => `${r.name} ${fmt(r.qty)}주`).join(", ")} (-${fmt(total)}해정) → 잔고 ${fmt(user.balance)}해정`),
  ]);
  return { ok: true, message: [summary, ...lines, balanceLine(balanceBefore, user.balance)].join("\n"), user };
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

  const balanceBefore = user.balance;
  let totalEarned = 0;
  let totalProfit = 0;
  let totalBasis = 0;
  const lines = items.map((it, i) => {
    const price = stocks[i].price;
    const held = user.holdings[it.name];
    const prevCost = costOf(user, it.name, price);
    const basis = Math.round((prevCost * it.qty) / held);
    const earned = price * it.qty;
    const profit = earned - basis;

    user.holdings[it.name] = held - it.qty;
    if (user.holdings[it.name] === 0) {
      delete user.holdings[it.name];
      delete user.costs[it.name];
    } else {
      user.costs[it.name] = prevCost - basis;
    }
    totalEarned += earned;
    totalProfit += profit;
    totalBasis += basis;
    return `- ${it.name} ${fmt(it.qty)}주 (+${fmt(earned)}해정) · ${profitLabel(profit, basis)}`;
  });
  user.balance += totalEarned;
  user.realizedProfit = (user.realizedProfit || 0) + totalProfit;

  const summary = `${items.length}종목 매도 완료 (+${fmt(totalEarned)}해정)`;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      `매도: ${items.map((it) => `${it.name} ${fmt(it.qty)}주`).join(", ")} (+${fmt(totalEarned)}해정) · ${profitLabel(totalProfit, totalBasis)} → 잔고 ${fmt(user.balance)}해정`
    ),
  ]);
  return {
    ok: true,
    message: [summary, ...lines, balanceLine(balanceBefore, user.balance), `📊 이번 매도 손익 합계: ${profitLabel(totalProfit, totalBasis)}`].join("\n"),
    user,
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
  const [users, stocks] = await Promise.all([
    listCollection(env, "users"),
    listCollection(env, "stocks"),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const extras = await extraAssets(env, priceMap); // 예금 + 선물 평가금 - 대출

  return users
    .map((u) => {
      const holdingsValue = Object.entries(u.holdings || {}).reduce(
        (sum, [name, qty]) => sum + (priceMap[name] || 0) * qty,
        0
      );
      return { id: u.id, total: (u.balance || 0) + holdingsValue + (extras[u.id] || 0) };
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
  const extraAsset = await userExtraAsset(env, userId, priceMap); // 예금 + 선물 평가금 - 대출

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
  const totalAsset = user.balance + holdingsValue + extraAsset;
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
  const { lastPrice, finalPrice, maxPrice, history, listedAt } = info;
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

// ---------- 시세 변동 ----------
// 모든 종목 가격을 minPct~maxPct(%) 범위에서 무작위로 변동시킴 (최저가 1해정 보장)
// 변동 후 가격이 DELIST_PRICE 이하이면 상장폐지 처리합니다.
// 반환: [{ name, before, after, pct, delisted, holders }]
//   - delisted: 상장폐지 여부
//   - holders: 상장폐지된 종목을 보유 중이던 유저 ID 목록 (아니면 빈 배열)
// crashChance: 종목마다 이 확률로 crashPct(예: -100%)가 그대로 적용돼요. (0.005 = 0.5%)
// impact: { 종목이름: %p } 봇 순매수 압력 등 종목별로 변동률에 더해지는 값 (crowd.js 에서 계산)
export async function fluctuatePrices(env, { minPct, maxPct, crashChance = 0, crashPct = -100, impact = {} }) {
  const stocks = await listStocks(env);
  const changes = [];

  for (const stock of stocks) {
    const pct = Math.random() < crashChance
      ? crashPct
      : minPct + Math.random() * (maxPct - minPct) + (impact[stock.name] || 0);
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

// ---------- 전체 유저 보유 종목 (/보유종목 용) ----------
// 보유 종목이 있는 유저만, 보유 평가액 높은 순으로 돌려줘요. 상장폐지된 종목은 제외.
// [{ id, username, holdings: [{ name, qty, price, value }], total }]
export async function getAllHoldings(env) {
  const [users, stocks] = await Promise.all([
    listCollection(env, "users"),
    listCollection(env, "stocks"),
  ]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));

  return users
    .map((u) => {
      const holdings = Object.entries(u.holdings || {})
        .filter(([name, qty]) => qty > 0 && priceMap[name] !== undefined)
        .map(([name, qty]) => ({ name, qty, price: priceMap[name], value: priceMap[name] * qty }))
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
  "봇현황", "랭킹", "내역", "예약목록", "보유상품", "알림확인", "채굴정보", "주식상점",
  "선물목록", "선물설명", "은행", "은행설명",
]);

// 명령어 이름 -> 분류 (관리자 콘솔의 분류 선택칸에 그대로 나와요)
const CATEGORY = {
  매수: "매수",
  매도: "매도",
  구입: "상품구입",
  선물: "선물",
  선물청산: "선물",
  예금: "은행",
  출금: "은행",
  대출: "은행",
  상환: "은행",
  예약매수: "예약",
  예약매도: "예약",
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
export async function logAction(env, { u, n = "", cmd, a = "", r = "", k }) {
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
    });
  } catch (err) {
    console.error(`활동 로그 저장 실패 (${cmd}):`, err.message);
  }
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
const STAMINA_BASE = 10;          // Lv1 최대 체력
const STAMINA_PER_LEVEL = 2;      // 레벨당 최대 체력 증가량
const STAMINA_REGEN_MINUTES = 6;  // 체력 1 회복에 걸리는 시간(분)

const REWARD_BASE_MIN = 15;       // Lv1 채굴 보상 최소
const REWARD_BASE_MAX = 35;       // Lv1 채굴 보상 최대
const REWARD_PER_LEVEL = 8;       // 레벨당 보상 증가량(최소/최대 동일하게)

const UPGRADE_BASE_COST = 500;    // Lv1→2 업그레이드 비용(해정)
const UPGRADE_COST_GROWTH = 1.6;  // 레벨마다 비용 배율

const UPGRADE_BASE_COUNT = 15;    // 노가다로 무료 업그레이드하려면 필요한 채굴 횟수(Lv1 기준)
const UPGRADE_COUNT_GROWTH = 5;   // 레벨마다 필요 횟수 증가량

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
  return Math.round(UPGRADE_BASE_COST * Math.pow(UPGRADE_COST_GROWTH, level - 1));
}

function upgradeCountFor(level) {
  return UPGRADE_BASE_COUNT + (level - 1) * UPGRADE_COUNT_GROWTH;
}

// 유저 문서에 채굴 상태가 없으면 기본값으로 생성
function ensureMining(user) {
  if (!user.mining) {
    user.mining = { level: 1, stamina: STAMINA_BASE, staminaAt: Date.now(), count: 0 };
  }
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
      `📈 Lv.${mining.level} 진행도: ${mining.count}/${required}회 (채우면 무료 업그레이드 가능)`,
    ].join("\n"),
  };
}

// ---------- 업그레이드 ----------
export async function upgradeMining(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  const cost = upgradeCostFor(mining.level);
  const required = upgradeCountFor(mining.level);

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
    `다음 업그레이드 (Lv.${mining.level + 1}):`,
    `- 해정으로: ${cost.toLocaleString()}해정`,
    `- 노가다로: ${required}회 채굴 (현재 ${mining.count}/${required})`,
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
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.url) return data.url;
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
  return `-${lost.toLocaleString()}해정, -${pct.toFixed(1)}%`;
}

// DM용 한 줄 (상장폐지는 별도 문구)
function formatLines(list) {
  return list
    .map((c) => {
      if (c.delisted) {
        return `• 🚫 **${c.name}**: 상장폐지 (${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 · ${dropText(c)} 하락, 보유 주식 소멸)`;
      }
      const pct = ((c.after - c.before) / c.before) * 100;
      const sign = pct > 0 ? "+" : "";
      const mark = c.after > c.before ? UP_MARK : c.after < c.before ? DOWN_MARK : "➖";
      return `• ${mark} **${c.name}**${dangerTag(c.after)}: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 (${sign}${pct.toFixed(1)}%)`;
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
    return `🚫 **${c.name}**: 상장폐지 (${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 · ${dropText(c)} 하락)`;
  }
  if (c.after === c.before) {
    return `➖ **${c.name}**: ${c.after.toLocaleString()}해정 (변동 없음)${dangerTag(c.after)}`;
  }
  const up = c.after > c.before;
  const pct = ((c.after - c.before) / c.before) * 100;
  return `${up ? UP_MARK : DOWN_MARK} **${c.name}**: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}해정 (${up ? "+" : ""}${pct.toFixed(1)}%)${dangerTag(c.after)}`;
}

// 시세가 변동될 때마다 주식채널(ALLOWED_CHANNEL_ID)에 변동 내역을 공지합니다.
// 유저의 알림 설정과 상관없이 올라가요. (관리자 콘솔의 '가격 변동 알림' 체크를 끄면 올라가지 않음) 실패해도 시세 변동 자체는 막지 않습니다.
// 상장폐지된 종목이 있으면 공지 맨 아래에 안내 문구가 추가돼요.
// 반환값: { sent: true, messages: 보낸 메시지 수 } 또는 { sent: false, reason: "이유" }
export async function announcePriceChanges(env, changes, label = "시세 변동") {
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

  try {
    const header = `📊 **시세 변동** · ${label} · ${formatNowKST()}`;
    const chunks = [];
    let current = header;

    // 변동 후 가격이 높은 순으로 정렬 (같으면 이름순). 낮은 순으로 바꾸려면 b.after - a.after 를 a.after - b.after 로
    const sorted = [...changes].sort(
      (a, b) => b.after - a.after || String(a.name).localeCompare(String(b.name), "ko")
    );

    for (const c of sorted) {
      const line = announceLine(c);
      // 디스코드 메시지 한도(2000자)를 넘지 않게 나눠서 보냄
      if (current.length + line.length + 1 > 1900) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n" : "") + line;
    }

    // 안내 문구: 상장폐지 종목이 있을 때만 표시
    if (changes.some((c) => c.delisted)) {
      const note = "🚫 상장폐지된 종목은 거래할 수 없고, 보유 중이던 주식은 모두 사라졌어요.";
      if (current.length + note.length + 2 > 1900) {
        chunks.push(current);
        current = "";
      }
      current += (current ? "\n\n" : "") + note;
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

  const users = await listCollection(env, "users");
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
              r: `예약가 ${h.o.price.toLocaleString()} → 체결가 ${h.price.toLocaleString()}해정`,
            });
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
// [futures.js]
// ============================================================
// ---------- 주식 선물 (롱/숏 + 배율) ----------
// 증거금을 걸고 종목이 오를지(롱) 내릴지(숏)에 배율을 곱해 베팅해요.
//  - 평가금 = 증거금 + 증거금 × 배율 × 방향 × (현재가 - 진입가) / 진입가   (롱 +1, 숏 -1)
//  - 평가금이 0이 되면 강제청산(증거금 전액 손실). 정산하면 평가금을 해정으로 돌려받아요.
//  - 저장: futures/{유저ID} 문서의 items 맵 { 번호: { stock, side, margin, lev, entry, t } }
export const MAX_FUTURES_PER_USER = 3;
export const MIN_FUTURES_MARGIN = 100;
export const FUTURES_LEVERAGES = [2, 3, 5];

const futuresPath = (userId) => `futures/${userId}`;

export async function getFutureItems(env, userId) {
  const doc = await getDoc(env, futuresPath(userId));
  return { ...((doc && doc.items) || {}) };
}

export async function saveFutureItems(env, userId, items) {
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
  return `**${f.stock}** ${f.side === "long" ? "📈" : "📉"} ${sideLabel(f.side)} x${f.lev} · 증거금 ${f.margin.toLocaleString()}해정 · 진입가 ${f.entry.toLocaleString()}해정`;
}

// 선물 시작
export async function openFuture(env, userId, { stock: stockName, side, margin, lev }) {
  if (side !== "long" && side !== "short") return { ok: false, message: "방향은 롱 또는 숏 중에서 골라 주세요." };
  if (!FUTURES_LEVERAGES.includes(lev)) {
    return { ok: false, message: `배율은 ${FUTURES_LEVERAGES.join(", ")}배 중에서 골라 주세요.` };
  }
  if (!Number.isSafeInteger(margin) || margin < MIN_FUTURES_MARGIN) {
    return { ok: false, message: `증거금은 ${MIN_FUTURES_MARGIN.toLocaleString()}해정 이상 정수로 입력해 주세요.` };
  }

  const stock = await getStock(env, stockName);
  if (!stock) return { ok: false, message: `"${stockName}" 종목을 찾을 수 없어요.` };

  const items = await getFutureItems(env, userId);
  if (Object.keys(items).length >= MAX_FUTURES_PER_USER) {
    return { ok: false, message: `선물은 최대 ${MAX_FUTURES_PER_USER}개까지 열 수 있어요. \`/선물청산\`으로 먼저 정산해 주세요.` };
  }

  const user = await getUser(env, userId);
  if (user.balance < margin) {
    return { ok: false, message: `잔고가 부족해요. (필요: ${margin.toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)` };
  }

  const balanceBefore = user.balance;
  user.balance -= margin;
  const id = newFutureId(items);
  const f = { stock: stockName, side, margin, lev, entry: stock.price, t: Date.now() };
  items[id] = f;

  // 증거금 차감을 먼저 저장하고 포지션을 저장해요. 포지션 저장이 실패하면 증거금을 돌려줘요.
  await saveUser(env, userId, user);
  try {
    await saveFutureItems(env, userId, items);
  } catch (err) {
    console.error(`선물 저장 실패 (${userId}):`, err.message);
    user.balance += margin;
    await saveUser(env, userId, user).catch(() => {});
    return { ok: false, message: "선물을 여는 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }

  await addHistory(env, userId, `선물 시작: ${stockName} ${sideLabel(side)} x${lev} · 증거금 ${margin.toLocaleString()}해정 (진입가 ${f.entry.toLocaleString()})`);

  const liq = futureLiqPrice(f);
  return {
    ok: true,
    message: [
      `${side === "long" ? "📈" : "📉"} **선물 시작!** ${stockName} ${sideLabel(side)} x${lev}`,
      `- 증거금 ${margin.toLocaleString()}해정 · 진입가 ${f.entry.toLocaleString()}해정`,
      `- 💥 강제청산가: ${liq.toLocaleString()}해정 ${side === "long" ? "이하" : "이상"} (증거금 전부 잃어요)`,
      balanceLine(balanceBefore, user.balance),
    ].join("\n"),
  };
}

// 정산(청산): targets = 포지션 번호들 또는 ["all"]. 평가금을 해정으로 돌려받아요.
export async function closeFutures(env, userId, targets) {
  const [items, stocks] = await Promise.all([getFutureItems(env, userId), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const ids = targets.includes("all") ? Object.keys(items) : [...new Set(targets)].filter((t) => items[t]);
  if (ids.length === 0) {
    return { ok: false, message: "정산할 선물 포지션을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요." };
  }

  const user = await getUser(env, userId);
  const balanceBefore = user.balance;
  const lines = [];
  const closed = [];
  let payout = 0;
  let pnlSum = 0;

  for (const id of ids) {
    const f = items[id];
    const price = priceMap[f.stock] ?? f.entry; // 폐지돼서 남은 포지션이면 증거금 그대로 돌려줘요
    const equity = futureEquity(f, price);
    const pnl = equity - f.margin;
    payout += equity;
    pnlSum += pnl;
    delete items[id];
    lines.push(`- ${futureText(f)}\n  진입 ${f.entry.toLocaleString()} → 정산 ${price.toLocaleString()}해정 · ${profitLabel(pnl, f.margin)}`);
    closed.push(`${f.stock} ${sideLabel(f.side)} x${f.lev} ${fmtSigned(pnl)}해정`);
  }

  // 포지션을 먼저 지워서 같은 포지션이 두 번 정산되지 않게 해요
  await saveFutureItems(env, userId, items);
  user.balance += payout;
  user.realizedProfit = (user.realizedProfit || 0) + pnlSum;
  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `선물 정산: ${closed.join(", ")} → 잔고 ${user.balance.toLocaleString()}해정`),
  ]);

  return {
    ok: true,
    message: [`**선물 ${ids.length}건 정산 완료**`, ...lines, balanceLine(balanceBefore, user.balance)].join("\n"),
  };
}

// 시세 변동 직후에 호출: 증거금이 바닥난 포지션은 강제청산, 폐지된 종목은 폐지 가격으로 정산
// 반환: { liquidated: 강제청산 수, settled: 폐지 정산 수 }
export async function processFutures(env, changes = []) {
  const [docs, stocks] = await Promise.all([listCollection(env, "futures"), listStocks(env)]);
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
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
        const lines = [];
        for (const h of live) {
          const pnl = h.equity - h.f.margin;
          user.balance += h.equity;
          user.realizedProfit = (user.realizedProfit || 0) + pnl;
          const label = `${h.f.stock} ${sideLabel(h.f.side)} x${h.f.lev}`;
          if (h.gone) {
            summary.settled++;
            lines.push(`🏁 ${label} — 상장폐지로 ${h.price.toLocaleString()}해정에 정산 (${fmtSigned(pnl)}해정)`);
          } else {
            summary.liquidated++;
            lines.push(`💥 ${label} — 시세가 ${h.price.toLocaleString()}해정이 되어 강제청산 (-${h.f.margin.toLocaleString()}해정)`);
          }
        }
        await saveUser(env, userId, user);
        await Promise.all([
          addHistory(env, userId, `선물 자동 정산 ${live.length}건 → 잔고 ${user.balance.toLocaleString()}해정`),
          logAction(env, { u: userId, cmd: "선물청산", a: `${live.length}건`, r: "자동 정산: 강제청산/상장폐지" }),
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
export const DEPOSIT_RATE = 0.005; // 예금 일 0.5%
export const LOAN_TERMS = { 1: 0.03, 3: 0.025, 7: 0.02 }; // 기간(일) -> 일 이자율
export const LOAN_PENALTY_RATE = 0.05; // 연체 시 일 +5%p
export const LOAN_MIN = 100;
export const MAX_LOANS_PER_USER = 3;
export const LOAN_LIMIT_RATIO = 0.5; // 한도 = 순자산의 50%
export const LOAN_LIMIT_MIN = 1000; // 순자산이 적어도 이만큼은 빌릴 수 있어요
export const LIQUIDATE_AFTER_HOURS = 24; // 연체 후 이 시간이 지나면 보유 주식 강제 매도
export const REMIND_BEFORE_HOURS = 6; // 만기 이 시간 전에 DM으로 알려줘요
const BANK_HOUR_MS = 60 * 60 * 1000;

const bankPath = (userId) => `bank/${userId}`;
const pctText = (r) => `${+(r * 100).toFixed(2)}%`;
const unixOf = (ms) => Math.floor(ms / 1000);
// 디스코드가 알아서 "3일 뒤"처럼 실시간으로 바꿔 보여주는 시각 표시
const dueText = (ms) => `<t:${unixOf(ms)}:f> (<t:${unixOf(ms)}:R>)`;
const depositOf = (bank) => Math.floor(bank.deposit + 1e-9);

export async function getBank(env, userId) {
  const doc = await getDoc(env, bankPath(userId));
  const bank = { deposit: 0, depositAt: 0, earned: 0, loans: {}, ...(doc || {}) };
  if (!bank.loans) bank.loans = {};
  return bank;
}

async function saveBank(env, userId, bank) {
  await setDoc(env, bankPath(userId), {
    deposit: bank.deposit,
    depositAt: bank.depositAt,
    earned: bank.earned || 0,
    loans: bank.loans,
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
  if (bank.deposit > 0 && bank.depositAt && now > bank.depositAt) {
    const gain = (bank.deposit * DEPOSIT_RATE * (now - bank.depositAt)) / DAY_MS;
    bank.deposit += gain;
    bank.earned = (bank.earned || 0) + gain;
  }
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
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
  const holdingsValue = Object.entries(user.holdings).reduce((sum, [name, qty]) => sum + (priceMap[name] || 0) * qty, 0);
  const futs = futureList(await getFutureItems(env, userId));
  const futuresValue = futs.reduce((sum, f) => sum + (priceMap[f.stock] === undefined ? f.margin : futureEquity(f, priceMap[f.stock])), 0);
  const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
  const deposit = depositOf(bank);
  return { net: user.balance + holdingsValue + deposit + futuresValue - debt, debt, deposit };
}

// 대출 한도: 순자산의 50% (최소 1,000해정). 이미 빌린 원금은 빼요.
function loanLimitOf(net, bank) {
  const total = Math.max(LOAN_LIMIT_MIN, Math.floor(Math.max(net, 0) * LOAN_LIMIT_RATIO));
  const used = Object.values(bank.loans).reduce((sum, l) => sum + l.principal, 0);
  return { total, used, available: Math.max(0, total - used) };
}

// 랭킹/총자산용: 예금 + 선물 평가금 - 대출. { 유저ID: 해정 }
export async function extraAssets(env, priceMap) {
  const [banks, futs] = await Promise.all([listCollection(env, "bank"), listCollection(env, "futures")]);
  const now = Date.now();
  const extra = {};
  for (const b of banks) {
    const bank = accrueBank({ deposit: b.deposit || 0, depositAt: b.depositAt || 0, earned: 0, loans: structuredClone(b.loans || {}) }, now);
    const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
    extra[b.id] = (extra[b.id] || 0) + depositOf(bank) - debt;
  }
  for (const f of futs) {
    for (const p of Object.values(f.items || {})) {
      const price = priceMap[p.stock];
      extra[f.id] = (extra[f.id] || 0) + (price === undefined ? p.margin : futureEquity(p, price));
    }
  }
  return extra;
}

// 한 명분 (/내정보용)
export async function userExtraAsset(env, userId, priceMap) {
  const [bank0, futItems] = await Promise.all([getBank(env, userId), getFutureItems(env, userId)]);
  const bank = accrueBank(structuredClone(bank0), Date.now());
  const debt = Object.values(bank.loans).reduce((sum, l) => sum + loanOwed(l), 0);
  const futuresValue = futureList(futItems).reduce(
    (sum, f) => sum + (priceMap[f.stock] === undefined ? f.margin : futureEquity(f, priceMap[f.stock])),
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
      `🐷 예금 총액: **${depositOf(bank).toLocaleString()}해정** (일 ${pctText(DEPOSIT_RATE)} · 하루에 약 +${Math.floor(bank.deposit * DEPOSIT_RATE).toLocaleString()}해정)`,
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
  const rate = LOAN_TERMS[termDays];
  if (rate === undefined) return { ok: false, message: `기간은 ${Object.keys(LOAN_TERMS).join(", ")}일 중에서 골라 주세요.` };
  if (!Number.isSafeInteger(amount) || amount < LOAN_MIN) {
    return { ok: false, message: `대출은 ${LOAN_MIN.toLocaleString()}해정 이상 정수로 신청해 주세요.` };
  }

  const now = Date.now();
  const [user, bank0, stocks] = await Promise.all([getUser(env, userId), getBank(env, userId), listStocks(env)]);
  const bank = accrueBank(bank0, now);

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
  user.balance += amount;
  try {
    await saveUser(env, userId, user);
  } catch (err) {
    console.error(`대출 지급 실패 (${userId}):`, err.message);
    delete bank.loans[id];
    await saveBank(env, userId, bank).catch(() => {});
    return { ok: false, message: "대출 처리 중 오류가 나서 취소했어요. 잠시 후 다시 시도해 주세요." };
  }
  await addHistory(env, userId, `대출: ${amount.toLocaleString()}해정 (${termDays}일 · 일 ${pctText(rate)}) → 잔고 ${user.balance.toLocaleString()}해정`);

  const expected = Math.round(amount * rate * termDays);
  return {
    ok: true,
    message: [
      `💸 **대출 실행!** \`${id}\` ${amount.toLocaleString()}해정 (${termDays}일)`,
      balanceLine(balanceBefore, user.balance),
      `- 이자: 하루 ${pctText(rate)} (${termDays}일 꽉 채우면 약 ${expected.toLocaleString()}해정, 시간 단위로 계속 쌓여요)`,
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
  let total = 0;
  for (const { id, pay } of plan) {
    const loan = bank.loans[id];
    const { toInterest, toPrincipal } = payLoan(loan, pay);
    total += pay;
    if (loan.principal <= 0) {
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

  return { ok: true, message: [`💳 **상환 완료** -${total.toLocaleString()}해정`, ...lines, balanceLine(balanceBefore, user.balance)].join("\n") };
}

// ---------- /은행 : 내 현황 (조회하는 순간 기준) ----------
export async function bankStatus(env, userId) {
  const now = Date.now();
  const [user, bank0, stocks] = await Promise.all([getUser(env, userId), getBank(env, userId), listStocks(env)]);
  const bank = accrueBank(structuredClone(bank0), now);
  const { net, debt, deposit } = await netWorthOf(env, userId, user, bank, stocks);
  const limit = loanLimitOf(net, bank);

  const lines = ["**🏦 내 은행 현황** (지금 이 순간 기준, 이자는 계속 쌓여요)", ""];
  lines.push(`🐷 **예금**: ${deposit.toLocaleString()}해정 (일 ${pctText(DEPOSIT_RATE)} · 지금까지 받은 이자 +${Math.floor(bank.earned || 0).toLocaleString()}해정)`);

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
  lines.push("", `📋 **대출 한도**: 남은 ${limit.available.toLocaleString()}해정 / 전체 ${limit.total.toLocaleString()}해정 (순자산 ${net.toLocaleString()}해정의 ${LOAN_LIMIT_RATIO * 100}%, 최소 ${LOAN_LIMIT_MIN.toLocaleString()})`);
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
  const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
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
            }
          }

          if (l.principal <= 0) {
            delete bank.loans[id];
            summary.collected++;
            notes.push(`🏦 **[대출 자동 상환]** \`${id}\` 대출이 만기가 되어 ${paid.toLocaleString()}해정이 자동으로 상환됐어요.${soldLines.length ? `\n보유 주식을 강제로 팔았어요: ${soldLines.join(", ")}` : ""}`);
          } else {
            summary.overdue++;
            notes.push(
              `🚨 **[연체]** \`${id}\` 대출이 만기를 넘겼어요. 남은 빚 ${loanOwed(l).toLocaleString()}해정 (하루 ${pctText(l.rate + LOAN_PENALTY_RATE)}씩 연체 이자)` +
                (paid > 0 ? `\n자동으로 ${paid.toLocaleString()}해정을 회수했어요.` : "") +
                (soldLines.length ? `\n보유 주식을 강제로 팔았어요: ${soldLines.join(", ")}` : "") +
                `\n해정이 들어오면 자동으로 갚아지고, ${LIQUIDATE_AFTER_HOURS}시간이 지나면 보유 주식이 강제로 팔려요.`
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
  { name: "채굴", description: "채굴장에서 노가다로 해정을 법니다. (체력 소모, 효율은 주식보다 낮아요)" },
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
    description: "종목을 매수합니다. 종목2~5를 쓰면 여러 종목을 한 번에 사요. 수량 기본 1주.",
    options: multi([
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "매수할 수량 (기본 1, '최대'는 살 수 있는 만큼)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "매도",
    description: "종목을 매도합니다. 종목2~5를 쓰면 여러 종목을 한 번에 팔아요. 수량 기본 1주.",
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
      { name: "가격", description: "이 가격 이하가 되면 매수 (해정)", type: 4, required: true, autocomplete: true },
      { name: "수량", description: "매수할 수량 (기본 1)", type: 4, required: false, autocomplete: true },
    ]),
  },
  {
    name: "예약매도",
    description: "지정가 이상이 되면 자동 매도하도록 예약합니다. 종목2~5로 여러 개를 한 번에 예약해요.",
    options: multi([
      { name: "종목", description: "내가 가진 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "이 가격 이상이 되면 매도 (해정)", type: 4, required: true, autocomplete: true },
      { name: "수량", description: "매도할 수량 (기본 1)", type: 4, required: false, autocomplete: true },
    ]),
  },
  { name: "예약목록", description: "내가 걸어둔 예약 매수/매도 목록을 봅니다." },
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
      { name: "증거금", description: "걸 해정 (최소 100, 잃어도 이만큼만 잃어요)", type: 4, required: true, autocomplete: true, min_value: 100 },
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
  { name: "은행", description: "내 예금·대출·이자·대출 한도를 지금 이 순간 기준으로 봅니다." },
  { name: "은행설명", description: "은행 이용법을 쉽게 알려줍니다. (예금·대출·이자·연체)" },
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
    name: "대출",
    description: "은행에서 해정을 빌립니다. 기간 안에 이자와 함께 갚아야 해요. (사용법은 /은행설명)",
    options: [
      { name: "금액", description: "빌릴 해정 (칸을 누르면 한도 안의 예시가 떠요)", type: 4, required: true, autocomplete: true, min_value: LOAN_MIN },
      {
        name: "기간",
        description: "갚을 기간 (길수록 하루 이자는 낮아요)",
        type: 4,
        required: true,
        choices: Object.entries(LOAN_TERMS).map(([d, r]) => ({ name: `${d}일 (이자 하루 ${+(r * 100).toFixed(2)}%)`, value: Number(d) })),
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
    options: multi([
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "가격", description: "초기 가격(해정)", type: 4, required: true, autocomplete: true },
    ]),
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
];

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
function priorAdjusted(command, interaction, slot, user, priceMap) {
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
      if (price !== undefined) copy.balance -= price * qty;
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
    const line = `\`/${c.name}\` — ${c.description}`;
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

  const [stock, userRaw, all] = await Promise.all([
    getStock(env, stockName),
    getUser(env, userId),
    slot ? listStocks(env) : null, // 2번째 칸부터는 앞 칸 종목의 가격이 필요해요
  ]);
  if (!stock) return plain();
  const user = all ? priorAdjusted(command, interaction, slot, userRaw, Object.fromEntries(all.map((s) => [s.name, s.price]))) : userRaw;

  let labelFor;
  let values;

  if (command === "매수") {
    const max = stock.price > 0 ? Math.floor(user.balance / stock.price) : 0;
    labelFor = (q) => {
      if (q <= 0) return "1주 이상 입력해 주세요";
      const p = previewBuy(user, stock, q);
      return p.ok
        ? `${q.toLocaleString()}주 매수 → -${p.cost.toLocaleString()}해정 · 잔고 ${p.after.toLocaleString()}해정`
        : `${q.toLocaleString()}주 매수 불가 (필요 ${p.cost.toLocaleString()} / 잔고 ${user.balance.toLocaleString()}해정)`;
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
    return `${q.toLocaleString()}주 매도 → +${p.earned.toLocaleString()} · 잔고 ${p.after.toLocaleString()} · ${profitLabel(p.profit, p.basis, true)}`;
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
  const stock = await getStock(env, stockName);
  if (!stock) return [];

  const p = stock.price;
  const list = [{ label: `현재가 ${p.toLocaleString()}해정`, value: p }];
  for (const m of [0.5, 0.8, 1.2, 1.5, 2]) {
    const value = Math.max(1, Math.round(p * m));
    const pct = Math.round((m - 1) * 100);
    list.push({ label: `${pct > 0 ? "+" : ""}${pct}% → ${value.toLocaleString()}해정`, value });
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
    const stocks = await listStocks(env); // 이름순

    const userId = interaction.member?.user?.id;
    const rawUser = userId ? await getUser(env, userId) : { balance: 0, holdings: {}, costs: {} };
    const user = priorAdjusted(command, interaction, slot, rawUser, Object.fromEntries(stocks.map((s) => [s.name, s.price])));

    if (command === "매도" || command === "예약매도") {
      // 매도는 내가 가진 종목만 보여줌 (현재가 기준 평가손익 함께 표시)
      return textChoices(
        stocks
          .filter((s) => (user.holdings[s.name] || 0) > 0)
          .map((s) => {
            const qty = user.holdings[s.name];
            const cost = costOf(user, s.name, s.price);
            return {
              label: `${s.name}${dangerTag(s.price, true)} (보유 ${qty}주 · ${s.price.toLocaleString()}해정 · ${profitLabel(s.price * qty - cost, cost, true)})`,
              value: s.name,
            };
          }),
        keyword
      );
    }

    if (command === "매수" || command === "예약매수") {
      // 매수는 지금 잔고로 최대 몇 주까지 살 수 있는지 함께 표시
      return textChoices(
        stocks.map((s) => ({
          label: `${s.name}${dangerTag(s.price, true)} (${s.price.toLocaleString()}해정 · 최대 ${Math.floor(user.balance / s.price).toLocaleString()}주)`,
          value: s.name,
        })),
        keyword
      );
    }

    return textChoices(
      pickable(stocks.map((s) => ({ label: `${s.name}${dangerTag(s.price, true)} (${s.price.toLocaleString()}해정)`, value: s.name }))),
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

    // 대출: 남은 한도 안의 예시
    const [user, bank0, stocks] = await Promise.all([getUser(env, userId), getBank(env, userId), listStocks(env)]);
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
    const [items, stocks] = await Promise.all([userId ? getFutureItems(env, userId) : {}, listStocks(env)]);
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    const list = futureList(items).map((f) => {
      const price = priceMap[f.stock];
      const pnlText = price === undefined ? "상장폐지" : profitLabel(futureEquity(f, price) - f.margin, f.margin, true);
      return { label: `[${f.id}] ${f.stock} ${sideLabel(f.side)} x${f.lev} · ${pnlText}`, value: f.id };
    });
    const left = pickable(list);
    if (left.length > 1 && taken.size === 0) left.push({ label: "전체 정산", value: "all" }); // 전체 정산은 첫 칸에서만
    return textChoices(left, keyword);
  }

  // ----- 선물 증거금 예시 -----
  if (base === "증거금") {
    const userId = interaction.member?.user?.id;
    const user = userId ? await getUser(env, userId) : { balance: 0 };
    const list = [100, 500, 1000, 5000, 10000]
      .filter((n) => n <= user.balance)
      .map((n) => ({ label: `${n.toLocaleString()}해정`, value: n }));
    if (user.balance >= MIN_FUTURES_MARGIN) list.push({ label: `전액 ${user.balance.toLocaleString()}해정`, value: user.balance });
    return numberChoices(list, keyword);
  }

  // ----- 예약취소: 내 예약 목록 -----
  if (base === "예약") {
    const userId = interaction.member?.user?.id;
    const orders = userId ? await getOrders(env, userId) : [];
    const items = orders.map((o) => ({
      label: `[${o.id}] ${sideText(o.side)} ${o.stock} · ${o.price.toLocaleString()}해정 ${o.side === "buy" ? "이하" : "이상"} · ${o.qty.toLocaleString()}주`,
      value: o.id,
    }));
    const left = pickable(items);
    if (left.length > 1 && taken.size === 0) left.push({ label: "전체 취소", value: "all" }); // 전체 취소는 첫 칸에서만
    return textChoices(left, keyword);
  }

  // ----- 숫자 옵션 -----
  if (base === "수량") {
    // 예약은 체결 시점 가격이 달라서 미리보기 없이 예시만 보여줌
    if (command === "예약매수" || command === "예약매도") {
      return numberChoices([1, 5, 10, 50, 100].map((n) => ({ label: `${n}주`, value: n })), keyword);
    }
    return quantityChoices(command, interaction, env, keyword, slot);
  }

  if (focused.name === "개수") {
    return numberChoices([5, 10, 20, 30].map((n) => ({ label: `${n}건`, value: n })), keyword);
  }

  if (focused.name === "시작" || focused.name === "종료") {
    return numberChoices(HOURS, keyword);
  }

  if (base === "가격") {
    if (command === "시세설정" || command === "예약매수" || command === "예약매도") {
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
  const reserved = {};
  for (const o of Object.values(items)) {
    if (o.side === "sell") reserved[o.stock] = (reserved[o.stock] || 0) + o.qty;
  }

  slots.forEach((s, i) => {
    const stock = stocks[i];
    if (!stock) return;
    if (side === "buy") {
      if (stock.price <= s.price) {
        errors.push(`${tag(s)}현재가(${stock.price.toLocaleString()}해정)가 이미 예약가 이하예요. 바로 \`/매수\`를 쓰거나, 더 낮은 가격으로 예약해 주세요.`);
      } else if (user.balance < s.price * s.qty) {
        errors.push(`${tag(s)}잔고가 부족해요. (예약가 기준 필요: ${(s.price * s.qty).toLocaleString()}해정, 보유: ${user.balance.toLocaleString()}해정)`);
      }
    } else {
      if (stock.price >= s.price) {
        errors.push(`${tag(s)}현재가(${stock.price.toLocaleString()}해정)가 이미 예약가 이상이에요. 바로 \`/매도\`를 쓰거나, 더 높은 가격으로 예약해 주세요.`);
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
    return { id, order, now: stocks[i].price };
  });
  await saveOrderItems(env, userId, next);

  const footer = "시세가 변동될 때(평소 변동, 급등락)마다 확인하고, 체결되면 DM으로 알려드려요. (체결가는 그때의 현재가예요)";
  if (!many) {
    const { id, order, now } = made[0];
    return [`⏰ 예약했어요. \`${id}\``, orderText(order), `현재가 ${now.toLocaleString()}해정 · ${footer}`].join("\n");
  }
  return [
    `⏰ ${made.length}건을 예약했어요.`,
    ...made.map((m) => `- \`${m.id}\` ${orderText(m.order)} · 현재가 ${m.now.toLocaleString()}해정`),
    footer,
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
            `${mark} 현재가 **${stock.price.toLocaleString()}해정**${dangerTag(stock.price) ? `${dangerTag(stock.price)} 상장폐지 위기` : ""}`,
            `구간 변동: ${mark} ${fmtSigned(diff)}해정 (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) · ${formatKST(first.t)} 시작가 ${first.p.toLocaleString()}해정 대비`,
            `구간 최고 ${high.toLocaleString()} / 최저 ${low.toLocaleString()}해정`,
            `역대 최고가 ${Math.max(stock.maxPrice || 0, high).toLocaleString()}해정`,
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
    "**명령어**",
    "`/선물` 시작 · `/선물목록` 내 손익 보기 · `/선물청산` 정산하고 해정 받기",
    "",
    "**꼭 알아두세요**",
    "- 시세는 15분마다 크게 움직여요. 배율이 높을수록 한 번에 강제청산되기 쉬워요",
    "- 급등락 시간(18시/21시/0시)에는 변동이 훨씬 커서 더 위험해요",
    "- 강제청산은 시세가 바뀔 때 자동으로 돼요. 시작할 때 강제청산가를 알려줘요",
    "- 상장폐지되면 폐지 가격으로 자동 정산돼요",
    `- 최대 ${MAX_FUTURES_PER_USER}개까지 열 수 있고, 증거금은 ${MIN_FUTURES_MARGIN}해정부터예요`,
  ].join("\n");
}

// /은행설명: 처음 보는 사람도 바로 이해하도록 짧게
function bankHelpText() {
  const terms = Object.entries(LOAN_TERMS)
    .map(([d, r]) => `${d}일(하루 ${pctText(r)})`)
    .join(" / ");
  return [
    "**🏦 해정 은행 사용법**",
    "맡기면 **이자를 받고**, 빌리면 **이자를 내요.** 이자는 시간이 흐르는 대로 실시간으로 쌓여요.",
    "",
    "**🐷 예금** — 하루 " + pctText(DEPOSIT_RATE),
    "`/예금 금액` 맡기기 · `/출금` 찾기 (금액을 안 적으면 전액)",
    "",
    "**💸 대출**",
    "`/대출 금액 기간` — 기간: " + terms,
    "- 이자는 빌린 순간부터 시간 단위로 계속 쌓여요",
    "- 일찍 갚으면 **그때까지 쌓인 이자만** 내요",
    `- 한도: 내 순자산(해정+주식+예금+선물-빚)의 ${LOAN_LIMIT_RATIO * 100}%, 최소 ${LOAN_LIMIT_MIN.toLocaleString()}해정`,
    `- 동시에 최대 ${MAX_LOANS_PER_USER}건`,
    "",
    "**예시** 1,000해정을 3일로 빌리면?",
    "- 하루 " + pctText(LOAN_TERMS[3]) + " → 3일 꽉 채우면 이자 약 " + Math.round(1000 * LOAN_TERMS[3] * 3) + "해정",
    "- 1일 만에 갚으면 이자 약 " + Math.round(1000 * LOAN_TERMS[3]) + "해정",
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
    "`/은행` — 내 예금·대출·이자·한도를 지금 이 순간 기준으로 보기",
  ].join("\n");
}

export const handlers = {
  도움말: async () => helpText(),

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
        return `${mark}**${s.name}**${dangerTag(s.price)} — ${s.price.toLocaleString()}해정 (${change})`;
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
              `${DOWN_MARK} 폐지된 변동: ${(d.lastPrice || 0).toLocaleString()} → ${(d.finalPrice || 0).toLocaleString()}해정 (**-${((d.lastPrice || 0) - (d.finalPrice || 0)).toLocaleString()}해정, -${d.dropPct}%**)`,
              `📉 역대 최고가 ${(d.maxPrice || 0).toLocaleString()}해정 대비 **-${d.peakDropPct}%**`,
              `⬇️ 기록 중 한 번에 가장 많이 하락: **-${d.maxDropPct}%**`,
              `구간 최고 ${high.toLocaleString()} / 최저 ${low.toLocaleString()}해정 · 폐지 당시 보유자 ${(d.holders || 0).toLocaleString()}명`,
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
        `🚫 **${d.name}** · \`${formatKSTFull(d.delistedAt)}\` · ${(d.lastPrice || 0).toLocaleString()} → ${(d.finalPrice || 0).toLocaleString()}해정 (**-${((d.lastPrice || 0) - (d.finalPrice || 0)).toLocaleString()}해정, -${d.dropPct}%**) · 최고가 ${(d.maxPrice || 0).toLocaleString()} 대비 -${d.peakDropPct}% · 최대 하락 -${d.maxDropPct}%`
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
      const stocksText = u.holdings
        .map((h) => `${h.name}${dangerTag(h.price)} ${h.qty.toLocaleString()}주`)
        .join(", ");
      const line = `• **${who}** — ${stocksText}`.slice(0, 500);
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
    const user = await getUser(env, userId);
    const holdingsText = Object.entries(user.holdings)
      .sort(([a], [b]) => compareKo(a, b))
      .map(([name, qty]) => `- ${name}: ${qty}주`)
      .join("\n") || "(보유 종목 없음)";
    return `잔고: **${user.balance.toLocaleString()}해정**\n${holdingsText}`;
  },

  // 보유 종목은 getUserDetail에서 이름순으로 정렬됨
  내정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const detail = await getUserDetail(env, userId);

    const holdingsText = detail.holdings
      .map(
        (h) =>
          `- ${h.name}${dangerTag(h.price)}: ${h.qty}주 (현재가 ${h.price.toLocaleString()} · 평균 매수가 ${h.avg.toLocaleString()} · 평가금 ${h.value.toLocaleString()}해정)\n  ${profitLabel(h.profit, h.cost)}`
      )
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
      `보유 종목 평가액: ${detail.holdingsValue.toLocaleString()}해정`,
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
    if (items.length === 1) return note + (await buyStock(env, userId, items[0].name, items[0].qty)).message;
    return note + (await buyStocks(env, userId, items)).message;
  },

  매도: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "종목");
    if (error) return error;
    if (!slots.length) return "종목을 골라 주세요.";
    const { items, merged, error: mergeError } = mergeSlots(slots);
    if (mergeError) return mergeError;
    const note = merged ? "ℹ️ 같은 종목은 수량을 합쳤어요.\n" : "";
    if (items.length === 1) return note + (await sellStock(env, userId, items[0].name, items[0].qty)).message;
    return note + (await sellStocks(env, userId, items)).message;
  },

  예약매수: (interaction, env) => reserveOrder("buy", interaction, env),
  예약매도: (interaction, env) => reserveOrder("sell", interaction, env),

  예약목록: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [orders, stocks] = await Promise.all([getOrders(env, userId), listStocks(env)]);
    if (orders.length === 0) {
      return "걸어둔 예약이 없어요. `/예약매수`, `/예약매도`로 가격을 정해 예약해 보세요.";
    }
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    return [
      `**⏰ 내 예약 (${orders.length}/${MAX_ORDERS_PER_USER}개)**`,
      ...orders.map((o) => {
        const now = priceMap[o.stock];
        const nowText = now === undefined ? "상장폐지" : `현재가 ${now.toLocaleString()}해정`;
        return `\`${o.id}\` ${orderText(o)} · ${nowText}`;
      }),
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
    return [
      `**예약 ${removed.length}건을 취소했어요.**`,
      ...removed.map((o) => `- \`${o.id}\` ${orderText(o)}`),
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
    return result.message;
  },

  선물목록: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const [items, stocks] = await Promise.all([getFutureItems(env, userId), listStocks(env)]);
    const list = futureList(items);
    if (list.length === 0) return "열어둔 선물이 없어요. `/선물`로 시작하거나 `/선물설명`을 읽어 보세요.";
    const priceMap = Object.fromEntries(stocks.map((s) => [s.name, s.price]));
    return [
      `**📊 내 선물 (${list.length}/${MAX_FUTURES_PER_USER}개)**`,
      ...list.map((f) => {
        const price = priceMap[f.stock];
        if (price === undefined) return `\`${f.id}\` ${futureText(f)}\n  상장폐지`;
        const equity = futureEquity(f, price);
        return [
          `\`${f.id}\` ${futureText(f)}`,
          `  현재가 ${price.toLocaleString()}해정 · 평가금 ${equity.toLocaleString()}해정 · ${profitLabel(equity - f.margin, f.margin)}`,
          `  💥 강제청산가 ${futureLiqPrice(f).toLocaleString()}해정 ${f.side === "long" ? "이하" : "이상"}`,
        ].join("\n");
      }),
    ].join("\n");
  },

  선물청산: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const { slots, error } = readSlots(interaction, "포지션");
    if (error) return error;
    const targets = slots.map((s) => s.name);
    if (!targets.length) return "정산할 포지션을 골라 주세요.";
    return (await closeFutures(env, userId, targets)).message;
  },

  선물설명: async () => futuresHelpText(),

  은행: async (interaction, env) => bankStatus(env, interaction.member.user.id),

  은행설명: async () => bankHelpText(),

  예금: async (interaction, env) => (await depositMoney(env, interaction.member.user.id, opt(interaction, "금액"))).message,

  출금: async (interaction, env) => (await withdrawMoney(env, interaction.member.user.id, opt(interaction, "금액"))).message,

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

    await Promise.all(slots.map((s) => upsertStock(env, s.name, s.price)));
    if (slots.length === 1) return `"${slots[0].name}" 종목을 ${slots[0].price.toLocaleString()}해정에 등록했어요.`;
    return [`${slots.length}개 종목을 등록했어요.`, ...slots.map((s) => `- "${s.name}" ${s.price.toLocaleString()}해정`)].join("\n");
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