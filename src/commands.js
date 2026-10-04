import {
  listStocks,
  upsertStock,
  removeStock,
  getUser,
  buyStock,
  sellStock,
  getRanking,
  getUserDetail,
  listProducts,
  buyProduct,
  setNotify,
} from "./economy.js";
import {
  checkAttendance,
  getAttendanceConfig,
  setAttendanceConfig,
} from "./attendance.js";

// ---- 1) Discord에 등록할 커맨드 정의 ----
export const commandDefinitions = [
  { name: "도움말", description: "사용할 수 있는 명령어 목록을 봅니다." },
  { name: "출석체크", description: "오늘 출석하고 해정을 받습니다. 하루 1회." },
  { name: "주식목록", description: "현재 거래 가능한 종목과 가격을 봅니다." },
  { name: "잔고", description: "내 해정 잔고와 보유 종목을 봅니다." },
  { name: "내정보", description: "내 잔고, 보유 종목 평가액, 총자산, 순위를 한 번에 봅니다." },
  { name: "랭킹", description: "총 자산 기준 랭킹을 봅니다." },
  {
    name: "매수",
    description: "종목을 매수합니다.",
    options: [
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "수량", description: "매수할 수량", type: 4, required: true },
    ],
  },
  {
    name: "매도",
    description: "종목을 매도합니다.",
    options: [
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "수량", description: "매도할 수량", type: 4, required: true },
    ],
  },
  { name: "상점", description: "구입할 수 있는 상품 목록을 봅니다." },
  {
    name: "구입",
    description: "상점에서 상품을 구입합니다.",
    options: [{ name: "상품", description: "상품 이름", type: 3, required: true }],
  },
  { name: "보유상품", description: "내가 구입한 상품 목록을 봅니다." },
  {
    name: "알림설정",
    description: "시세 알림을 켜고 끕니다. 여러 개를 동시에 켤 수 있어요.",
    options: [
      { name: "전체", description: "모든 종목 시세 변동 알림", type: 5, required: false },
      { name: "상승", description: "내가 보유한 종목이 오를 때 알림", type: 5, required: false },
      { name: "하락", description: "내가 보유한 종목이 내릴 때 알림", type: 5, required: false },
    ],
  },
  { name: "알림확인", description: "현재 알림 설정을 봅니다." },
  {
    name: "종목추가",
    description: "[관리자] 새 종목을 등록합니다.",
    options: [
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "가격", description: "초기 가격(해정)", type: 4, required: true },
    ],
  },
  {
    name: "종목삭제",
    description: "[관리자] 종목을 삭제합니다.",
    options: [{ name: "종목", description: "종목 이름", type: 3, required: true }],
  },
  {
    name: "시세설정",
    description: "[관리자] 종목 가격을 변경합니다.",
    options: [
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "가격", description: "새 가격(해정)", type: 4, required: true },
    ],
  },
  {
    name: "출석설정",
    description: "[관리자] 출석 보상과 출석체크 사용 여부를 설정합니다.",
    options: [
      { name: "보상", description: "출석 보상(해정)", type: 4, required: false },
      { name: "활성화", description: "출석체크 켜기/끄기", type: 5, required: false },
    ],
  },
];

// ---- 2) 옵션 파싱 헬퍼 ----
function opt(interaction, name) {
  const found = interaction.data.options?.find((o) => o.name === name);
  return found?.value;
}

function isAdmin(interaction, env) {
  return interaction.member?.user?.id === env.ADMIN_DISCORD_ID;
}

function notifyStatusText(s, title) {
  const mark = (on) => (on ? "✅ 켜짐" : "❌ 꺼짐");
  return [
    `**${title}**`,
    `- 전체 시세 변동: ${mark(s.all)}`,
    `- 내 보유 종목 상승: ${mark(s.up)}`,
    `- 내 보유 종목 하락: ${mark(s.down)}`,
  ].join("\n");
}

function helpText() {
  const user = [];
  const admin = [];
  for (const c of commandDefinitions) {
    const line = `\`/${c.name}\` — ${c.description}`;
    (c.description.includes("[관리자]") ? admin : user).push(line);
  }
  return [
    "**📖 해정 봇 도움말**",
    "",
    "**일반 명령어**",
    ...user,
    "",
    "**관리자 명령어**",
    ...admin,
  ].join("\n");
}

// ---- 3) 커맨드별 핸들러: (interaction, env) => Promise<string> ----
export const handlers = {
  도움말: async () => helpText(),

  출석체크: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await checkAttendance(env, userId);
    return result.message;
  },

  주식목록: async (_interaction, env) => {
    const stocks = await listStocks(env);
    if (stocks.length === 0) return "등록된 종목이 없어요. 관리자가 `/종목추가`로 등록할 수 있어요.";
    return stocks
      .map((s) => `**${s.name}** — ${s.price.toLocaleString()}해정`)
      .join("\n");
  },

  잔고: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const holdingsText = Object.entries(user.holdings)
      .map(([name, qty]) => `- ${name}: ${qty}주`)
      .join("\n") || "(보유 종목 없음)";
    return `잔고: **${user.balance.toLocaleString()}해정**\n${holdingsText}`;
  },

  내정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const detail = await getUserDetail(env, userId);

    const holdingsText = detail.holdings
      .map((h) => `- ${h.name}: ${h.qty}주 (현재가 ${h.price.toLocaleString()}해정, 평가금 ${h.value.toLocaleString()}해정)`)
      .join("\n") || "(보유 종목 없음)";

    const rankText = detail.rank > 0 ? `${detail.rank}위 / ${detail.totalUsers}명` : "(순위 없음)";

    return [
      "**내 상세정보**",
      `현금 잔고: ${detail.balance.toLocaleString()}해정`,
      `보유 종목 평가액: ${detail.holdingsValue.toLocaleString()}해정`,
      `총 자산: ${detail.totalAsset.toLocaleString()}해정`,
      `전체 순위: ${rankText}`,
      "",
      "보유 종목:",
      holdingsText,
    ].join("\n");
  },

  랭킹: async (_interaction, env) => {
    const ranking = await getRanking(env);
    if (ranking.length === 0) return "아직 랭킹 데이터가 없어요.";
    return ranking
      .slice(0, 10)
      .map((r, i) => `${i + 1}위 — <@${r.id}> (${r.total.toLocaleString()}해정)`)
      .join("\n");
  },

  매수: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = opt(interaction, "종목");
    const qty = opt(interaction, "수량");
    if (qty <= 0) return "수량은 1 이상이어야 해요.";
    const result = await buyStock(env, userId, name, qty);
    return result.message;
  },

  매도: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = opt(interaction, "종목");
    const qty = opt(interaction, "수량");
    if (qty <= 0) return "수량은 1 이상이어야 해요.";
    const result = await sellStock(env, userId, name, qty);
    return result.message;
  },

  상점: async (_interaction, env) => {
    const products = await listProducts(env);
    if (products.length === 0) return "판매 중인 상품이 없어요.";
    return products
      .map((p) => `**${p.name}** — ${p.price.toLocaleString()}해정${p.description ? `\n> ${p.description}` : ""}`)
      .join("\n");
  },

  구입: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = opt(interaction, "상품");
    const result = await buyProduct(env, userId, name);
    return result.message;
  },

  보유상품: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const entries = Object.entries(user.items);
    if (entries.length === 0) return "보유한 상품이 없어요. `/상점`에서 구경해 보세요.";
    return entries.map(([name, count]) => `- ${name} x${count}`).join("\n");
  },

  알림설정: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const current = user.notify || { all: false, up: false, down: false };

    const next = {
      all: opt(interaction, "전체") ?? current.all,
      up: opt(interaction, "상승") ?? current.up,
      down: opt(interaction, "하락") ?? current.down,
    };
    await setNotify(env, userId, next);
    return notifyStatusText(next, "알림 설정을 저장했어요.");
  },

  알림확인: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    return notifyStatusText(user.notify || { all: false, up: false, down: false }, "현재 알림 설정");
  },

  종목추가: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const name = opt(interaction, "종목");
    const price = opt(interaction, "가격");
    await upsertStock(env, name, price);
    return `"${name}" 종목을 ${price.toLocaleString()}해정에 등록했어요.`;
  },

  종목삭제: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const name = opt(interaction, "종목");
    await removeStock(env, name);
    return `"${name}" 종목을 삭제했어요.`;
  },

  시세설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const name = opt(interaction, "종목");
    const price = opt(interaction, "가격");
    await upsertStock(env, name, price);
    return `"${name}" 가격을 ${price.toLocaleString()}해정으로 변경했어요.`;
  },

  출석설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";

    const reward = opt(interaction, "보상");
    const enabled = opt(interaction, "활성화");

    if (reward !== undefined && (!Number.isInteger(reward) || reward < 0)) {
      return "보상은 0 이상의 정수여야 해요.";
    }

    const next = await setAttendanceConfig(env, { enabled, reward });
    return [
      "**출석 설정을 저장했어요.**",
      `- 상태: ${next.enabled ? "✅ 켜짐" : "❌ 꺼짐"}`,
      `- 보상: ${next.reward.toLocaleString()}해정`,
    ].join("\n");
  },
};