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
import { listCollection } from "../../src/firebase.js";
import { getAttendanceConfig, setAttendanceConfig } from "../../src/attendance.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export default { fetch: handler };

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
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
      // ----- 종목 -----
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
        await upsertStock(env, to, price);
        await removeStock(env, from);
        return json({ ok: true });
      }

      // ----- 상품 -----
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

      // ----- 유저 -----
      case "listUsers":
        return json(await listCollection(env, "users"));

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

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}