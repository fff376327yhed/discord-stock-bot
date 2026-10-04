# 모의투자 디스코드봇 (해정)

상시 서버 없이, 디스코드가 슬래시 커맨드를 호출할 때만 깨어나는 **Vercel 서버리스 함수(Node.js 런타임)** 기반 봇입니다.
데이터는 **Firebase Firestore**(무료 Spark 플랜)에 저장됩니다.

## 1. Discord 앱 준비
1. https://discord.com/developers/applications 에서 새 애플리케이션 생성
2. **봇** 탭에서 봇 생성 → Token 복사 (`DISCORD_BOT_TOKEN`, 커맨드 등록용 — 배포 환경변수에는 안 올림)
3. **일반 정보** 탭에서 `Application ID`(`DISCORD_APPLICATION_ID`), `Public Key`(`DISCORD_PUBLIC_KEY`) 복사
4. OAuth2 URL Generator에서 `applications.commands`, `bot` 스코프 체크 → 생성된 링크로 봇을 서버에 초대

## 2. Firebase 준비
1. https://console.firebase.google.com 에서 프로젝트 생성 (Firestore 활성화, Native 모드, Standard 버전)
2. 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" (다운로드 안 되면 Cloud Shell에서 `gcloud iam service-accounts keys create key.json --iam-account=<이메일>` 로 발급 후 `cat key.json`으로 확인)
3. 값을 각각 복사:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (줄바꿈 그대로 포함)
4. Firestore 보안 규칙은 기본값(모두 거부)으로 두면 됩니다 — 서비스 계정 OAuth 토큰으로 호출하므로 영향 없습니다.

## 3. 로컬 설정 & 커맨드 등록
```cmd
npm install
set DISCORD_APPLICATION_ID=실제_ID값& set DISCORD_BOT_TOKEN=실제_BOT_TOKEN값& npm run register
```
(커맨드 목록을 바꿀 때마다 다시 실행)

## 4. GitHub + Vercel 배포
1. GitHub에 새 저장소 생성 → 이 프로젝트 푸시
2. https://vercel.com → GitHub 계정으로 로그인 → **Add New → Project** → 저장소 Import
3. **Environment Variables**에 아래 6개 등록 (Production 체크):
   - `DISCORD_PUBLIC_KEY`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`
   - `ADMIN_DISCORD_ID` — 관리자 명령어를 쓸 본인의 디스코드 유저 ID
   - `CRON_SECRET` — 임의의 긴 랜덤 문자열 (시세 변동 엔드포인트 보호용 열쇠)
4. **Deploy**

배포 후 뜨는 `https://<프로젝트명>.vercel.app` 주소를 복사하세요.

## 5. Discord에 엔드포인트 등록
Discord Developer Portal → 해당 앱 → **일반 정보** → **Interactions Endpoint URL**에
`.../api/interactions` 주소를 입력하고 저장 (예: `https://discord-stock-bot.vercel.app/api/interactions`)

## 6. 시세 자동 변동 설정

**매일 자정(KST 00:00) 급등락 (±70%)** — `vercel.json`에 등록된 Vercel 자체 Cron이 자동으로 하루 1회 호출해요. 따로 설정할 거 없이 배포만 하면 동작합니다. (Hobby 플랜은 정시 보장이 안 돼서 자정 전후 1시간 사이 어딘가에 실행될 수 있어요.)

**평소 시세 변동 (±30%, 30분마다)** — Vercel 무료 플랜은 자체 Cron을 하루 1번만 돌릴 수 있어서, 더 잦은 변동은 **무료 외부 스케줄러**를 써야 해요:
1. https://cron-job.org 가입 (무료)
2. **Create cronjob**
   - URL: `https://<프로젝트명>.vercel.app/api/cron/fluctuate`
   - Schedule: 30분마다 (`*/30 * * * *`)
   - **Headers** 추가: `Authorization: Bearer <CRON_SECRET에 넣은 값>`
3. 저장하면 끝 — 이 서비스가 30분마다 우리 엔드포인트를 호출해줘요.

(30분 주기가 너무 잦거나 뜸하면 cron-job.org 설정에서 언제든 주기만 바꾸면 돼요.)

## 사용 가능한 명령어
| 명령어 | 설명 | 권한 |
|---|---|---|
| `/주식목록` | 종목과 가격 확인 | 전체 |
| `/잔고` | 내 해정 잔고 + 보유 종목 | 전체 |
| `/내정보` | 잔고, 보유 종목 평가액, 총자산, 전체 순위를 한 번에 확인 | 전체 |
| `/랭킹` | 총 자산 랭킹 (상위 10명) | 전체 |
| `/매수 종목 수량` | 매수 | 전체 |
| `/매도 종목 수량` | 매도 | 전체 |
| `/종목추가 종목 가격` | 종목 신규 등록 | 관리자 |
| `/종목삭제 종목` | 종목 삭제 | 관리자 |
| `/시세설정 종목 가격` | 가격 수동 변경 | 관리자 |

신규 유저는 가입(첫 명령어 사용) 시 자동으로 1,000해정을 지급받습니다. 계좌 인증 절차는 없고, 디스코드 유저 ID로만 식별합니다.

## 비용
- Vercel Hobby(무료) 플랜: 함수 호출 넉넉한 무료 한도, 자체 Cron 하루 1회 무료
- cron-job.org: 완전 무료
- Firebase Firestore Spark(무료) 플랜: 일 5만 읽기 / 2만 쓰기 / 2만 삭제까지 무료
- 개인/소규모 디스코드 서버 용도로는 모두 여유 있게 무료 범위 안에서 운영됩니다.

## 프로젝트 구조
```
discord-stock-bot/
  api/
    interactions.js       # Discord 요청 수신 (슬래시 커맨드 처리)
    cron/
      fluctuate.js          # 평소 시세 변동 (±30%, 외부 cron-job.org가 호출)
      midnight.js            # 자정 급등락 (±70%, Vercel 자체 Cron이 하루 1회 호출)
  src/
    commands.js            # 슬래시 커맨드 정의 + 핸들러
    economy.js               # 매수/매도/랭킹/시세변동 로직
    firebase.js                # Firestore REST API 연동
    env.js                      # 환경변수 로딩 + Cron 인증 공통 헬퍼
  scripts/
    register-commands.js   # 커맨드를 디스코드에 등록하는 1회성 스크립트
  vercel.json               # Vercel 자체 Cron 설정 (자정 트리거)
```
