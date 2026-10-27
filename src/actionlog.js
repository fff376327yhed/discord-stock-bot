import { listCollection, setDoc, deleteDoc } from "./firebase.js";

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
]);

// 명령어 이름 -> 분류 (관리자 콘솔의 분류 선택칸에 그대로 나와요)
const CATEGORY = {
  매수: "매수",
  매도: "매도",
  구입: "상품구입",
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
