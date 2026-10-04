# 모의투자 디스코드봇 (해정)

상시 서버 없이, 디스코드가 슬래시 커맨드를 호출할 때만 깨어나는 **Vercel Edge Function** 기반 봇입니다.
데이터는 **Firebase Firestore**(무료 Spark 플랜)에 저장됩니다.

## 1. Discord 앱 준비
1. https://discord.com/developers/applications 에서 새 애플리케이션 생성
2. **Bot** 탭에서 봇 생성 → Token 복사 (`DISCORD_BOT_TOKEN`, 커맨드 등록용 — 배포 환경변수에는 안 올림)
3. **General Information** 탭에서 `Application ID`(`DISCORD_APPLICATION_ID`), `Public Key`(`DISCORD_PUBLIC_KEY`) 복사
4. OAuth2 URL Generator에서 `applications.commands`, `bot` 스코프 체크 → 생성된 링크로 봇을 서버에 초대

## 2. Firebase 준비
1. https://console.firebase.google.com 에서 프로젝트 생성 (Firestore 활성화, Native 모드)
2. 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" → JSON 다운로드
3. JSON 안의 값을 각각 복사:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (줄바꿈 `\n` 그대로 포함)
4. Firestore 보안 규칙은 기본값(모두 거부)으로 두면 됩니다 — 이 봇은 REST API를 서비스 계정 OAuth 토큰으로 호출하므로 클라이언트 보안 규칙의 영향을 받지 않습니다.

## 3. 로컬 설정
```bash
npm install
```

## 4. 슬래시 커맨드 등록 (최초 1회, 커맨드 변경 시 재실행)
```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... npm run register
```

## 5. Vercel 배포
```bash
npx vercel login
npx vercel link          # 프로젝트 최초 연결 (질문에 답하면 자동 생성)

# 환경변수 등록 (각 명령마다 값 입력 프롬프트가 뜸, Production 환경 선택)
npx vercel env add DISCORD_PUBLIC_KEY
npx vercel env add FIREBASE_PROJECT_ID
npx vercel env add FIREBASE_CLIENT_EMAIL
npx vercel env add FIREBASE_PRIVATE_KEY
npx vercel env add ADMIN_DISCORD_ID   # 관리자 명령어를 쓸 본인의 디스코드 유저 ID

npm run deploy
```
배포 후 출력되는 `https://<프로젝트명>.vercel.app` 주소를 복사하세요. 엔드포인트는 `/api/interactions` 경로입니다.
→ 최종 주소 예: `https://discord-stock-bot.vercel.app/api/interactions`

## 6. Discord에 엔드포인트 등록
Discord Developer Portal → 해당 앱 → **General Information** → **Interactions Endpoint URL**에
위에서 만든 `.../api/interactions` 주소를 입력하고 저장합니다. (저장 시 Discord가 PING을 보내 자동 검증합니다.)

## 사용 가능한 명령어
| 명령어 | 설명 | 권한 |
|---|---|---|
| `/주식목록` | 종목과 가격 확인 | 전체 |
| `/잔고` | 내 해정 잔고 + 보유 종목 | 전체 |
| `/랭킹` | 총 자산 랭킹 (상위 10명) | 전체 |
| `/매수 종목 수량` | 매수 | 전체 |
| `/매도 종목 수량` | 매도 | 전체 |
| `/종목추가 종목 가격` | 종목 신규 등록 | 관리자 |
| `/종목삭제 종목` | 종목 삭제 | 관리자 |
| `/시세설정 종목 가격` | 가격 수동 변경 | 관리자 |

신규 유저는 가입(첫 명령어 사용) 시 자동으로 1,000,000해정을 지급받습니다. 계좌 인증 절차는 없고, 디스코드 유저 ID로만 식별합니다.

## 비용
- Vercel Hobby(무료) 플랜: Edge Function 넉넉한 무료 한도 (개인/소규모 프로젝트에 충분)
- Firebase Firestore Spark(무료) 플랜: 일 5만 읽기 / 2만 쓰기 / 2만 삭제까지 무료
- 개인/소규모 디스코드 서버 용도로는 두 한도 모두 여유 있게 무료 범위 안에서 운영됩니다.

## 프로젝트 구조
```
discord-stock-bot/
  api/
    interactions.js    # Vercel Edge Function 진입점 (Discord 요청 수신)
  src/
    commands.js         # 슬래시 커맨드 정의 + 핸들러
    economy.js           # 매수/매도/랭킹 로직
    firebase.js           # Firestore REST API 연동
  scripts/
    register-commands.js  # 커맨드를 디스코드에 등록하는 1회성 스크립트
```
