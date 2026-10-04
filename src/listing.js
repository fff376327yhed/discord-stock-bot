import { getDoc, setDoc, listCollection } from "./firebase.js";

// ---------- 자동 상장 / 유저 상장 설정 (관리자 콘솔 '자동 상장 설정') ----------
// config/listing 문서: { triggerCount, addCount, dailyLimit, names }
//  - triggerCount: 종목 수가 이 값 이하가 되면 자동 상장
//  - addCount: 한 번에 자동 상장할 종목 수
//  - dailyLimit: 유저가 하루에 /종목생성 할 수 있는 횟수
//  - names: 자동 상장에 쓸 이름 목록 (줄바꿈 구분). 쓰인 이름은 목록에서 빠집니다.
export const LISTING_PATH = "config/listing";
export const LISTING_PRICE = 1000; // 자동 상장/유저 상장 종목의 고정 가격 (해정)
const DEFAULT_LISTING = { triggerCount: 5, addCount: 15, dailyLimit: 3, names: "" };

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

  const existing = new Set(stocks.map((s) => s.name));
  const pool = parseNames(cfg.names).filter((n) => !existing.has(n));
  const picked = pool.slice(0, cfg.addCount);
  if (picked.length === 0) return { added: [], reason: "이름 목록이 비어 있어요" };

  for (const name of picked) {
    try {
      await createStock(env, name, LISTING_PRICE);
    } catch (err) {
      console.error(`자동 상장 실패 (${name}):`, err.message);
    }
  }

  // 쓴 이름은 목록에서 빼고 저장 (다음 자동 상장 때 중복 방지)
  const rest = parseNames(cfg.names).filter((n) => !picked.includes(n));
  await setDoc(env, LISTING_PATH, { names: rest.join("\n") });
  return { added: picked };
}
