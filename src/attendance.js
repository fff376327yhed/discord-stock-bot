import { getDoc, setDoc } from "./firebase.js";
import { getUser, saveUser } from "./economy.js";

const CONFIG_PATH = "config/attendance";
const DEFAULT_CONFIG = { enabled: true, reward: 100 };

// 한국 날짜 기준 YYYY-MM-DD
export function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function getAttendanceConfig(env) {
  const saved = await getDoc(env, CONFIG_PATH);
  return { ...DEFAULT_CONFIG, ...(saved || {}) };
}

// enabled, reward 중 넘어온 값만 바꾸고 나머지는 유지
export async function setAttendanceConfig(env, { enabled, reward }) {
  const current = await getAttendanceConfig(env);
  const next = {
    enabled: enabled ?? current.enabled,
    reward: reward ?? current.reward,
  };
  await setDoc(env, CONFIG_PATH, next);
  return next;
}

export async function checkAttendance(env, userId) {
  const config = await getAttendanceConfig(env);
  if (!config.enabled) {
    return { ok: false, message: "지금은 출석체크가 꺼져 있어요." };
  }

  const user = await getUser(env, userId);
  const today = todayKST();
  if (user.lastAttendance === today) {
    return { ok: false, message: "오늘은 이미 출석체크를 했어요. 내일 다시 와 주세요!" };
  }

  user.balance += config.reward;
  user.lastAttendance = today;
  user.attendanceCount = (user.attendanceCount || 0) + 1;
  await saveUser(env, userId, user);

  return {
    ok: true,
    message: `출석 완료! +${config.reward.toLocaleString()}해정을 받았어요. (누적 ${user.attendanceCount}일)`,
  };
}