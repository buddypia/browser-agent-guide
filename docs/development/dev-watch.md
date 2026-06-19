# Dev Watch — brief2dev WebUI 가동 + 핫리로드

> ✅ **Verified (2026-05-16)**: `make dev.up` / `make dev.down` / `make dev.test` / `make dev.full` 4 타깃 모두 `Makefile` 에 실재 — 본 문서의 명령은 그대로 사용 가능.

## 한 줄 요약

`make dev.up` 으로 brief2dev WebUI 를 백그라운드에 띄우고, `.claude/scripts/` 의 코드를 수정하면 Node 22 내장 `--watch` 가 자동으로 webui 를 재기동한다. 외부 devDependency 없음.

## 빠른 시작

```bash
# 1) WebUI + scripts watch (백그라운드)
make dev.up
# → http://127.0.0.1:4173

# 2) (선택) 같은 터미널/다른 터미널에서 vitest 동시 가동
make dev.test
# → vitest --watch

# 3) WebUI 정지
make dev.down
```

`make dev.full` 은 위 1+2 의 사용법을 한 번에 안내한다 (실제로 자동으로 두 프로세스를 띄우진 않는다 — `concurrently` 같은 외부 의존성을 추가하지 않기 위함).

## 명령 카탈로그

| 명령 | 동작 | 비고 |
|------|------|------|
| `make dev.up` | stale PID 자동 정리 → 포트 점유 사전 검사 (lsof) → `node --watch` 백그라운드 spawn → `curl --retry` listen 검증 후 성공 보고 | 이미 가동 중이면 멱등 안내. 점유자가 따로 있으면 exit 1 + 점유 PID 표시. listen 실패 시 PID 파일 회수 후 exit 1 |
| `make dev.down` | `.tmp/dev-up.pid` 의 프로세스 종료 + PID 파일 정리 | 실행 중이 아니면 안내만 출력 (멱등) |
| `make dev.test` | `npx --no-install vitest` (watch 모드) | vitest 4.x 의 기본 모드가 watch — 포그라운드 |
| `make dev.full` | 두 명령 사용법 안내 | 실제 가동 X — 사용자 컨펌 의도 보존 |

### 환경 변수

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `WEBUI_HOST` | `127.0.0.1` | WebUI bind host |
| `WEBUI_PORT` | `4173` | WebUI bind port |
| `WEBUI_HEALTH_PATH` | `/api/sessions` | listen 검증에 사용할 webui endpoint (200 응답 = listen 성공). **`brief2dev-webui.mjs` 의 라우트가 바뀌면 본 default 도 함께 갱신**하거나 호출 시 override |
| `WEBUI_HEALTH_RETRIES` | `30` | listen 검증 재시도 (100ms 간격 × 30 = 최대 3s 대기) |

예: `make dev.up WEBUI_PORT=4200 WEBUI_HEALTH_RETRIES=60`

## 동작 원리 (Node 22 `--watch`)

`node --watch <entry>` 는 entry 파일이 import 하는 **모든 의존 ESM 파일** 의 변경을 자동 감지하고 프로세스를 재기동한다. 따라서 `.claude/scripts/brief2dev-webui.mjs` 를 entry 로 지정해두면 `.claude/scripts/lib/*.mjs` (saga-manager, multi-session-discovery, research-library-aggregator, pipeline-config) 변경도 자동으로 잡힌다. 별도 `chokidar` / `nodemon` / `concurrently` 같은 의존성이 필요 없다.

### Watch 대상에서 빠지는 것

- `webui/observatory/` 의 정적 자산 (HTML/CSS/JS) — 서버는 매 요청마다 `createReadStream` 으로 디스크에서 읽으므로 **브라우저 새로고침만 하면** 최신 자산이 반영된다. 서버 재기동 불필요.
- `.brief2dev/run/active.json` 같은 런타임 상태 — Observatory 의 `/api/sessions` 가 매 요청마다 다시 읽으므로 watch 불필요.

## 안전 가드 (다중 세션 / 다중 worktree 환경)

`make dev.up` 은 다음 3 가지 race 함정을 자동 차단한다 (2026-05-15 도입):

1. **Stale PID 자동 정리** — PID 파일 있는데 프로세스가 죽었으면 silent 제거 후 새 시작 진행. 사용자가 `rm .tmp/dev-up.pid` 를 손으로 할 필요 없음.
2. **포트 점유 사전 검사** — `lsof -tnP -iTCP:$WEBUI_PORT -sTCP:LISTEN` 으로 점유 PID 확인. 다른 프로세스가 점유 중이면 **EADDRINUSE 즉사 후 silent 실패** 대신 명시적으로 exit 1 + 점유 PID + 우회 명령 (`kill <pid>` 또는 `WEBUI_PORT=4274 make dev.up`).
3. **Listen 성공 검증** — spawn 후 `curl --retry` 루프로 `http://$HOST:$PORT$WEBUI_HEALTH_PATH` 가 200 을 돌려줄 때까지 100ms 간격 최대 `WEBUI_HEALTH_RETRIES` 회. 통과 시 "listen OK (Nx100ms)" 표시. 실패 시 PID 파일 회수 + exit 1. sleep 운 의존 race 제거.

이 가드 덕분에 사용자의 다른 세션이 같은 포트로 webui 를 띄워둔 상황에서 새 `make dev.up` 이 silent 으로 측정 오류 (다른 인스턴스 응답을 자기 것으로 오인) 를 일으키는 사고를 차단한다.

## 로그 / 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------------|
| `❌ dev.up: 포트 N 이미 사용 중 (PID=X)` | 다른 세션/프로세스가 점유. 안내된 `kill X` 또는 `WEBUI_PORT=4274 make dev.up` 사용 |
| `❌ dev.up: listen 실패 (Nx100ms)` | webui 가 spawn 됐지만 `WEBUI_HEALTH_RETRIES * 100ms` 안에 응답 없음. `cat .tmp/dev-up.log` 로 stdout/stderr 확인. cold-start 가 느린 환경이면 `WEBUI_HEALTH_RETRIES=60` |
| `ℹ️  dev.up: stale PID 정리` | PID 파일이 살아있던 인스턴스가 죽은 뒤 남은 경우. dev.up 이 자동 정리 후 새 인스턴스 시작 |
| 코드 수정 후 재기동 안 됨 | entry 가 import 하지 않는 파일은 watch 안 됨. import 경로 확인 |

`.tmp/` 는 `.gitignore` 의 `.tmp/` 패턴으로 머지 누출이 차단된다.

## 관련 문서

- WebUI 는 read-only Observatory 다. read-only invariant + 서버/API 계약은 [`.claude/rules/common/readonly-dashboard-invariant.md`](../../.claude/rules/common/readonly-dashboard-invariant.md) (R-CM-035) 참조. 본 문서는 **개발 가동 흐름 (가동 + watch + 정지)** 만 다룬다.

## 적용 범위 (R-CM-028 boundary)

본 명령은 **관점 1 (brief2dev 자체)** 의 개발 도구다. WebUI 와 scripts watch 는 brief2dev 리포에서만 의미가 있고, scaffold target (생성된 프로젝트) 에는 적용되지 않는다 — scaffold target 의 dev 가동은 해당 프로젝트의 stack 에 맞는 dev server (Next.js `next dev`, Flutter `flutter run` 등) 를 사용한다.

## Why `node --watch` (의존성 비교)

| 옵션 | LOC | devDep | 비고 |
|------|-----|--------|------|
| **`node --watch` (현재 선택)** | ~50 | 0 | Node 22+ 내장. transitive import 자동 watch |
| `nodemon` | ~20 | 1 (nodemon) | 친숙하지만 별도 config 파일 (`nodemon.json`) 필요 |
| `concurrently` + `chokidar-cli` | ~30 | 2 | 멀티 프로세스 통합 가능. 의존성 증가 |

`node --watch` 는 `package.json` `engines` 가 Node 22 이상을 요구하는 경우 (현재 환경: v22.22.0) 가장 단순하다. 사용자 결정: "표준 도구만 사용".

## Source

- Node.js v22 `--watch` 플래그: https://nodejs.org/docs/latest-v22.x/api/cli.html#--watch
- 사용자 결정 (2026-05-15): A안 (WebUI + scripts watch) + 표준 도구 (외부 의존성 X)
- WebUI entry: `.claude/scripts/brief2dev-webui.mjs` (기본 host `127.0.0.1`, port `4173`)
