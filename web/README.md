# 웹 UI (Docker)

브라우저에서 지원 현황·공고·서류를 관리하고, `/setup`·`/apply`·`/interview` 같은 Claude Code 명령을 대화창에서 실행합니다.

## 실행

```bash
cp env.example .env        # 저장소 루트에서
# .env에 둘 중 하나 입력
#   CLAUDE_CODE_OAUTH_TOKEN=...   (Pro/Max 구독: 호스트에서 `claude setup-token` 실행 후 붙여넣기)
#   ANTHROPIC_API_KEY=...         (API 키, 사용량 과금)
docker compose up -d --build
```

Linux에서는 저장소 폴더를 쓸 수 있도록 내 계정 ID로 이미지를 빌드하세요: `APP_UID=$(id -u) APP_GID=$(id -g) docker compose up -d --build` (macOS의 Docker Desktop은 필요 없음). ID를 바꿔 다시 빌드해도, 컨테이너가 시작할 때 Claude 설정 볼륨의 소유자를 새 ID로 넘겨주므로 기존 대화 기록과 인증 정보가 그대로 유지됩니다.

http://localhost:3000 을 엽니다. 포트는 `.env`의 `WEB_PORT`로 바꿀 수 있습니다.

처음 열면 대시보드에 **"이 작업 공간 신뢰하기"** 카드가 뜹니다. Claude Code는 신뢰하지 않은 폴더에서 `.claude/settings.json`의 허용 목록을 무시하므로, 누르지 않으면 검색 도구나 PDF 검사도 매번 승인해야 합니다. 누르면 웹 UI가 이 저장소의 허용·거부 규칙을 직접 적용합니다. 동의는 웹 UI 전용 파일(`ai-job-search-web.json`, Docker에서는 `claude-config` 볼륨 안)에만 기록되고 Claude Code 설정 파일은 바꾸지 않습니다.

## API 엔드포인트 바꾸기 (base URL)

Claude Code가 Anthropic API 대신 다른 Anthropic 호환 서버(LLM 게이트웨이, 프록시, 회사 중계 서버)로 요청을 보내게 하려면 `.env`에 넣고 `docker compose up -d`를 다시 실행하세요.

```bash
ANTHROPIC_BASE_URL=https://gateway.example.com     # 이 PC에서 도는 서버면 http://host.docker.internal:<포트>
ANTHROPIC_AUTH_TOKEN=...                           # 게이트웨이가 Bearer 토큰을 쓰면 (API 키를 쓰면 ANTHROPIC_API_KEY)
ANTHROPIC_MODEL=...                                # 게이트웨이의 모델 이름이 다를 때만
```

- 컨테이너 안에서 `localhost`는 컨테이너 자신입니다. 이 PC의 프록시는 `host.docker.internal`로 접근합니다(Linux에서도 되도록 `compose.yaml`에 설정해 두었습니다).
- 대시보드의 "API 엔드포인트" 카드에 현재 주소가 표시됩니다(주소에 들어 있는 계정 정보와 쿼리는 지우고 보여 줍니다).
- 이 서버로 프로필, 공고, 생성한 서류 내용이 모두 전송됩니다. 신뢰하는 서버만 쓰세요.

## 개인정보 저장 위치

`/setup`은 프로필을 `documents/profile/`(git 제외)에 씁니다. 추적되는 프레임워크 파일은 플레이스홀더만 유지하므로 공개 fork에 커밋해도 개인정보가 올라가지 않습니다. 규칙은 `CLAUDE.md`의 "Personal Data Storage"에 있습니다.

개인 파일(프로필, `documents/`, 지원 기록, 생성한 CV·커버레터)은 별도 비공개 git 기록으로 백업합니다.

```bash
tools/private_data.sh save "메모"      # 스냅샷 (변경이 없으면 아무것도 안 함)
tools/private_data.sh log              # 기록 보기
tools/private_data.sh remote <비공개 저장소 URL> && tools/private_data.sh push --confirm-private
# 공개 GitHub 저장소로는 push를 거부합니다. 비공개 여부는 익명으로 확인할 수 없어서 --confirm-private가 필요합니다.
```

- 저장소 폴더 전체가 컨테이너의 `/workspace`에 마운트됩니다. 프로필, 지원서, PDF는 모두 호스트 폴더에 그대로 저장됩니다.
- Claude 대화 기록은 Docker 볼륨 `claude-config`에 남습니다. `docker compose down -v`를 하면 지워집니다.
- 이미지에는 Bun, Python(pypdf), Typst, Noto CJK 폰트, poppler가 들어 있습니다. LaTeX는 없으니 Typst 템플릿(`kr-resume`, `kr-letter`)을 쓰세요.

## 화면

| 메뉴 | 내용 |
|---|---|
| 대시보드 | 인증·템플릿·프로필 상태, 새 공고 지원(URL/본문 → `/apply`), 마감 임박, 추천 공고 |
| 공고 | `/scrape`·`/rank` 결과 (`job_scraper/seen_jobs.json`), 공고별 지원 버튼 |
| 지원 현황 | `job_search_tracker.csv`, 생성된 CV/커버레터 PDF, 결과 기록·면접 준비 버튼 |
| 서류 | `cv/`, `cover_letters/`, `documents/` 등 파일 보기, `documents/` 하위 폴더로 업로드 |
| 프로필 | `CLAUDE.md`와 프로필 파일 보기, `/setup`·`/expand` 실행 |
| 대화 | Claude Code 세션. 권한 요청은 허용/거부 카드로, 질문은 선택 폼으로 표시 |

웹 UI는 파일을 직접 고치지 않습니다. 트래커와 프로필은 지금처럼 `/apply`, `/outcome`, `/setup` 같은 명령이 관리하고, 웹은 그 명령을 실행하고 결과를 보여 줍니다.

## 보안

- 포트는 `127.0.0.1`에만 열립니다. 이 PC 밖에서는 접속할 수 없습니다.
- 서버는 `Host`가 localhost가 아니거나 `Origin`이 다른 사이트인 요청을 거부합니다. 다른 웹사이트가 브라우저를 통해 이 서버에 명령을 보낼 수 없게 하려는 것입니다.
- Claude의 도구 권한은 `.claude/settings.json` 규칙을 그대로 따릅니다. 규칙에 없는 작업은 대화창에 허용/거부 카드로 뜹니다. "이 세션에서 항상 허용"은 그 세션에만 적용되고 설정 파일에 저장되지 않습니다.
- 파일 API는 `cv/`, `cover_letters/`, `documents/`, `reports/`, `upskill/`, `company_research/`, `templates/`와 `CLAUDE.md`, `job_search_tracker.csv`만 읽습니다. `.env`와 `.git`은 읽을 수 없습니다.

## 컨테이너 없이 실행

```bash
cd web && bun install && bun run start   # http://localhost:3000
```

호스트의 Claude Code 로그인을 그대로 씁니다. 개발 중에는 `bun run dev`로 자동 새로고침을 켤 수 있습니다. 테스트는 `bun test`, 타입 검사는 `bun run typecheck`로 실행합니다.

**macOS 등 Linux가 아닌 환경에서는 웹 UI의 파일 읽기·업로드가 기본으로 꺼집니다.** 파일 API는 저장소 밖으로 빠져나가지 못하게 폴더를 한 단계씩 열어 확인하는데, 이 방식(`/proc/self/fd`)은 Linux에만 있습니다. 다른 환경에서는 경로만 보고 확인할 수밖에 없고, 그 사이에 다른 프로그램이 폴더를 링크로 바꿔치기하면 저장소 밖 파일을 읽거나 덮어쓸 수 있습니다. 그래서 기본은 차단이고 대시보드에 안내가 뜹니다(대화창은 그대로 쓸 수 있습니다). 저장소에 쓸 수 있는 프로그램을 모두 신뢰할 때만 다음처럼 켜세요.

```bash
AJS_INSECURE_PATH_CHECKS=1 bun run start
```
