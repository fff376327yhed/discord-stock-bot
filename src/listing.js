import { getDoc, setDoc, listCollection } from "./firebase.js";

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
