# 단지 DB 중계 프록시 (실시간 방식 B)

견적 엔진(브라우저)이 공공데이터포털 API를 직접 못 부르는 제약(CORS·키 노출)을 풀기 위한 작은 중계 서버입니다. **서비스키는 서버에만 보관**되어 외부에 노출되지 않습니다.

```
[견적 엔진/브라우저] ──> [이 프록시 서버] ──(서비스키 부착)──> [공공데이터포털 API]
```

## 1. 준비물

- Node.js 18 이상
- 공공데이터포털(https://www.data.go.kr) 서비스키
  - "국토교통부_공동주택 단지 목록제공 서비스" 활용신청
  - "국토교통부_공동주택 기본 정보제공 서비스" 활용신청
  - 승인 후 발급되는 **일반 인증키(서비스키)** 사용

## 2. 설치 & 실행

```bash
cd danji-proxy
npm install

# (A) 키 없이 동작 확인 — 샘플 데이터로 응답
MOCK=1 node server.js

# (B) 실제 운영 — 발급키 사용
SERVICE_KEY=발급받은서비스키 node server.js
# 또는 .env.example 을 .env 로 복사해 키 입력 후 실행
```

기본 포트 `4000`. 실행되면: `단지 프록시 실행 → http://localhost:4000`

## 3. 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 상태·MOCK·키 설정 여부 |
| GET | `/api/danji/search?sigunguCode=11110&keyword=래미안` | 시군구 단지목록 + 이름 필터 |
| GET | `/api/danji/search?bjdCode=1111010100&keyword=` | 법정동 단지목록 |
| GET | `/api/danji/detail?kaptCode=A10027875` | 단지 상세(동수·세대수·복도유형·전용면적별 세대) |

- `sigunguCode`/`bjdCode`는 행정표준코드관리시스템(code.go.kr)에서 조회.
- 응답은 1시간 메모리 캐시.

## 4. 데모 화면

`단지검색_데모.html` 을 브라우저에서 열면 검색 → 선택 → 상세 흐름을 확인할 수 있습니다.
(프록시가 실행 중이어야 함. 같은 PC면 주소 `http://localhost:4000` 그대로 사용)

## 5. 제공 범위 / 한계

- 공공 API가 주는 것: 단지 식별(이름·주소·동수·세대수), 복도유형, **전용면적별 세대수**(→ 후보 평형 힌트).
- 공공 API가 **주지 않는 것**: 평면도, 방/거실의 mm 치수, 개방변 위치. 이건 별도의 **구조 템플릿 DB**(자체 큐레이션)로 채웁니다. → 다음 단계.

## 6. 배포(선택)

- 사내/개인 서버, 또는 Render·Railway·Fly.io 등에 올리고 `SERVICE_KEY`를 환경변수로 설정.
- 엔진의 프록시 주소를 배포 URL로 변경.
- 운영 시 권장: 허용 도메인 제한(CORS origin), 요청 rate-limit.

## 7. 부분일치 검색 (v1.1 추가)

이름의 **일부만**, **중간·끝 단어**, **공백 무관**으로 검색됩니다.

- `푸르지오` → "마포 래미안 푸르지오" (끝 단어)
- `래미안` → 중간 단어
- `자이` → "신반포 센트럴자이", "반포 자이" (여러 건)
- `센트럴 자이` → "신반포 센트럴자이" (공백 무시 + 여러 조각 모두 포함)
- `마포 푸르지오` → 여러 조각이 모두 들어간 단지

동작 원리: 입력을 공백으로 쪼갠 모든 조각이 (공백·대소문자 무시한) 단지명 어디든 들어가면 매치.

**지역코드 없이 이름만 검색**하려면 전국 단지 인덱스가 필요합니다.
- 실데이터 모드에서 첫 검색 시 `getTotalAptList`로 전국 목록을 1회 적재(캐시) → 이후 즉시 검색.
- 첫 적재가 부담되면 `sigunguCode`/`bjdCode`를 함께 넘겨 해당 지역만 조회(빠름).

## 8. 소셜 로그인 (카카오·네이버, v1.8 추가)

고객이 카카오/네이버로 로그인하면 이름·이메일이 자동으로 채워집니다(전화는 비즈앱 검수 시).

**키 발급 후 환경변수로 실행:**
```bash
KAKAO_CLIENT_ID=카카오REST키 KAKAO_CLIENT_SECRET=시크릿 \
NAVER_CLIENT_ID=네이버ID NAVER_CLIENT_SECRET=네이버시크릿 \
BASE_URL=https://배포도메인 SERVICE_KEY=공공키 node server.js
```

**개발자센터 설정:**
- 카카오(developers.kakao.com): 앱 생성 → REST API 키 → 카카오 로그인 ON → Redirect URI에 `BASE_URL/auth/kakao/callback` 등록 → 동의항목(닉네임·이메일) 설정. (전화번호는 비즈앱 검수 필요)
- 네이버(developers.naver.com): 애플리케이션 등록 → Client ID/Secret → Callback URL에 `BASE_URL/auth/naver/callback` 등록 → 제공정보(이름·이메일·휴대폰) 선택.
- `BASE_URL`은 실제 배포 도메인(https). Redirect URI가 정확히 일치해야 함.

**엔드포인트:** `/auth/kakao` `/auth/naver` (로그인 시작) · `/auth/*/callback` (콜백) · `/auth/status` (키 설정 여부) · `/auth/mock?name=홍길동` (키 없이 흐름 체험).
로그인 성공 시 프로필을 브라우저 localStorage('mat_user')에 저장하고 앱(/)으로 복귀 → 앱이 이름·연락처 자동 채움.

> 토스·당근은 외부 소셜 로그인 미제공(토스는 별도 계약/심사, 당근은 공개 API 없음).

## 9. 실제 배포 (Render 예시)

1. 이 `danji-proxy` 폴더를 GitHub 저장소에 올립니다. (`.gitignore`가 `leads.json`·`.env` 등 민감파일을 자동 제외)
2. https://render.com → New → Blueprint → 저장소 선택 (`render.yaml` 자동 인식) 또는 New → Web Service.
3. 환경변수 입력: `SERVICE_KEY`(공공키), `ADMIN_PASS`(강한 값) 필수. 소셜로그인 쓰면 `BASE_URL`(배포 https URL)·카카오/네이버 키.
4. 배포되면 `https://○○.onrender.com` 주소가 나옵니다 → **HTTPS 자동 적용**(PWA·소셜로그인 조건 충족).
   - 고객앱: 그 주소 그대로. 관리자: 주소 뒤에 `/admin.html`.
   - 카카오·네이버 개발자센터의 Redirect URI를 `BASE_URL/auth/kakao(naver)/callback`로 등록.
5. 커스텀 도메인: Render → Settings → Custom Domain에서 연결(가비아 등에서 산 도메인 CNAME 연결).

### ⚠ 데이터 영속성 (중요)
Render 무료/기본 플랜은 파일시스템이 **재배포·재시작 시 초기화**됩니다. `leads.json`(고객정보)이 날아갈 수 있어요.
운영에서는 둘 중 하나를 권장:
- **Render Persistent Disk**(유료) 연결 후 데이터 파일을 그 경로에 저장, 또는
- **DB로 이전**(예: Postgres/Supabase/Google Sheets API) — 고객정보·로그를 DB에 저장하도록 전환.
지금 구조(JSON 파일)는 소규모·테스트엔 충분하지만, 리드가 쌓이기 시작하면 DB 전환을 권합니다.

### 개인정보 보관
`RETENTION_LEADS`(기본 365일)·`RETENTION_LOGS`(기본 180일) 경과분은 서버가 기동 시 + 하루 주기로 자동 파기합니다. 관리자 수동 파기: `POST /api/admin/purge` (x-admin-pass 헤더).

## 10. 새 리드 알림 & 무료 영속 백업 (선택)

새 상담 신청이 들어오면 즉시 알림을 받고, 무료로 영구 백업할 수 있어요. 모두 env 설정 시에만 동작.

- **텔레그램 알림(무료, 추천):** 텔레그램 `@BotFather`로 봇 생성 → `TELEGRAM_BOT_TOKEN`. 내 `chat_id`(예: `@userinfobot`으로 확인) → `TELEGRAM_CHAT_ID`. 끝. 리드마다 사장님 폰으로 알림.
- **범용 웹훅(무료):** 슬랙/디스코드 Incoming Webhook URL을 `NOTIFY_WEBHOOK`에. 카카오 알림톡 대행 솔루션의 웹훅도 여기에 연결 가능.
- **구글시트 백업(무료 영속, 추천):** Google Sheets → 확장프로그램 → Apps Script에 `doPost(e){ ... 시트에 append }` 웹앱 배포 → 그 URL을 `SHEETS_WEBHOOK`에. 리드가 시트에 자동 누적되어 **Render가 초기화돼도 데이터가 남아요**(무료 영속 해결책).

> 카카오 **알림톡**(브랜드 발신)은 비즈니스 채널 개설 + 건당 발송요금 + 대행 솔루션 가입이 필요해 **유료**입니다. 무료로는 위의 텔레그램/시트를 권장.
