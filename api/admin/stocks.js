import { loadEnv } from "../../src/env.js";
import {
  listStocks,
  upsertStock,
  removeStock,
  getStock,
  getUser,
  saveUser,
  listProducts,
  upsertProduct,
  removeProduct,
  getProduct,
  setUserItem,
} from "../../src/economy.js";
import { listCollection, setDoc } from "../../src/firebase.js";
import { DELIST_PRICE } from "../../src/economy.js";
import { resetBots } from "../../src/crowd.js";
import { getAttendanceConfig, setAttendanceConfig } from "../../src/attendance.js";
import { getAnnounceConfig, setAnnounceConfig } from "../../src/notify.js";
import { getListingConfig, setListingConfig, parseNames, ensureMinimumStocks, LISTING_PRICE } from "../../src/listing.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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

function isAdminRequest(request, env) {
  if (!env.ADMIN_PANEL_PASSWORD) return false;
  return request.headers.get("x-admin-password") === env.ADMIN_PANEL_PASSWORD;
}

async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const env = loadEnv();
  if (!isAdminRequest(request, env)) {
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
        await upsertStock(env, to, price);
        if (old && Number.isFinite(old.listedAt)) {
          await setDoc(env, `stocks/${encodeURIComponent(to)}`, { listedAt: old.listedAt });
        }
        await removeStock(env, from);
        return json({ ok: true });
      }

      // 모든 종목을 정한 가격(해정)으로 초기화 (최고가·시세 기록도 그 가격에서 새로 시작)
      // price를 안 보내면 예전처럼 LISTING_PRICE(1000해정)로 해요.
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
          })
        );
        return json({ ok: true, count: stocks.length, price });
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