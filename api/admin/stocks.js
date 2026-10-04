import { loadEnv } from "../../src/env.js";
import { listStocks, upsertStock, removeStock, getUser, saveUser, listCollection } from "../../src/economy.js";

export default { fetch: handler };

function isAdminRequest(request, env) {
  if (!env.ADMIN_PANEL_PASSWORD) return false;
  return request.headers.get("x-admin-password") === env.ADMIN_PANEL_PASSWORD;
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

async function handler(request) {
  const env = loadEnv();
  if (!isAdminRequest(request, env)) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const body = request.method === "POST" ? await request.json() : {};

  try {
    switch (action) {
      case "listStocks":
        return json(await listStocks(env));

      case "upsertStock":
        await upsertStock(env, body.name, Number(body.price));
        return json({ ok: true });

      case "removeStock":
        await removeStock(env, body.name);
        return json({ ok: true });

      case "listUsers":
        return json(await listCollection(env, "users"));

      case "setBalance": {
        const user = await getUser(env, body.userId);
        user.balance = Number(body.balance);
        await saveUser(env, body.userId, user);
        return json({ ok: true });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}