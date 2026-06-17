# Handoff: 브라우저 그림+메모 → 범용 AI 코딩 CLI vision 피드백 브리지

> 작성일: 2026-06-17 · 작성 맥락: brief2dev 세션에서의 조사·설계 결론을 이 리포(`chrome-extension-ai-advisor`)로 이관.
> 이 문서는 self-contained 핸드오프다. **이 문서만 읽고 작업을 시작할 수 있게** 작성했다. 실제 코드 변경은 전부 이 리포(+ 신규 데몬 패키지)에서 한다. brief2dev 본체는 이 시스템의 *소비자*일 뿐 코드가 들어가지 않는다.

---

## 0. 한 줄 요약

브라우저 화면에 그린 주석(그림+메모)을 **이미지(vision)로** Claude Code / Codex CLI / Antigravity에 전달한다. 텍스트 변환이 아니라 실제 그림을 모델이 본다. 핵심 메커니즘은 **확장 →(WebSocket)→ 로컬 릴레이 데몬 →(MCP image content + 파일경로)→ AI CLI**.

---

## 1. 목표 / 배경

- **문제**: 사용자가 "UI의 이 부분을 이렇게 고쳐줘"를 말로 설명하기 어렵다. 화면에 그림으로 표시하는 게 직관적이다.
- **현재 확장(Browser Agent Guide)의 한계**: "Copy context" 버튼이 그림을 `describeShapes()`로 **일본어 자연어 텍스트로 변환**할 뿐, 이미지가 아니다 → 그림의 위치·모양·뉘앙스가 뭉개진다. **이게 "연동이 안 되는" 근본 원인.**
- **목표**: 주석을 **PNG 이미지로 캡처**해서 AI 모델이 **vision으로 직접 보게** 한다. 특정 CLI에 종속되지 않는 방식.
- **사용자가 실제 쓰는 CLI 3개**: Claude Code, OpenAI Codex CLI, Google Antigravity(= 구 Gemini CLI 후신).

---

## 2. 조사 결론 (2026-06 기준, 출처는 §9)

### 2.1 핵심 사실: AI CLI는 로컬 이미지 파일을 vision으로 본다
거의 모든 AI 코딩 CLI가 로컬 PNG를 vision으로 읽는다(입력법만 다름). 이것이 **유일하게 3개 전부에서 검증된 최소공통분모**다.

### 2.2 3 CLI의 MCP 이미지 vision 매트릭스 (★ 중요 정정 포함)

| CLI | MCP image content → vision | 로컬 파일 fallback | 근거 |
|---|:---:|:---:|---|
| **Claude Code** | ✅ 확실 | ✅ 경로 멘션 / 드래그 / Ctrl+V | 커뮤니티 vision MCP 서버로 검증 |
| **Codex CLI** | ✅ 확실 **(정정됨)** | ✅ `--image` 플래그 / `view_image`(풀해상도) | **PR #5600 (2025-10-27) 머지** + Issue #11845 (2026-02) 재확인. 그 이전의 "Codex가 MCP 이미지를 못 본다"는 STALE |
| **Antigravity** | ❓ **불확실** | ✅ IDE 붙여넣기 / 드래그 (단 **CLI TUI 붙여넣기 불가**) | 공식 문서가 MCP `type:image`의 vision 소비를 명시 안 함. IDE는 Artifacts(표시용)로만 surface. Managed API Agent 변종은 MCP 자체 미지원 |

**결론**: MCP image 경로는 **3개 중 2개(Claude Code, Codex)에서 확실**, Antigravity만 불확실. → **MCP를 1차 채널로 쓰되, 같은 데몬이 파일경로 fallback을 항상 함께 제공**해야 3개 전부 커버된다.

### 2.3 Antigravity 정체 (사용자 "구 Gemini CLI" 표현 검증)
- Antigravity는 Gemini CLI의 rebrand이 아니라 별개의 agentic IDE(2025-11 출시, VS Code fork)지만, **2026-05-19(Google I/O)에 Gemini CLI → Antigravity CLI 전환 발표**. 독립 Gemini CLI는 **2026-06-18 개인 사용자 서비스 종료**(엔터프라이즈 유지). Antigravity CLI는 Go로 재작성.
- 3 표면(surface)별 동작 상이: **IDE**(풀 MCP + 직접 vision) / **CLI(Go)**(MCP config 공유, TUI 클립보드 붙여넣기 불가) / **Managed API Agent**(MCP 미지원).
- ⚠️ 작업 시 **어느 Antigravity 표면을 쓰는지** 먼저 확정할 것. MCP image vision은 표면별로 다르고 전부 미검증.

### 2.4 확장은 MCP 서버가 될 수 없다 → 릴레이 데몬 필수
브라우저 확장은 샌드박스(stdio 없음)라 MCP 서버가 못 된다. 모든 기존 구현(claude-browser-bridge, YetiBrowser, mcp-b/websocket-bridge)이 **별도 로컬 데몬**을 쓴다.

---

## 3. 권장 아키텍처

### 3.1 토폴로지 (권장: 상시 단일 데몬)

```
                          ┌──────────── 상시 로컬 데몬 (Node, 1개) ────────────┐
 Chrome 확장 ──WebSocket──┤  WS 서버(토큰 인증)  ◀──▶  내부 메시지 버스          │
 (MV3 SW, ~25s ping,      │       │ 수신: 주석 PNG + annotation JSON           │
  주석 PNG push)          │       ▼ 디스크 저장: <proj>/.ai-inbox/...          │
                          │  Streamable HTTP MCP 서버  http://127.0.0.1:<P>/mcp │
                          └───────────────────┬────────────────────────────────┘
                                              │ (3 CLI가 같은 엔드포인트)
              ┌───────────────────────────────┼────────────────────────────────┐
        Claude Code (remote MCP)        Codex CLI (url=...)        Antigravity (serverUrl=...)
              MCP image ✅               MCP image ✅               MCP image ❓ → 파일경로 fallback
```

**선택 근거**:
- 3 CLI 모두 stdio + Streamable HTTP MCP 지원 → **단일 HTTP MCP 데몬에 셋이 동시 접속**(stdio는 1-client 모델이라 멀티세션에 IPC 우회 필요 → HTTP가 단순).
- 상시 데몬 = 고정 포트 → 확장의 포트 탐색/spawn 타이밍 문제 소멸.
- 확장↔데몬은 **WebSocket** (HTTP POST 아님): Chrome 142+ Local Network Access(LNA) fetch 차단 회피 + MV3 service worker 수명 자동 연장(Chrome 116+, 활성 WS 트래픽이 idle 타이머 리셋) + 양방향.

### 3.2 MCP tool 스키마 (핵심 — fallback 내장)

```
tool: get_latest_visual_feedback()  // 또는 list + get by id
  returns content[]:
    1. { type: "image", data: "<base64 PNG>", mimeType: "image/png" }   // Claude/Codex 자동 vision
    2. { type: "text", text: "file_path: /abs/.ai-inbox/<slug>/shot.png\nmemo: ...\nselector: ..." }
       // Antigravity 등 MCP image 미소비 도구 → 이 경로를 IDE에 첨부/드래그
```
- **항상 image content + 파일 절대경로를 둘 다 반환**한다. 그래야 MCP image를 못 보는 도구도 경로로 우회한다.
- `annotation.json`(좌표/selector/testid/intent)도 text로 동봉 → 모델이 "정확히 어느 DOM 요소"인지 보강.

---

## 4. 구현 컴포넌트

### 4.1 Browser Agent Guide 확장 변경
현재 상태(참고): MV3, side panel + content script(2554L) + service worker. 그림=SVG 좌표 JSON(앵커 비율 0..1) + DOM 앵커(selector/text/testid). 메모=annotation{anchor,note,intent,shapes,forAI}. 저장=`chrome.storage.local`(`aiAdvisorAnnotations`). 권한=storage, sidePanel, scripting, tabs, userScripts + host_permissions `<all_urls>`. **없는 권한: offscreen, downloads, nativeMessaging.**

변경 사항:
1. **권한 추가**: `offscreen`(필수), `downloads`(MVP fallback용). `host_permissions`에 `ws://127.0.0.1:*/`는 불필요(WS는 host_permissions 무관)하나 데몬 health용 HTTP를 쓰면 `http://127.0.0.1:*/` 추가.
2. **합성 모듈 (신규 ~150 LOC, 가장 위험한 자산)**:
   - MV3 service worker엔 DOM/Canvas가 없다 → **`chrome.offscreen` Offscreen Document**에서 합성.
   - `captureVisibleTab()` PNG를 `OffscreenCanvas`에 그리고, 그 위에 **Canvas 2D API(`strokeRect`/`moveTo`/`lineTo`/`fillText`)로 화살표·박스·번호배지·메모를 직접 렌더**.
   - ⚠️ **SVG `foreignObject` 금지**: canvas가 taint되어 `convertToBlob()`이 `SecurityError`를 던진다(브라우저 미해결). 반드시 Canvas 2D로 직접 그릴 것.
   - **DPR 정합**: 좌표 = CSS px × `devicePixelRatio`. 틀리면 화살표가 밀린다. → 회귀 fixture로 고정.
   - **2000px 다운스케일 가드**: HiDPI(DPR 2~3)에서 합성 PNG가 2000px 초과는 흔하고, vision API가 거부하면 세션이 조용히 brick된다. 초과 시 다운스케일 + 좌표 동시 스케일.
   - `captureVisibleTab`은 **보이는 영역만** 캡처 → 캡처 직전 앵커로 `scrollIntoView`. cross-origin iframe/WebGL은 검게 캡처(브라우저 정책, 회피 불가).
3. **버튼 2개**:
   - **"Send to inbox"**: 합성 PNG + annotation JSON을 데몬에 WebSocket push (background service worker에서만).
   - **"Copy as image"**: `navigator.clipboard.write(ClipboardItem image/png)` — 데몬 없이도 붙여넣기로 우회하는 백업.
4. 기존 `describeShapes`(일본어 텍스트)는 폐기하지 말고 `memo.md`의 한 섹션(텍스트 fallback)으로 강등.

### 4.2 로컬 데몬 (신규 패키지, ~400 LOC)
- WebSocket 서버(확장용) + Streamable HTTP MCP 서버(CLI용)를 **한 프로세스**가 노출.
- 수신한 PNG를 `.ai-inbox/`에 디스크 저장 + MCP tool로 image content & 파일경로 노출.
- 2000px 가드(미적용 시 데몬 쪽에서라도), atomic write(`writeFileSync(tmp)→renameSync`), 0600 perms.
- 참고 구현: `claude-browser-bridge`(포트 7225 고정 + 재연결 backoff 1s→30s), `mcp-b/websocket-bridge`(connection ID 라우팅), YetiBrowser(stdio + WS 동시).

### 4.3 출력 폴더/파일 컨벤션
```
<projectRoot>/.ai-inbox/
  <ISO8601-slug>/
    shot.png          # 합성본(주석 burn-in) — vision 1차
    raw.png           # 원본(선택)
    annotation.json   # 좌표/selector/testid/intent (텍스트 fallback)
    memo.md           # 사람 읽기 + describeShapes 섹션
  LATEST.md           # 최신 N개: 상대경로 PNG 링크 + memo + "이 CLI에서 첨부법" 헤더
  index.json          # append 로그(status: pending/consumed)
  done/               # AI 처리 후 이동
```
`.gitignore`에 `.ai-inbox/` 추가. `LATEST.md`가 CLI 단일 진입점.

### 4.4 3 CLI MCP config (같은 데몬, 키만 다름)
```toml
# Codex CLI — ~/.codex/config.toml
[mcp_servers.visual_feedback]
url = "http://127.0.0.1:<PORT>/mcp"
bearer_token_env_var = "VISUAL_FEEDBACK_TOKEN"
```
```json
// Antigravity — ~/.gemini/config/mcp_config.json
{ "mcpServers": { "visual_feedback": { "serverUrl": "http://127.0.0.1:<PORT>/mcp", "headers": { "Authorization": "Bearer ..." } } } }
```
```
# Claude Code — claude mcp add (remote/HTTP MCP) 또는 .mcp.json
```
⚠️ **config 키 함정**: HTTP URL 키가 CLI마다 다르다 — Codex=`url`, Antigravity=`serverUrl`, Claude Code=별도. 같은 데몬을 가리키되 작성법은 CLI별로 맞춘다.

### 4.5 보안 (필수)
- **WebSocket 토큰 인증 필수** (CVE-2025-52882 교훈): localhost WebSocket은 same-origin policy를 안 받아 **악성 웹페이지가 붙을 수 있다 — localhost 바인딩은 격리가 아니다.** 토큰 헤더/쿼리로 확장만 허용.
- 멀티 프로젝트 경로 화이트리스트: 등록 루트 N개를 `realpathSync` + 포함검사(OR) + 심링크 `lstat` 차단 + `.ai-inbox` 하위 한정 + traversal 차단. (gstack `SAFE_DIRECTORIES`는 단일 cwd 고정이라 그대로 재사용 불가 — 신규 작성.)

### 4.6 AGENTS.md / CLAUDE.md 룰 문구 (소비 프로젝트에 추가)
```markdown
## Visual feedback inbox
브라우저에서 시각 피드백(주석 스크린샷)을 받으면:
1. MCP tool `get_latest_visual_feedback` 를 호출하거나, 없으면 `.ai-inbox/LATEST.md`를 읽는다.
2. 거기 image(또는 링크된 shot.png)를 **이미지로 vision 해석**한다. 텍스트 좌표(annotation.json)가 아니라 그림 자체를 봐야 한다.
3. 처리 후 항목을 `.ai-inbox/done/`으로 옮기고 index.json status를 consumed로 기록한다.
```
(Claude는 `CLAUDE.md`, 그 외는 `AGENTS.md` — 심링크로 통일 가능.)

---

## 5. 단계 로드맵

| Phase | 범위 | 산출물 | 검증 |
|---|---|---|---|
| **0 (MVP)** | 데몬·MCP 없이 | 확장 "Send"→Offscreen Canvas burn-in PNG→`chrome.downloads`로 `Downloads/ai-inbox/<ts>/shot.png`+memo.md 저장 | Claude Code/Codex에서 경로 멘션(`--image`)→**(A) 합성 PNG가 실제 vision으로 들어가는가 (B) DPR 좌표 정합** 육안 확인 |
| **1** | 데몬 + MCP | 상시 데몬(WS+HTTP MCP), `get_latest_visual_feedback` tool(image+경로) | Claude Code/Codex가 MCP로 자동 vision 소비 |
| **2** | 견고화 | Antigravity fallback 실측, 토큰 인증, 멀티프로젝트 화이트리스트, 2000px 가드, 재연결 | Antigravity 표면별 vision 동작 확정, 보안 |
| **3** | brief2dev 소비자 통합 | loom(localhost:4173)이 게이트 차트 표시 + brief2dev `CLAUDE.md`에 `.ai-inbox` 룰 | brief2dev 게이트 위 주석 → CLI 참고 (이건 brief2dev 리포에서 별도 작업) |

**MVP부터 시작할 것** — 데몬/MCP/멀티프로젝트 인프라 없이 핵심 가설 2개만 먼저 검증. 통과 후에만 확장.

---

## 6. 정직한 불확실 / 리스크

1. **Antigravity MCP image vision 미검증** — 공식 문서 부재. Phase 2에서 실측 필요. 안 되면 파일경로 fallback이 1순위(IDE 첨부). CLI TUI는 붙여넣기 불가라 IDE 권장.
2. **Chrome 142+ Local Network Access** — 확장 service worker→localhost **fetch**는 차단될 수 있다(확장 origin은 loopback 미분류, SW는 권한 프롬프트 자체 호출 불가). → **WebSocket 사용으로 현재 회피**. 단 Google이 LNA를 WebSocket/WebTransport/WebRTC로 **확대 예정**이라 장기 모니터링 필요. MVP는 `chrome.downloads`라 무관.
3. **합성 fidelity가 구현 품질에 전적 의존** — DPR 정합 틀리면 화살표 밀림, foreignObject 쓰면 SecurityError. Canvas 2D 직접 렌더 + 회귀 fixture 필수.
4. **MV3 service worker 수명** — WebSocket 활성 트래픽(~25s ping)으로 유지되나, 더 견고하려면 offscreen document에서 WS 호스팅.
5. **captureVisibleTab은 viewport 한정** — 스크롤 밖 주석 누락, cross-origin iframe/WebGL 검게 캡처(회피 불가). 풀페이지 stitch는 후속.
6. **신규 코드 분량 정직화** — "확장 변경 최소"는 거짓. 합성 모듈 + 데몬 + 멀티프로젝트 보안 화이트리스트는 전부 신규 위험 자산. MVP(데몬 없음)부터 증거 확보 후 단계 확장.
7. **폴더 자동 폴링 부재** — 어떤 CLI도 `.ai-inbox`를 감시하지 않는다. MCP tool 호출 또는 룰+사용자 한마디("inbox 봐줘")가 트리거. 100% 자동은 Claude Code/Codex의 MCP 경로에서만 근접.

---

## 7. 의사결정 기록 (왜 이렇게 정했나)

- **MCP를 1차로 쓰되 파일경로 fallback 병행**: 처음엔 "MCP가 범용이 아니다(2~3 CLI만)"였으나, Codex가 MCP image를 본다는 정정(PR #5600) + 사용자가 MCP OK → Claude/Codex 2개는 MCP 자동, Antigravity만 파일 fallback. 한 데몬이 둘 다 노출하면 3개 전부 커버.
- **WebSocket(확장↔데몬), HTTP MCP(데몬↔CLI)**: WS는 LNA 회피+SW 수명+양방향, HTTP MCP는 멀티 CLI 동시 접속 단순.
- **brief2dev에 안 넣는 이유**: 이 코드는 chrome-extension + 신규 데몬 소속. brief2dev는 소비자일 뿐(파이프라인 산출물과 무관 → brief2dev "새 기능 자문" 위반). brief2dev 거버넌스(q.check/hook)가 외부 작업에 마찰.

---

## 8. 다음 작업자 시작 가이드 (Phase 0)

1. 이 리포에서 새 AI 세션을 연다(brief2dev 아님).
2. `manifest.json`에 `offscreen`, `downloads` 권한 추가.
3. Offscreen Document + 합성 모듈 작성(Canvas 2D burn-in, DPR 정합, 2000px 가드). **회귀 fixture부터**(TDD): 같은 입력 → byte-안정 PNG, SecurityError 부재, 2000px 경계.
4. side panel에 "Send to inbox" 버튼 → 합성 PNG를 `chrome.downloads`로 저장.
5. Claude Code/Codex에서 그 PNG 경로를 vision으로 열어 (A)(B) 가설 확인.
6. 통과 후 Phase 1(데몬+MCP)로.

---

## 9. 참고 링크 (조사 출처)

- MCP Spec / Tools (image content): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Spec / Resources (blob): https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- Codex MCP image 렌더 PR #5600: https://github.com/openai/codex/pull/5600 · Issue #11845: https://github.com/openai/codex/issues/11845
- Codex MCP 설정: https://developers.openai.com/codex/mcp · config: https://developers.openai.com/codex/config-reference
- Antigravity MCP: https://antigravity.google/docs/mcp · Gemini CLI→Antigravity 전환: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- Antigravity Agent(API, MCP 미지원): https://ai.google.dev/gemini-api/docs/antigravity-agent
- claude-browser-bridge: https://github.com/softwaresoftware-dev/claude-browser-bridge
- YetiBrowser MCP: https://deepwiki.com/yetidevworks/yetibrowser-mcp/2.1-installing-the-mcp-server
- @mcp-b/websocket-bridge: https://www.npmjs.com/package/@mcp-b/websocket-bridge
- chrome-devtools-mcp(확장 없이 CDP): https://github.com/ChromeDevTools/chrome-devtools-mcp
- 확장↔AI 브리지 패턴(코드 수준): https://dev.to/chengyixu/building-chrome-extensions-that-bridge-ai-agents-to-your-browser-168h
- CVE-2025-52882 (WebSocket 인증 우회): https://securitylabs.datadoghq.com/articles/claude-mcp-cve-2025-52882/
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access
- MV3 service worker lifecycle: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- 선례: Drawbridge(.moat 파일 드롭) https://github.com/breschio/drawbridge · Snip https://snip-browser.dev/
