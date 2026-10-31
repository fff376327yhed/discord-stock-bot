import {
  loadEnv,
  listStocks, upsertStock, removeStock, getStock, getUser, saveUser, invalidateStocksCache,
  listProducts, upsertProduct, removeProduct, getProduct, setUserItem, DELIST_PRICE,
  listCollection, setDoc, getDoc, deleteDoc,
  resetBots,
  logAction, listLogs, purgeLogs,
  getAttendanceConfig, setAttendanceConfig,
  getAnnounceConfig, setAnnounceConfig,
  getListingConfig, setListingConfig, parseNames, ensureMinimumStocks, LISTING_PRICE,
} from "../../src/lib.js";
import { isForeign, FOREIGN_KINDS, FOREIGN_START_PRICE, DEFAULT_MULT, symbolOfKind, defaultSourceOf } from "../../src/foreign.js";

// 외국자산(코인·해외주식) 종목 문서에만 있는 필드들 (이름을 바꿀 때 새 문서로 그대로 옮겨요)
const FOREIGN_FIELDS = ["kind", "symbol", "source", "mult", "startPrice", "baseReal", "lastReal", "quoteAt", "stale"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// 관리자 콘솔에서 한 작업(데이터를 바꾸는 것만)을 활동 로그에 남겨요.
const ADMIN_LABELS = {
  upsertStock: "종목 저장", upsertForeign: "외국자산 저장", removeStock: "종목 삭제", renameStock: "종목 이름 변경", resetStocks: "종목 가격 초기화",
  upsertProduct: "상품 저장", removeProduct: "상품 삭제", renameProduct: "상품 이름 변경",
  setBalance: "유저 잔고 수정", setUserItem: "유저 보유 상품 수정", setUsd: "유저 달러 수정",
  resetBalances: "잔고 초기화", resetUsd: "달러 초기화", resetBots: "봇 초기화", resetItems: "보유 상품 초기화",
  setAttendance: "출석 설정", setAnnounce: "가격 변동 알림 설정", setListing: "자동 상장 설정",
  setPassword: "관리자 비밀번호 변경", clearPassword: "관리자 비밀번호 되돌리기", purgeLogs: "오래된 로그 삭제",
};

async function handler(request) {
  const copy = request.clone(); // 본문은 한 번만 읽을 수 있어서 복사본으로 기록용 내용을 읽어요
  const response = await handle(request);
  try {
    const action = new URL(request.url).searchParams.get("action");
    if (request.method === "POST" && response.status === 200 && ADMIN_LABELS[action]) {
      const body = await copy.json().catch(() => ({}));
      const safe = action === "setPassword" || action === "clearPassword" ? "" : JSON.stringify(body).slice(0, 200);
      await logAction(env0(), { u: "admin", n: "관리자", cmd: ADMIN_LABELS[action], k: "관리자", a: safe, r: "성공" });
    }
  } catch (err) {
    console.error("관리자 작업 로그 실패:", err.message);
  }
  return response;
}

const env0 = () => loadEnv();

export default { fetch: handler };

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

// 많은 문서를 고칠 때 20개씩 나눠서 처리해요 (한꺼번에 너무 많이 보내면 실패할 수 있어서)
async function inChunks(list, fn, size = 20) {
  for (let i = 0; i < list.length; i += size) {
    await Promise.all(list.slice(i, i + size).map(fn));
  }
}

// ---------- 관리자 비밀번호 ----------
// 관리자 콘솔에서 바꾼 비밀번호는 Firebase(config/adminAuth)에 "암호화(해시)"해서 저장해요.
//  - 저장된 비밀번호가 있으면 그것만 통과해요. (Vercel의 ADMIN_PANEL_PASSWORD는 쓰지 않아요)
//  - 저장된 게 없으면 Vercel의 ADMIN_PANEL_PASSWORD 를 써요. (처음 상태, 또는 "기본으로 되돌리기" 한 뒤)
//  - 비밀번호를 잊었으면 Firebase에서 config/adminAuth 문서를 지우면 Vercel 값으로 돌아가요.
const AUTH_PATH = "config/adminAuth";
const PBKDF2_ROUNDS = 100_000;
// HTTP 헤더로 보내기 때문에 영문·숫자·기호(공백 없이)만 쓸 수 있어요. 한글은 안 돼요.
const PASSWORD_RULE = /^[\x21-\x7E]{6,64}$/;

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}

// 길이가 달라도 같은 시간이 걸리게 비교해요
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function isAdminRequest(request, env) {
  const given = request.headers.get("x-admin-password");
  if (!given) return false;

  let saved = null;
  try {
    saved = await getDoc(env, AUTH_PATH);
  } catch (err) {
    console.error("관리자 비밀번호 조회 실패:", err.message);
    return false; // 확인할 수 없으면 들여보내지 않아요
  }

  if (saved && saved.hash && saved.salt) {
    return safeEqual(await hashPassword(given, saved.salt), saved.hash);
  }
  if (!env.ADMIN_PANEL_PASSWORD) return false;
  return safeEqual(given, env.ADMIN_PANEL_PASSWORD);
}

async function handle(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const env = loadEnv();
  if (!(await isAdminRequest(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  let body = {};
  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      return json({ error: "잘못된 요청 본문입니다." }, 400);
    }
  }

  try {
    switch (action) {
      // ----- 관리자 비밀번호 -----
      // 새 비밀번호로 바꿔요. (이 요청을 보낸 사람은 이미 현재 비밀번호로 통과한 상태)
      case "setPassword": {
        const next = String(body.newPassword ?? "");
        if (!PASSWORD_RULE.test(next)) {
          return json({ error: "비밀번호는 영문·숫자·기호 6~64자(공백·한글 불가)여야 합니다." }, 400);
        }
        const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
        const hash = await hashPassword(next, salt);
        await setDoc(env, AUTH_PATH, { salt, hash, updatedAt: new Date() });
        return json({ ok: true });
      }

      // 콘솔에서 바꾼 비밀번호를 지우고, Vercel의 ADMIN_PANEL_PASSWORD 로 되돌려요.
      case "clearPassword": {
        await deleteDoc(env, AUTH_PATH);
        return json({ ok: true });
      }

      // ----- 활동 로그 -----
      // 최근 days일(1~7)의 로그를 최신순으로
      case "listLogs":
        return json(await listLogs(env, url.searchParams.get("days")));

      // keepDays일보다 오래된 로그 삭제
      case "purgeLogs": {
        const keepDays = Number(body.keepDays);
        if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365) {
          return json({ error: "보관 일수는 1~365 사이의 정수여야 합니다." }, 400);
        }
        return json({ ok: true, deleted: await purgeLogs(env, keepDays) });
      }

      // ----- 종목 (이름순) -----
      case "listStocks":
        return json(await listStocks(env));

      case "upsertStock": {
        const name = String(body.name || "").trim();
        const price = Number(body.price);
        if (!name) return json({ error: "종목 이름을 입력하세요." }, 400);
        if (!Number.isInteger(price) || price < 1) {
          return json({ error: "가격은 1 이상의 정수여야 합니다." }, 400);
        }
        await upsertStock(env, name, price);
        return json({ ok: true });
      }

      // 외국자산(코인 / 미국 주식) 추가 · 심볼·배율·상장가 수정
      // - kind: "crypto"(코인, 기본) 또는 "us"(미국 주식). 출처는 종류에 따라 자동으로 정해져요. (코인 CoinGecko / 미국 주식 Finnhub)
      // - 새로 만들면: 가격 = 상장가(startPrice)로 시작하고, 첫 시세를 기준 실제가로 삼아요. (기준은 다음 15분 변동 때 자동 기록)
      // - 이미 있는 외국자산에서 종류·심볼·상장가를 바꾸면: 가격을 새 상장가로 되돌리고 기준 실제가를 다시 잡아요.
      // - 배율만 바꾸면: 기준은 그대로라서 다음 변동 때 새 배율로 계산한 가격으로 바뀌어요. (가격이 한 번 튈 수 있어요)
      // - 일반 종목(외국자산이 아닌 종목) 이름으로는 만들 수 없어요. (일반 종목이 바뀌는 사고 방지)
      case "upsertForeign": {
        const name = String(body.name || "").trim();
        const kind = body.kind === undefined || body.kind === "" ? "crypto" : String(body.kind);
        const rawSymbol = String(body.symbol || "").trim();
        const mult = body.mult === undefined || body.mult === "" ? DEFAULT_MULT : Number(body.mult);
        const startPrice = body.startPrice === undefined || body.startPrice === "" ? FOREIGN_START_PRICE : Number(body.startPrice);
        if (!name) return json({ error: "종목 이름을 입력하세요." }, 400);
        if (!FOREIGN_KINDS.includes(kind)) return json({ error: "종류는 crypto(코인) 또는 us(미국 주식)여야 합니다." }, 400);
        // 코인은 입력한 그대로, 미국 주식 티커는 대문자로 저장해요
        const checked = symbolOfKind(kind, rawSymbol);
        if (!checked) {
          return json({
            error: kind === "us"
              ? "티커를 확인하세요. (영문 대문자로 시작하는 미국 주식 티커. 예: AAPL, TSLA, BRK.B)"
              : "심볼을 확인하세요. (예: BTC, ETH, SOL. 목록에 없는 코인은 CoinGecko 아이디를 그대로 적어요. 예: pepe)",
          }, 400);
        }
        const symbol = kind === "us" ? checked : rawSymbol;
        if (!Number.isFinite(mult) || mult <= 0 || mult > 20) {
          return json({ error: "배율은 0보다 크고 20 이하인 숫자여야 합니다. (1이면 실제와 똑같이, 3이면 3배로 움직여요)" }, 400);
        }
        if (!Number.isInteger(startPrice) || startPrice <= DELIST_PRICE) {
          return json({ error: `상장가는 ${DELIST_PRICE + 1} 이상의 정수여야 합니다. (${DELIST_PRICE}해정 이하는 바로 상장폐지돼요)` }, 400);
        }

        const old = await getStock(env, name);
        if (old && !isForeign(old)) {
          return json({ error: `"${name}"은(는) 이미 있는 일반 종목이라 외국자산으로 바꿀 수 없어요. 다른 이름을 쓰거나 일반 종목을 먼저 삭제하세요.` }, 400);
        }

        const sameBase = old && old.kind === kind && String(old.symbol).toUpperCase() === symbol.toUpperCase() && old.startPrice === startPrice;
        const extra = { kind, symbol, source: defaultSourceOf(kind), mult, startPrice };
        if (!old) {
          await upsertStock(env, name, startPrice, undefined, extra);
        } else if (sameBase) {
          // 배율만 바뀐 경우: 가격·기준은 그대로 둬요
          await upsertStock(env, name, old.price, old, extra);
        } else {
          // 종류·심볼·상장가가 바뀐 경우: 새 상장가에서 다시 시작
          await upsertStock(env, name, startPrice, old, { ...extra, baseReal: null, lastReal: null, quoteAt: null, stale: false });
        }
        // 미국 주식인데 시세 키가 없으면 알려줘요 (저장은 됐지만 시세를 못 받아요)
        const warning = kind === "us" && !env.FINNHUB_API_KEY
          ? "저장은 됐지만 Vercel에 FINNHUB_API_KEY 환경변수가 없어서 아직 시세를 못 받아요."
          : undefined;
        return json({ ok: true, created: !old, rebased: !!old && !sameBase, warning });
      }

      case "removeStock": {
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "종목 이름이 없습니다." }, 400);
        await removeStock(env, name);
        await ensureMinimumStocks(env);
        return json({ ok: true });
      }

      case "renameStock": {
        const from = String(body.from || "").trim();
        const to = String(body.to || "").trim();
        const price = Number(body.price);
        if (!from || !to) return json({ error: "기존 이름과 새 이름을 입력하세요." }, 400);
        if (from === to) return json({ error: "새 이름이 기존 이름과 같습니다." }, 400);
        const exists = await getStock(env, to);
        if (exists) return json({ error: `"${to}" 종목이 이미 있습니다.` }, 400);
        const old = await getStock(env, from); // 이름만 바꾸는 거라 상장일은 원래 종목 것을 이어받음
        // 외국자산(코인·해외주식)이면 종류·심볼·배율·기준 실제가 등도 새 문서로 옮겨요. (안 옮기면 일반 종목으로 변해요)
        const foreignExtra = isForeign(old)
          ? Object.fromEntries(FOREIGN_FIELDS.filter((k) => old[k] !== undefined && old[k] !== null).map((k) => [k, old[k]]))
          : {};
        await upsertStock(env, to, price, undefined, foreignExtra);
        if (old && Number.isFinite(old.listedAt)) {
          await setDoc(env, `stocks/${encodeURIComponent(to)}`, { listedAt: old.listedAt });
        }
        invalidateStocksCache();
        await removeStock(env, from);
        return json({ ok: true });
      }

      // 모든 종목을 정한 가격(해정)으로 초기화 (최고가·시세 기록도 그 가격에서 새로 시작)
      // price를 안 보내면 예전처럼 LISTING_PRICE(1000해정)로 해요.
      // 외국자산(코인·해외주식)은 그 가격을 새 상장가(startPrice)로 삼고, 지금 실제 시세를 새 기준(baseReal)으로 다시 잡아요.
      // (안 그러면 다음 변동 때 옛 기준 실제가로 계산돼서 가격이 원래대로 튀어요)
      case "resetStocks": {
        const price = body.price === undefined ? LISTING_PRICE : Number(body.price);
        if (!Number.isInteger(price) || price <= DELIST_PRICE) {
          return json({ error: `종목 가격은 ${DELIST_PRICE + 1} 이상의 정수여야 합니다. (${DELIST_PRICE}해정 이하는 바로 상장폐지돼요)` }, 400);
        }
        const stocks = await listStocks(env);
        const at = String(Date.now()).padStart(13, "0");
        await inChunks(stocks, (s) =>
          setDoc(env, `stocks/${encodeURIComponent(s.name)}`, {
            name: s.name,
            price,
            maxPrice: price,
            history: { [at]: price },
            updatedAt: new Date(),
            ...(isForeign(s)
              ? { startPrice: price, baseReal: Number.isFinite(s.lastReal) && s.lastReal > 0 ? s.lastReal : null }
              : {}),
          })
        );
        invalidateStocksCache();
        return json({ ok: true, count: stocks.length, price, foreign: stocks.filter(isForeign).length });
      }

      // 모든 유저의 잔고를 정한 금액(해정)으로 초기화
      case "resetBalances": {
        const balance = Number(body.balance);
        if (!Number.isInteger(balance) || balance < 0) {
          return json({ error: "잔고는 0 이상의 정수여야 합니다." }, 400);
        }
        const users = await listCollection(env, "users");
        await inChunks(users, (u) => setDoc(env, `users/${u.id}`, { balance }));
        return json({ ok: true, count: users.length, balance });
      }

      // 모든 유저의 달러 잔고를 정한 금액(달러 단위, 소수 가능)으로 초기화. 저장은 센트 정수예요.
      case "resetUsd": {
        const dollars = body.dollars === undefined ? 0 : Number(body.dollars);
        if (!Number.isFinite(dollars) || dollars < 0) {
          return json({ error: "달러는 0 이상의 숫자여야 합니다." }, 400);
        }
        const usd = Math.round(dollars * 100);
        const users = await listCollection(env, "users");
        await inChunks(users, (u) => setDoc(env, `users/${u.id}`, { usd }));
        return json({ ok: true, count: users.length, dollars, usd });
      }

      // AI 봇 초기화: 현금을 정한 금액으로, 보유 종목은 비움 (newPersonality=true면 성격도 새로 뽑기)
      // 봇은 users 컬렉션에 없어서 잔고 초기화와는 따로 해야 해요.
      case "resetBots": {
        const cash = Number(body.cash);
        if (!Number.isInteger(cash) || cash < 100) {
          return json({ error: "봇 현금은 100 이상의 정수여야 합니다. (100 미만이면 봇이 알아서 1000해정으로 다시 채워져요)" }, 400);
        }
        const result = await resetBots(env, cash, { newPersonality: body.newPersonality === true });
        return json({ ok: true, ...result });
      }

      // 모든 유저의 보유 상품 수량을 정한 개수로 맞춤 (0이면 제거)
      // name: 상품 이름 또는 "all"(전체 상품). all + 0 = 모든 보유 상품 비우기
      case "resetItems": {
        const name = String(body.name || "").trim();
        const count = body.count === undefined ? 0 : Number(body.count);
        if (!name) return json({ error: "상품을 골라주세요." }, 400);
        if (!Number.isInteger(count) || count < 0) {
          return json({ error: "수량은 0 이상의 정수여야 합니다." }, 400);
        }
        const users = await listCollection(env, "users");
        let products = [];
        if (name === "all" && count > 0) products = await listProducts(env);

        let changed = 0;
        await inChunks(users, async (u) => {
          let items = { ...(u.items || {}) };
          if (name === "all") {
            if (count === 0) items = {};
            else for (const p of products) items[p.name] = count;
          } else if (count === 0) {
            if (!(name in items)) return; // 원래 없던 유저는 건드리지 않음
            delete items[name];
          } else {
            items[name] = count;
          }
          await setDoc(env, `users/${u.id}`, { items });
          changed++;
        });
        return json({ ok: true, users: users.length, changed });
      }

      // ----- 상품 (가격 낮은 순) -----
      case "listProducts":
        return json(await listProducts(env));

      case "upsertProduct": {
        const name = String(body.name || "").trim();
        const price = Number(body.price);
        const description = String(body.description || "").trim();
        if (!name) return json({ error: "상품 이름을 입력하세요." }, 400);
        if (!Number.isInteger(price) || price < 1) {
          return json({ error: "가격은 1 이상의 정수여야 합니다." }, 400);
        }
        await upsertProduct(env, name, price, description);
        return json({ ok: true });
      }

      case "removeProduct": {
        const name = String(body.name || "").trim();
        if (!name) return json({ error: "상품 이름이 없습니다." }, 400);
        await removeProduct(env, name);
        return json({ ok: true });
      }

      case "renameProduct": {
        const from = String(body.from || "").trim();
        const to = String(body.to || "").trim();
        const price = Number(body.price);
        const description = String(body.description || "").trim();
        if (!from || !to) return json({ error: "기존 이름과 새 이름을 입력하세요." }, 400);
        if (from === to) return json({ error: "새 이름이 기존 이름과 같습니다." }, 400);
        if (!Number.isInteger(price) || price < 1) {
          return json({ error: "가격은 1 이상의 정수여야 합니다." }, 400);
        }
        const exists = await getProduct(env, to);
        if (exists) return json({ error: `"${to}" 상품이 이미 있습니다.` }, 400);
        await upsertProduct(env, to, price, description);
        await removeProduct(env, from);
        return json({ ok: true });
      }

      // ----- 유저 (잔고 높은 순) -----
      case "listUsers": {
        const users = await listCollection(env, "users");
        users.sort((a, b) => (b.balance || 0) - (a.balance || 0));
        return json(users);
      }

      case "setBalance": {
        const userId = String(body.userId || "");
        const balance = Number(body.balance);
        if (!userId) return json({ error: "userId가 없습니다." }, 400);
        if (!Number.isFinite(balance) || balance < 0) {
          return json({ error: "잔고는 0 이상의 숫자여야 합니다." }, 400);
        }
        const user = await getUser(env, userId);
        user.balance = Math.round(balance);
        await saveUser(env, userId, user);
        return json({ ok: true });
      }

      // 유저 1명의 달러 잔고 수정 (dollars: 달러 단위, 소수 가능 / 저장은 센트 정수)
      case "setUsd": {
        const userId = String(body.userId || "");
        const dollars = Number(body.dollars);
        if (!userId) return json({ error: "userId가 없습니다." }, 400);
        if (!Number.isFinite(dollars) || dollars < 0) {
          return json({ error: "달러는 0 이상의 숫자여야 합니다." }, 400);
        }
        const user = await getUser(env, userId);
        user.usd = Math.round(dollars * 100);
        await saveUser(env, userId, user);
        return json({ ok: true, usd: user.usd });
      }

      case "setUserItem": {
        const userId = String(body.userId || "");
        const name = String(body.name || "").trim();
        const count = Number(body.count);
        if (!userId || !name) return json({ error: "userId와 상품 이름이 필요합니다." }, 400);
        if (!Number.isInteger(count) || count < 0) {
          return json({ error: "수량은 0 이상의 정수여야 합니다." }, 400);
        }
        await setUserItem(env, userId, name, count);
        return json({ ok: true });
      }

      // ----- 출석 -----
      case "getAttendance":
        return json(await getAttendanceConfig(env));

      case "setAttendance": {
        const reward = body.reward === undefined ? undefined : Number(body.reward);
        if (reward !== undefined && (!Number.isInteger(reward) || reward < 0)) {
          return json({ error: "보상은 0 이상의 정수여야 합니다." }, 400);
        }
        const enabled = body.enabled === undefined ? undefined : Boolean(body.enabled);
        return json(await setAttendanceConfig(env, { enabled, reward }));
      }

      // ----- 가격 변동 공지 (주식채널) -----
      case "getAnnounce":
        return json(await getAnnounceConfig(env));

      case "setAnnounce": {
        if (typeof body.enabled !== "boolean") {
          return json({ error: "enabled는 true/false여야 합니다." }, 400);
        }
        return json(await setAnnounceConfig(env, { enabled: body.enabled }));
      }

      // ----- 자동 상장 설정 -----
      case "getListing":
        return json(await getListingConfig(env));

      case "setListing": {
        const patch = {};
        for (const key of ["triggerCount", "addCount", "dailyLimit"]) {
          if (body[key] === undefined) continue;
          const v = Number(body[key]);
          if (!Number.isInteger(v) || v < 0) {
            return json({ error: "기준 종목 수·추가 수·하루 횟수는 0 이상의 정수여야 합니다." }, 400);
          }
          patch[key] = v;
        }
        if (body.names !== undefined) patch.names = parseNames(body.names).join("\n");
        if (body.keepNames !== undefined) {
          if (typeof body.keepNames !== "boolean") {
            return json({ error: "keepNames는 true/false여야 합니다." }, 400);
          }
          patch.keepNames = body.keepNames;
        }
        return json(await setListingConfig(env, patch));
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}