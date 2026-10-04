import { loadEnv } from "../../src/env.js";
import {
  listStocks,
  upsertStock,
  removeStock,
  getUser,
  saveUser,
  listCollection,
} from "../../src/economy.js";

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
  // 브라우저의 사전 확인(OPTIONS) 요청에 응답
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

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}