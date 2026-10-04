import { getUser, saveUser, addHistory } from "./economy.js";

// ---------- 튜닝 상수 ----------
const STAMINA_BASE = 10;          // Lv1 최대 체력
const STAMINA_PER_LEVEL = 2;      // 레벨당 최대 체력 증가량
const STAMINA_REGEN_MINUTES = 6;  // 체력 1 회복에 걸리는 시간(분)

const REWARD_BASE_MIN = 15;       // Lv1 채굴 보상 최소
const REWARD_BASE_MAX = 35;       // Lv1 채굴 보상 최대
const REWARD_PER_LEVEL = 8;       // 레벨당 보상 증가량(최소/최대 동일하게)

const UPGRADE_BASE_COST = 500;    // Lv1→2 업그레이드 비용(해정)
const UPGRADE_COST_GROWTH = 1.6;  // 레벨마다 비용 배율

const UPGRADE_BASE_COUNT = 15;    // 노가다로 무료 업그레이드하려면 필요한 채굴 횟수(Lv1 기준)
const UPGRADE_COUNT_GROWTH = 5;   // 레벨마다 필요 횟수 증가량

function staminaMaxFor(level) {
  return STAMINA_BASE + (level - 1) * STAMINA_PER_LEVEL;
}

function rewardRangeFor(level) {
  return {
    min: REWARD_BASE_MIN + (level - 1) * REWARD_PER_LEVEL,
    max: REWARD_BASE_MAX + (level - 1) * REWARD_PER_LEVEL,
  };
}

function upgradeCostFor(level) {
  return Math.round(UPGRADE_BASE_COST * Math.pow(UPGRADE_COST_GROWTH, level - 1));
}

function upgradeCountFor(level) {
  return UPGRADE_BASE_COUNT + (level - 1) * UPGRADE_COUNT_GROWTH;
}

// 유저 문서에 채굴 상태가 없으면 기본값으로 생성
function ensureMining(user) {
  if (!user.mining) {
    user.mining = { level: 1, stamina: STAMINA_BASE, staminaAt: Date.now(), count: 0 };
  }
  return user.mining;
}

// 경과 시간만큼 체력을 회복시킴 (남은 시간은 staminaAt에 이월해서 손해 없게 함)
function regenStamina(mining) {
  const max = staminaMaxFor(mining.level);
  if (mining.stamina >= max) {
    mining.staminaAt = Date.now();
    return mining;
  }
  const regenMs = STAMINA_REGEN_MINUTES * 60 * 1000;
  const elapsed = Date.now() - mining.staminaAt;
  const gained = Math.floor(elapsed / regenMs);
  if (gained <= 0) return mining;

  const next = Math.min(max, mining.stamina + gained);
  mining.staminaAt = next >= max ? Date.now() : mining.staminaAt + gained * regenMs;
  mining.stamina = next;
  return mining;
}

// 체력이 다음 1칸 찰 때까지 남은 시간(분)
function minutesUntilNextRegen(mining) {
  const regenMs = STAMINA_REGEN_MINUTES * 60 * 1000;
  const waitMs = regenMs - (Date.now() - mining.staminaAt);
  return Math.max(1, Math.ceil(waitMs / 60000));
}

// ---------- 채굴 1회 ----------
export async function mineOnce(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  const max = staminaMaxFor(mining.level);

  if (mining.stamina < 1) {
    await saveUser(env, userId, user); // 회복된 staminaAt은 반영
    return {
      ok: false,
      message: `⛏️ 체력이 없어요. (${mining.stamina}/${max})\n약 ${minutesUntilNextRegen(mining)}분 후 체력이 1 회복돼요.`,
    };
  }

  const { min, max: rewardMax } = rewardRangeFor(mining.level);
  const reward = Math.round(min + Math.random() * (rewardMax - min));
  const balanceBefore = user.balance;

  mining.stamina -= 1;
  mining.count += 1;
  user.balance += reward;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(env, userId, `채굴: +${reward.toLocaleString()}해정 (Lv.${mining.level}, 체력 ${mining.stamina}/${max})`),
  ]);

  const required = upgradeCountFor(mining.level);
  return {
    ok: true,
    message: [
      `⛏️ 채굴 완료! +${reward.toLocaleString()}해정`,
      `💰 잔고: ${balanceBefore.toLocaleString()} → **${user.balance.toLocaleString()}해정**`,
      `🔋 체력: ${mining.stamina}/${max}`,
      `📈 Lv.${mining.level} 진행도: ${mining.count}/${required}회 (채우면 무료 업그레이드 가능)`,
    ].join("\n"),
  };
}

// ---------- 업그레이드 ----------
export async function upgradeMining(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  const cost = upgradeCostFor(mining.level);
  const required = upgradeCountFor(mining.level);

  const canGrind = mining.count >= required;
  const canPay = user.balance >= cost;

  if (!canGrind && !canPay) {
    await saveUser(env, userId, user);
    return {
      ok: false,
      message: [
        `⛏️ Lv.${mining.level} → Lv.${mining.level + 1} 업그레이드 조건이 부족해요.`,
        `- 해정으로: ${cost.toLocaleString()}해정 필요 (보유 ${user.balance.toLocaleString()}해정)`,
        `- 노가다로: 이번 레벨에서 ${required}회 채굴 필요 (현재 ${mining.count}/${required})`,
      ].join("\n"),
    };
  }

  // 조건을 둘 다 채웠으면 노가다(무료) 쪽을 우선 적용
  const paidWithMoney = !canGrind && canPay;
  if (paidWithMoney) user.balance -= cost;

  const fromLevel = mining.level;
  mining.level += 1;
  mining.count = 0;

  await Promise.all([
    saveUser(env, userId, user),
    addHistory(
      env,
      userId,
      paidWithMoney
        ? `채굴장 업그레이드: Lv.${fromLevel} → Lv.${mining.level} (-${cost.toLocaleString()}해정)`
        : `채굴장 업그레이드: Lv.${fromLevel} → Lv.${mining.level} (노가다 달성, 무료)`
    ),
  ]);

  return {
    ok: true,
    message: [
      `🎉 채굴장을 Lv.${mining.level}로 업그레이드했어요!${paidWithMoney ? ` (-${cost.toLocaleString()}해정)` : " (노가다 조건 달성, 무료)"}`,
      `🔋 최대 체력: ${staminaMaxFor(mining.level)}`,
    ].join("\n"),
  };
}

// ---------- 정보 조회 ----------
export async function getMiningInfo(env, userId) {
  const user = await getUser(env, userId);
  const mining = regenStamina(ensureMining(user));
  await saveUser(env, userId, user); // 회복된 staminaAt 반영

  const max = staminaMaxFor(mining.level);
  const { min, max: rewardMax } = rewardRangeFor(mining.level);
  const cost = upgradeCostFor(mining.level);
  const required = upgradeCountFor(mining.level);
  const nextIn = mining.stamina >= max ? "가득 참" : `약 ${minutesUntilNextRegen(mining)}분 후 +1`;

  return [
    `**⛏️ 채굴장 정보 (Lv.${mining.level})**`,
    `체력: ${mining.stamina}/${max} (${nextIn})`,
    `1회 채굴 보상: ${min.toLocaleString()} ~ ${rewardMax.toLocaleString()}해정`,
    `다음 업그레이드 (Lv.${mining.level + 1}):`,
    `- 해정으로: ${cost.toLocaleString()}해정`,
    `- 노가다로: ${required}회 채굴 (현재 ${mining.count}/${required})`,
  ].join("\n");
}