// 7일 송금·거래 한도 (파산 악용 방지용)
// - /송금, /거래제안, /거래수락, /입찰, 경매 낙찰이 모두 "같은 한도"를 같이 써요.
// - 계산만 하는 파일이라 다른 파일을 가져오지 않아요. (lib.js와 market.js가 같이 써도 서로 꼬이지 않아요)
// - 기록은 유저 문서의 xfer 칸에 "시각_랜덤: 금액" 모양으로 쌓고, 7일이 지난 기록은 저장할 때 알아서 지워요.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const WEEK_LIMIT = 숫자; // 7일 동안 보내거나 거래할 수 있는 합계 (해정). 숫자만 바꾸면 돼요.

const timeOf = (key) => Number(String(key).split("_")[0]);

// 최근 7일 동안 쓴 금액 합계
export function weeklyUsed(user, now = Date.now()) {
  let sum = 0;
  for (const [k, v] of Object.entries(user.xfer || {})) {
    if (now - timeOf(k) < WEEK_MS && Number.isFinite(v)) sum += v;
  }
  return sum;
}

export const weeklyLeft = (user, now = Date.now()) => Math.max(0, WEEK_LIMIT - weeklyUsed(user, now));

// 이번에 amount만큼 쓰면 한도를 넘는지: 넘으면 안내 문장, 괜찮으면 null
export function weeklyBlockText(user, amount, now = Date.now()) {
  const used = weeklyUsed(user, now);
  if (used + amount <= WEEK_LIMIT) return null;
  return [
    `🛡️ **7일 송금·거래 한도**를 넘어요. (파산 악용을 막으려고 둔 한도예요)`,
    `• 한도 ${WEEK_LIMIT.toLocaleString()}해정 · 최근 7일 사용 ${used.toLocaleString()}해정 · 이번 ${amount.toLocaleString()}해정`,
    `• 남은 한도: ${Math.max(0, WEEK_LIMIT - used).toLocaleString()}해정`,
  ].join("\n");
}

// user 객체에 기록을 더해요. (저장은 부른 쪽에서 해요)
export function weeklyAdd(user, amount, now = Date.now()) {
  const next = {};
  for (const [k, v] of Object.entries(user.xfer || {})) {
    if (now - timeOf(k) < WEEK_MS) next[k] = v; // 7일 지난 건 버려요
  }
  next[`${String(now).padStart(13, "0")}_${Math.random().toString(36).slice(2, 6)}`] = Math.round(amount);
  user.xfer = next;
}