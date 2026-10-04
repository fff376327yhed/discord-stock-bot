// 종목 시세 그래프 이미지를 QuickChart(무료 차트 이미지 서비스)로 만들어요.
// 차트 설정을 보내면 이미지 주소를 돌려주고, 디스코드 임베드의 image.url에 넣으면 그림으로 보여요.
// 글꼴 문제를 피하려고 그래프 안에는 숫자/영문만 쓰고, 한글 제목은 임베드 제목에 적어요.

const QUICKCHART = "https://quickchart.io";
const RED = "#e53935"; // 오름
const BLUE = "#1e88e5"; // 내림

// 밀리초 -> "MM/DD HH:mm" (한국시간)
function labelOf(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace("T", " ").replace("-", "/");
}

function buildConfig(points, up) {
  const color = up ? RED : BLUE;
  return {
    type: "line",
    data: {
      labels: points.map((p) => labelOf(p.t)),
      datasets: [
        {
          data: points.map((p) => p.p),
          borderColor: color,
          backgroundColor: up ? "rgba(229,57,53,0.12)" : "rgba(30,136,229,0.12)",
          borderWidth: 2,
          pointRadius: points.length > 40 ? 0 : 3,
          pointBackgroundColor: color,
          lineTension: 0,
          fill: true,
        },
      ],
    },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 7, maxRotation: 0, fontSize: 11 } }],
        yAxes: [{ ticks: { fontSize: 11 } }],
      },
    },
  };
}

// points: [{ t(ms), p(가격) }], up: 구간 전체가 올랐으면 true(빨강), 아니면 false(파랑)
// 반환: 이미지 주소(URL)
export async function renderStockChart(points, up) {
  const config = buildConfig(points, up);

  // 1) 짧은 주소 발급 (포인트가 많아도 안전). 느리면 포기하고 2번으로.
  try {
    const res = await fetch(`${QUICKCHART}/chart/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: "2",
        backgroundColor: "white",
        width: 700,
        height: 360,
        format: "png",
        chart: config,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.url) return data.url;
    }
  } catch (err) {
    console.error("QuickChart 짧은 주소 발급 실패:", err.message);
  }

  // 2) 긴 주소로 직접 요청 (주소가 너무 길지 않게 최근 기록만 사용)
  for (const n of [40, 24, 12]) {
    const slice = points.slice(-n);
    const url = `${QUICKCHART}/chart?v=2&w=700&h=360&bkg=white&c=${encodeURIComponent(
      JSON.stringify(buildConfig(slice, up))
    )}`;
    if (url.length <= 1900 || n === 12) return url;
  }
}