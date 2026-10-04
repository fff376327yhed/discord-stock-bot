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
// (토큰은 1시간 유효 — 매 요청마다 새로 발급받는 단순 구조. 트래픽이 커지면 캐싱을 추가하세요.)
async function getAccessToken(env) {
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
  return data.access_token;
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
  const res = await fetch(`${baseUrl(env)}/${collection}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Firestore 목록 조회 실패: ${await res.text()}`);
  const data = await res.json();
  if (!data.documents) return [];
  return data.documents.map((doc) => ({
    id: doc.name.split("/").pop(),
    ...fromFields(doc.fields),
  }));
}

export { getDoc, setDoc, deleteDoc, listCollection };
