import {
  listStocks,
  listDelisted,
  getDelistedHistory,
  getPriceHistory,
  getStock,
  upsertStock,
  removeStock,
  getUser,
  saveUser,
  addHistory,
  buyStock,
  sellStock,
  getRanking,
  getUserDetail,
  listProducts,
  buyProduct,
  setNotify,
  getHistory,
  compareKo,
  costOf,
  previewBuy,
  previewSell,
  profitLabel,
  fmtSigned,
  UP_MARK,
  DOWN_MARK,
  dangerTag,
} from "./economy.js";
import {
  checkAttendance,
  getAttendanceConfig,
  setAttendanceConfig,
} from "./attendance.js";
import { mineOnce, upgradeMining, getMiningInfo } from "./mining.js";
import { getListingConfig, LISTING_PRICE, ensureMinimumStocks } from "./listing.js";
import { renderStockChart } from "./chart.js";

// ---- 1) Discord에 등록할 커맨드 정의 ----
// autocomplete: true 인 옵션은 칸을 누르기만 해도 예시 목록이 떠요. 목록에 없는 값도 직접 입력할 수 있어요.
export const commandDefinitions = [
  { name: "도움말", description: "사용할 수 있는 명령어 목록을 봅니다." },
  { name: "출석체크", description: "오늘 출석하고 해정을 받습니다. 하루 1회." },
  { name: "채굴", description: "채굴장에서 노가다로 해정을 법니다. (체력 소모, 효율은 주식보다 낮아요)" },
  { name: "채굴정보", description: "내 채굴 레벨, 체력, 다음 업그레이드 조건을 봅니다." },
  { name: "채굴업그레이드", description: "채굴 장비를 업그레이드합니다. (해정 지불 또는 노가다 조건 달성)" },
  { name: "주식목록", description: "현재 거래 가능한 종목과 가격을 봅니다. (이름순)" },
  {
    name: "그래프",
    description: "종목의 시세 그래프를 그립니다.",
    options: [
      { name: "종목", description: "그래프를 볼 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: "상장폐지종류",
    description: "상장폐지된 종목과 하락률을 봅니다. 종목을 고르면 시세 그래프도 그려요. (최신순)",
    options: [
      { name: "종목", description: "그래프를 볼 폐지 종목 (안 고르면 목록)", type: 3, required: false, autocomplete: true },
      { name: "개수", description: "볼 종목 개수 (기본 10, 최대 20)", type: 4, required: false, autocomplete: true },
    ],
  },
  { name: "잔고", description: "내 해정 잔고와 보유 종목을 봅니다." },
  { name: "내정보", description: "내 잔고, 보유 종목 평가액, 총자산, 순위를 한 번에 봅니다." },
  { name: "랭킹", description: "총 자산 기준 랭킹을 봅니다." },
  {
    name: "내역",
    description: "내 최근 거래·출석 기록을 봅니다.",
    options: [
      { name: "개수", description: "볼 기록 개수 (기본 10, 최대 30)", type: 4, required: false, autocomplete: true },
    ],
  },
  {
    name: "매수",
    description: "종목을 매수합니다. 수량을 안 쓰면 1주예요.",
    options: [
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "매수할 수량 (기본 1, '최대'는 살 수 있는 만큼)", type: 4, required: false, autocomplete: true },
    ],
  },
  {
    name: "매도",
    description: "종목을 매도합니다. 수량을 안 쓰면 1주예요.",
    options: [
      { name: "종목", description: "내가 가진 종목 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "수량", description: "매도할 수량 (기본 1, '전량'은 보유 전부)", type: 4, required: false, autocomplete: true },
    ],
  },
  { name: "상점", description: "구입할 수 있는 상품 목록을 봅니다. (가격 낮은 순)" },
  {
    name: "구입",
    description: "상점에서 상품을 구입합니다.",
    options: [
      { name: "상품", description: "상품 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
    ],
  },
  { name: "보유상품", description: "내가 구입한 상품 목록을 봅니다." },
  {
    name: "알림설정",
    description: "시세 알림과 받을 시간대를 설정합니다. 여러 개를 동시에 켤 수 있어요.",
    options: [
      { name: "전체", description: "모든 종목 시세 변동 알림", type: 5, required: false },
      { name: "상승", description: "내가 보유한 종목이 오를 때 알림", type: 5, required: false },
      { name: "하락", description: "내가 보유한 종목이 내릴 때 알림", type: 5, required: false },
      { name: "시작", description: "알림 받을 시작 시각 (한국시간 0~23)", type: 4, required: false, autocomplete: true },
      { name: "종료", description: "알림 받을 종료 시각 (한국시간 0~23, 시작과 같으면 하루 종일)", type: 4, required: false, autocomplete: true },
    ],
  },
  { name: "알림확인", description: "현재 알림 설정을 봅니다." },
  {
    name: "종목추가",
    description: "[관리자] 새 종목을 등록합니다.",
    options: [
      { name: "종목", description: "종목 이름", type: 3, required: true },
      { name: "가격", description: "초기 가격(해정)", type: 4, required: true, autocomplete: true },
    ],
  },
  {
    name: "종목삭제",
    description: "[관리자] 종목을 삭제합니다.",
    options: [
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: "종목생성",
    description: "새 종목을 1000해정에 상장합니다. 이름만 정할 수 있고, 하루 횟수 제한이 있어요.",
    options: [
      { name: "이름", description: "새 종목 이름 (1~12자)", type: 3, required: true },
    ],
  },
  {
    name: "시세설정",
    description: "[관리자] 종목 가격을 변경합니다.",
    options: [
      { name: "종목", description: "종목 이름 (목록에서 선택)", type: 3, required: true, autocomplete: true },
      { name: "가격", description: "새 가격(해정)", type: 4, required: true, autocomplete: true },
    ],
  },
  {
    name: "출석설정",
    description: "[관리자] 출석 보상과 출석체크 사용 여부를 설정합니다.",
    options: [
      { name: "보상", description: "출석 보상(해정)", type: 4, required: false, autocomplete: true },
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

// 밀리초 타임스탬프 -> "MM-DD HH:mm" (한국시간)
function formatKST(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace("T", " ");
}

// 밀리초 타임스탬프 -> "YYYY-MM-DD HH:mm" (한국시간)
function formatKSTFull(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function notifyStatusText(s, title) {
  const mark = (on) => (on ? "✅ 켜짐" : "❌ 꺼짐");
  const hasWindow = Number.isInteger(s.start) && Number.isInteger(s.end) && s.start !== s.end;
  const windowText = hasWindow ? `${s.start}시 ~ ${s.end}시 (한국시간)` : "하루 종일";
  return [
    `**${title}**`,
    `- 전체 시세 변동: ${mark(s.all)}`,
    `- 내 보유 종목 상승: ${mark(s.up)}`,
    `- 내 보유 종목 하락: ${mark(s.down)}`,
    `- 알림 받는 시간: ${windowText}`,
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

// ---- 3) 자동완성 ----
// Discord는 한 번에 최대 25개, 항목 이름은 100자까지만 보여줘요.

// 글자 입력으로 거르는 목록용: items = [{ label, value }]
function textChoices(items, keyword) {
  const lower = keyword.toLowerCase();
  return items
    .filter((i) => i.value.toLowerCase().includes(lower))
    .slice(0, 25)
    .map((i) => ({ name: i.label.slice(0, 100), value: i.value }));
}

// 숫자 옵션용: suggestions = [{ label, value(정수) }]
// 숫자를 입력하면 그 숫자를 맨 앞에 보여주고, 같은 숫자로 시작하는 예시만 남겨요.
function numberChoices(suggestions, keyword, labelFor) {
  const seen = new Set();
  const list = [];
  const push = (label, value) => {
    if (seen.has(value)) return;
    seen.add(value);
    list.push({ name: String(label).slice(0, 100), value });
  };

  if (/^\d+$/.test(keyword)) {
    const typed = Number(keyword);
    const exists = suggestions.some((s) => s.value === typed);
    if (!exists && Number.isSafeInteger(typed)) push(labelFor ? labelFor(typed) : typed.toLocaleString(), typed);
    for (const s of suggestions) {
      if (String(s.value).startsWith(keyword)) push(s.label, s.value);
    }
  } else {
    for (const s of suggestions) push(s.label, s.value);
  }
  return list.slice(0, 25);
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  label: `${h}시 (${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시)`,
  value: h,
}));

// 매수/매도 수량 예시 + 미리보기
// 수량 칸을 누르면 "이 수량으로 사고팔면 잔고가 얼마가 되는지, 이득/손해가 얼마인지"가 항목마다 보여요.
async function quantityChoices(command, interaction, env, keyword) {
  const defaults = [1, 5, 10];
  const plain = () => numberChoices(defaults.map((n) => ({ label: `${n}주`, value: n })), keyword);

  const stockName = String(opt(interaction, "종목") ?? "").trim();
  const userId = interaction.member?.user?.id;
  if (!stockName || !userId) return plain();

  const [stock, user] = await Promise.all([getStock(env, stockName), getUser(env, userId)]);
  if (!stock) return plain();

  let labelFor;
  let values;

  if (command === "매수") {
    const max = stock.price > 0 ? Math.floor(user.balance / stock.price) : 0;
    labelFor = (q) => {
      if (q <= 0) return "1주 이상 입력해 주세요";
      const p = previewBuy(user, stock, q);
      return p.ok
        ? `${q.toLocaleString()}주 매수 → -${p.cost.toLocaleString()}해정 · 잔고 ${p.after.toLocaleString()}해정`
        : `${q.toLocaleString()}주 매수 불가 (필요 ${p.cost.toLocaleString()} / 잔고 ${user.balance.toLocaleString()}해정)`;
    };
    values = max > 0 ? [...defaults.filter((n) => n < max), max] : defaults;
    return numberChoices(
      values.map((v) => ({ label: (v === max && max > 0 ? "최대 " : "") + labelFor(v), value: v })),
      keyword,
      labelFor
    );
  }

  // 매도
  const held = user.holdings[stockName] || 0;
  labelFor = (q) => {
    if (q <= 0) return "1주 이상 입력해 주세요";
    const p = previewSell(user, stock, q);
    if (!p.ok) return `${q.toLocaleString()}주 매도 불가 (보유 ${held.toLocaleString()}주)`;
    return `${q.toLocaleString()}주 매도 → +${p.earned.toLocaleString()} · 잔고 ${p.after.toLocaleString()} · ${profitLabel(p.profit, p.basis, true)}`;
  };
  values = held > 0 ? [...defaults.filter((n) => n < held), held] : defaults;
  return numberChoices(
    values.map((v) => ({ label: (v === held && held > 0 ? "전량 " : "") + labelFor(v), value: v })),
    keyword,
    labelFor
  );
}

// 시세설정 가격 예시: 현재가 기준 -50% ~ +100%
async function priceSuggestions(interaction, env) {
  const stockName = String(opt(interaction, "종목") ?? "").trim();
  if (!stockName) return [];
  const stock = await getStock(env, stockName);
  if (!stock) return [];

  const p = stock.price;
  const list = [{ label: `현재가 ${p.toLocaleString()}해정`, value: p }];
  for (const m of [0.5, 0.8, 1.2, 1.5, 2]) {
    const value = Math.max(1, Math.round(p * m));
    const pct = Math.round((m - 1) * 100);
    list.push({ label: `${pct > 0 ? "+" : ""}${pct}% → ${value.toLocaleString()}해정`, value });
  }
  return list.sort((a, b) => a.value - b.value);
}

// (interaction, env) => Promise<[{ name, value }]>
export async function autocomplete(interaction, env) {
  const focused = interaction.data.options?.find((o) => o.focused);
  if (!focused) return [];

  const command = interaction.data.name;
  const keyword = String(focused.value ?? "").trim();

  // ----- 상장폐지종류: 폐지된 종목 이름 (최신 폐지순, 같은 이름은 가장 최근 것만) -----
  if (focused.name === "종목" && command === "상장폐지종류") {
    const delisted = await listDelisted(env, 200);
    const seen = new Set();
    const items = [];
    for (const d of delisted) {
      if (seen.has(d.name)) continue;
      seen.add(d.name);
      items.push({
        label: `🚫 ${d.name} (${formatKST(d.delistedAt)} 폐지 · 최대 하락 -${d.maxDropPct}%)`,
        value: d.name,
      });
    }
    return textChoices(items, keyword);
  }

  // ----- 종목 이름 (종목추가는 새 이름을 입력하는 거라 제외) -----
  if (focused.name === "종목" && command !== "종목추가") {
    const stocks = await listStocks(env); // 이름순

    const userId = interaction.member?.user?.id;
    const user = userId ? await getUser(env, userId) : { balance: 0, holdings: {}, costs: {} };

    if (command === "매도") {
      // 매도는 내가 가진 종목만 보여줌 (현재가 기준 평가손익 함께 표시)
      return textChoices(
        stocks
          .filter((s) => (user.holdings[s.name] || 0) > 0)
          .map((s) => {
            const qty = user.holdings[s.name];
            const cost = costOf(user, s.name, s.price);
            return {
              label: `${s.name}${dangerTag(s.price, true)} (보유 ${qty}주 · ${s.price.toLocaleString()}해정 · ${profitLabel(s.price * qty - cost, cost, true)})`,
              value: s.name,
            };
          }),
        keyword
      );
    }

    if (command === "매수") {
      // 매수는 지금 잔고로 최대 몇 주까지 살 수 있는지 함께 표시
      return textChoices(
        stocks.map((s) => ({
          label: `${s.name}${dangerTag(s.price, true)} (${s.price.toLocaleString()}해정 · 최대 ${Math.floor(user.balance / s.price).toLocaleString()}주)`,
          value: s.name,
        })),
        keyword
      );
    }

    return textChoices(
      stocks.map((s) => ({ label: `${s.name}${dangerTag(s.price, true)} (${s.price.toLocaleString()}해정)`, value: s.name })),
      keyword
    );
  }

  // ----- 상품 이름: 가격 낮은 순, 설명 포함 -----
  if (focused.name === "상품") {
    const products = await listProducts(env);
    return textChoices(
      products.map((p) => ({
        label: `${p.name} — ${p.price.toLocaleString()}해정${p.description ? ` · ${p.description}` : ""}`,
        value: p.name,
      })),
      keyword
    );
  }

  // ----- 숫자 옵션 -----
  if (focused.name === "수량") {
    return quantityChoices(command, interaction, env, keyword);
  }

  if (focused.name === "개수") {
    return numberChoices([5, 10, 20, 30].map((n) => ({ label: `${n}건`, value: n })), keyword);
  }

  if (focused.name === "시작" || focused.name === "종료") {
    return numberChoices(HOURS, keyword);
  }

  if (focused.name === "가격") {
    if (command === "시세설정") {
      return numberChoices(await priceSuggestions(interaction, env), keyword);
    }
    // 종목추가: 초기 가격 예시
    return numberChoices(
      [500, 1000, 5000, 10000, 50000].map((n) => ({ label: `${n.toLocaleString()}해정`, value: n })),
      keyword
    );
  }

  if (focused.name === "보상") {
    const config = await getAttendanceConfig(env);
    const list = [{ label: `현재 ${config.reward.toLocaleString()}해정`, value: config.reward }];
    for (const n of [100, 500, 1000, 5000]) {
      list.push({ label: `${n.toLocaleString()}해정`, value: n });
    }
    return numberChoices(list.sort((a, b) => a.value - b.value), keyword);
  }

  return [];
}

// ---- 4) 커맨드별 핸들러: (interaction, env) => Promise<string> ----
export const handlers = {
  도움말: async () => helpText(),

  출석체크: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await checkAttendance(env, userId);
    return result.message;
  },

  채굴: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await mineOnce(env, userId);
    return result.message;
  },

  채굴정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    return getMiningInfo(env, userId);
  },

  채굴업그레이드: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const result = await upgradeMining(env, userId);
    return result.message;
  },

  // 이름순 (listStocks가 정렬해서 줌). 나만 보이는 응답이라 내가 보유한 종목만 ⭐로 표시
  주식목록: async (interaction, env) => {
    const stocks = await listStocks(env);
    if (stocks.length === 0) return "등록된 종목이 없어요. 관리자가 `/종목추가`로 등록할 수 있어요.";

    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);

    return [
      "**📈 주식 목록 (이름순)** · ⭐ = 내가 보유 중",
      ...stocks.map((s) => {
        const held = user.holdings[s.name] || 0;
        const mark = held > 0 ? `⭐ (보유 ${held}주) ` : "";
        return `${mark}**${s.name}**${dangerTag(s.price)} — ${s.price.toLocaleString()}해정`;
      }),
    ].join("\n");
  },

  // 상장폐지된 종목 목록 (최신 폐지순) + 하락률. 종목을 고르면 폐지된 종목도 시세 그래프를 그려줘요.
  상장폐지종류: async (interaction, env) => {
    const pick = String(opt(interaction, "종목") ?? "").trim();

    // ----- 종목 지정: 하락률 + 그래프 -----
    if (pick) {
      const all = await listDelisted(env, 200);
      const d = all.find((x) => x.name === pick); // 최신 폐지순이라 가장 최근 기록이 잡혀요
      if (!d) return `"${pick}" 상장폐지 기록을 찾지 못했어요. 칸을 눌러 목록에서 골라 주세요.`;

      const points = getDelistedHistory(d);
      const prices = points.map((p) => p.p);
      const high = Math.max(...prices);
      const low = Math.min(...prices);
      const imageUrl = await renderStockChart(points, false); // 폐지 종목이라 파란색(하락)

      return {
        embeds: [
          {
            title: `🚫 ${d.name} 상장폐지`,
            description: [
              `폐지 시각: \`${formatKSTFull(d.delistedAt)}\` (한국시간)`,
              `${DOWN_MARK} 폐지된 변동: ${(d.lastPrice || 0).toLocaleString()} → ${(d.finalPrice || 0).toLocaleString()}해정 (**-${((d.lastPrice || 0) - (d.finalPrice || 0)).toLocaleString()}해정, -${d.dropPct}%**)`,
              `📉 역대 최고가 ${(d.maxPrice || 0).toLocaleString()}해정 대비 **-${d.peakDropPct}%**`,
              `⬇️ 기록 중 한 번에 가장 많이 하락: **-${d.maxDropPct}%**`,
              `구간 최고 ${high.toLocaleString()} / 최저 ${low.toLocaleString()}해정 · 폐지 당시 보유자 ${(d.holders || 0).toLocaleString()}명`,
            ].join("\n"),
            color: 0x1e88e5,
            image: { url: imageUrl },
            footer: {
              text:
                points.length > 2
                  ? `최근 ${points.length}개 기록 · ${formatKST(points[0].t)} ~ ${formatKST(points[points.length - 1].t)} (한국시간)`
                  : "예전에 폐지된 종목이라 시세 기록이 없어 폐지 직전 → 폐지 가격만 보여줘요",
            },
          },
        ],
      };
    }

    // ----- 목록 -----
    const requested = opt(interaction, "개수") ?? 10;
    const count = Math.min(Math.max(requested, 1), 20);

    const list = await listDelisted(env, count);
    if (list.length === 0) return "아직 상장폐지된 종목이 없어요.";

    const lines = list.map(
      (d) =>
        `🚫 **${d.name}** · \`${formatKSTFull(d.delistedAt)}\` · ${(d.lastPrice || 0).toLocaleString()} → ${(d.finalPrice || 0).toLocaleString()}해정 (**-${((d.lastPrice || 0) - (d.finalPrice || 0)).toLocaleString()}해정, -${d.dropPct}%**) · 최고가 ${(d.maxPrice || 0).toLocaleString()} 대비 -${d.peakDropPct}% · 최대 하락 -${d.maxDropPct}%`
    );

    // 디스코드 메시지 한도(2000자) 보호
    let text = `**🪦 상장폐지된 종목 (${list.length}건, 최신순)**\n그래프는 \`/상장폐지종류 종목:이름\`으로 볼 수 있어요.`;
    for (const line of lines) {
      if (text.length + line.length + 1 > 1900) {
        text += "\n…(이하 생략 · `개수`를 줄여 보세요)";
        break;
      }
      text += `\n${line}`;
    }
    return text;
  },

  // 종목 시세 그래프 (QuickChart 이미지를 임베드로 보여줌)
  그래프: async (interaction, env) => {
    const name = String(opt(interaction, "종목") ?? "").trim();
    const stock = await getStock(env, name);
    if (!stock) return `"${name}" 종목을 찾을 수 없어요.`;

    const points = getPriceHistory(stock);
    if (points.length < 2) {
      return `**${name}**의 시세 기록이 아직 부족해요. 시세가 한 번 더 변동된 뒤에 다시 시도해 주세요.`;
    }

    const first = points[0];
    const last = points[points.length - 1];
    const prices = points.map((p) => p.p);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const diff = last.p - first.p;
    const pct = first.p > 0 ? (diff / first.p) * 100 : 0;
    const up = diff >= 0;
    const mark = diff > 0 ? UP_MARK : diff < 0 ? DOWN_MARK : "➖";

    const imageUrl = await renderStockChart(points, up);

    return {
      embeds: [
        {
          title: `${name} 시세 그래프`,
          description: [
            `${mark} 현재가 **${stock.price.toLocaleString()}해정**${dangerTag(stock.price) ? `${dangerTag(stock.price)} 상장폐지 위기` : ""}`,
            `구간 변동: ${mark} ${fmtSigned(diff)}해정 (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%) · ${formatKST(first.t)} 시작가 ${first.p.toLocaleString()}해정 대비`,
            `구간 최고 ${high.toLocaleString()} / 최저 ${low.toLocaleString()}해정`,
            `역대 최고가 ${Math.max(stock.maxPrice || 0, high).toLocaleString()}해정`,
          ].join("\n"),
          color: up ? 0xe53935 : 0x1e88e5, // 오름 = 빨강, 내림 = 파랑
          image: { url: imageUrl },
          footer: { text: `최근 ${points.length}개 기록 · ${formatKST(first.t)} ~ ${formatKST(last.t)} (한국시간)` },
        },
      ],
    };
  },

  잔고: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const holdingsText = Object.entries(user.holdings)
      .sort(([a], [b]) => compareKo(a, b))
      .map(([name, qty]) => `- ${name}: ${qty}주`)
      .join("\n") || "(보유 종목 없음)";
    return `잔고: **${user.balance.toLocaleString()}해정**\n${holdingsText}`;
  },

  // 보유 종목은 getUserDetail에서 이름순으로 정렬됨
  내정보: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const detail = await getUserDetail(env, userId);

    const holdingsText = detail.holdings
      .map(
        (h) =>
          `- ${h.name}${dangerTag(h.price)}: ${h.qty}주 (현재가 ${h.price.toLocaleString()} · 평균 매수가 ${h.avg.toLocaleString()} · 평가금 ${h.value.toLocaleString()}해정)\n  ${profitLabel(h.profit, h.cost)}`
      )
      .join("\n") || "(보유 종목 없음)";

    const rankText = detail.rank > 0 ? `${detail.rank}위 / ${detail.totalUsers}명` : "(순위 없음)";

    let changeText = "📊 지난 조회 대비: 첫 조회예요. 다음 조회부터 증감이 표시돼요.";
    if (detail.assetChange !== null) {
      const mark =
        detail.assetChange > 0 ? `${UP_MARK} 증가` : detail.assetChange < 0 ? `${DOWN_MARK} 감소` : "➖ 변동 없음";
      changeText = `📊 지난 조회 대비 총자산: ${mark} ${fmtSigned(detail.assetChange)}해정 (${formatKST(detail.prevAssetAt)} 조회 시점: ${detail.prevAsset.toLocaleString()}해정)`;
    }

    return [
      "**내 상세정보**",
      `현금 잔고: ${detail.balance.toLocaleString()}해정`,
      `보유 종목 평가액: ${detail.holdingsValue.toLocaleString()}해정`,
      `총 자산: ${detail.totalAsset.toLocaleString()}해정`,
      changeText,
      `보유 종목 평가손익: ${profitLabel(detail.holdingsProfit, detail.holdingsCost)}`,
      `누적 실현 손익(매도 확정분): ${fmtSigned(detail.realizedProfit)}해정`,
      `전체 순위: ${rankText}`,
      "",
      "보유 종목 (이름순):",
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

  내역: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const requested = opt(interaction, "개수") ?? 10;
    const count = Math.min(Math.max(requested, 1), 30);

    const list = await getHistory(env, userId, count);
    if (list.length === 0) {
      return "아직 기록이 없어요. 매수·매도·구입·출석체크를 하면 여기에 남아요.";
    }

    const lines = list.map((h) => `\`${formatKST(h.t)}\` ${h.text}`);
    return [`**📜 내 최근 기록 (${list.length}건, 최신순)**`, ...lines].join("\n");
  },

  매수: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = opt(interaction, "종목");
    const qty = opt(interaction, "수량") ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) return "수량은 1 이상의 정수여야 해요.";
    const result = await buyStock(env, userId, name, qty);
    return result.message;
  },

  매도: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = opt(interaction, "종목");
    const qty = opt(interaction, "수량") ?? 1;
    if (!Number.isInteger(qty) || qty <= 0) return "수량은 1 이상의 정수여야 해요.";
    const result = await sellStock(env, userId, name, qty);
    return result.message;
  },

  // 가격 낮은 순 (listProducts가 정렬해서 줌)
  상점: async (_interaction, env) => {
    const products = await listProducts(env);
    if (products.length === 0) return "판매 중인 상품이 없어요.";
    return [
      "**🛒 상점 (가격 낮은 순)**",
      ...products.map(
        (p) => `**${p.name}** — ${p.price.toLocaleString()}해정${p.description ? `\n> ${p.description}` : ""}`
      ),
    ].join("\n");
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
    const entries = Object.entries(user.items).sort(([a], [b]) => compareKo(a, b));
    if (entries.length === 0) return "보유한 상품이 없어요. `/상점`에서 구경해 보세요.";
    return entries.map(([name, count]) => `- ${name} x${count}`).join("\n");
  },

  알림설정: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const user = await getUser(env, userId);
    const current = user.notify || { all: false, up: false, down: false };

    // 시작/종료는 0~23 정수만 허용 (자동완성은 예시일 뿐 직접 입력도 가능하므로 검사)
    const rawStart = opt(interaction, "시작");
    const rawEnd = opt(interaction, "종료");
    for (const v of [rawStart, rawEnd]) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 23)) {
        return "시작/종료는 0~23 사이의 정수로 입력해 주세요.";
      }
    }

    const next = {
      all: opt(interaction, "전체") ?? current.all,
      up: opt(interaction, "상승") ?? current.up,
      down: opt(interaction, "하락") ?? current.down,
    };

    // 알림 시간대: 안 넘긴 값은 기존 설정을 유지
    const start = rawStart ?? current.start;
    const end = rawEnd ?? current.end;
    if (Number.isInteger(start)) next.start = start;
    if (Number.isInteger(end)) next.end = end;

    if (Number.isInteger(next.start) !== Number.isInteger(next.end)) {
      return "알림 시간대는 `시작`과 `종료`를 함께 입력해 주세요. (예: 시작 9, 종료 22)";
    }

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
    const name = String(opt(interaction, "종목") ?? "").trim();
    const price = opt(interaction, "가격");
    if (!name) return "종목 이름을 입력해 주세요.";
    if (!Number.isInteger(price) || price < 1) return "가격은 1 이상의 정수여야 해요.";
    await upsertStock(env, name, price);
    return `"${name}" 종목을 ${price.toLocaleString()}해정에 등록했어요.`;
  },

  종목삭제: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const name = opt(interaction, "종목");
    await removeStock(env, name);
    await ensureMinimumStocks(env); // 종목 수가 기준 이하면 자동 상장
    return `"${name}" 종목을 삭제했어요.`;
  },

  // 유저 종목 생성: 이름만 정하고 가격은 LISTING_PRICE 고정, 하루 dailyLimit회 (무료)
  종목생성: async (interaction, env) => {
    const userId = interaction.member.user.id;
    const name = String(opt(interaction, "이름") ?? "").trim();
    if (!name || name.length > 12) return "종목 이름은 1~12자로 입력해 주세요.";

    const cfg = await getListingConfig(env);
    const user = await getUser(env, userId);
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const used = user.listingDay === today ? user.listingCount || 0 : 0;
    if (used >= cfg.dailyLimit) {
      return `오늘은 종목 생성을 ${cfg.dailyLimit}회 모두 썼어요. 내일 다시 시도해 주세요.`;
    }

    if (await getStock(env, name)) return `"${name}" 종목이 이미 있어요. 다른 이름을 골라 주세요.`;

    await upsertStock(env, name, LISTING_PRICE);
    user.listingDay = today;
    user.listingCount = used + 1;
    await saveUser(env, userId, user);
    await addHistory(env, userId, `종목 생성: ${name} (${LISTING_PRICE.toLocaleString()}해정 상장)`);

    return `"${name}" 종목을 ${LISTING_PRICE.toLocaleString()}해정에 상장했어요. (오늘 ${used + 1}/${cfg.dailyLimit}회)`;
  },

  시세설정: async (interaction, env) => {
    if (!isAdmin(interaction, env)) return "관리자만 사용할 수 있는 명령어예요.";
    const name = opt(interaction, "종목");
    const price = opt(interaction, "가격");
    if (!Number.isInteger(price) || price < 1) return "가격은 1 이상의 정수여야 해요.";
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