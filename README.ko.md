# Browser Agent Guide 🧭 — 결정적 페이지 에이전트 (Chrome 확장)

> 브라우저를 조작하는 AI가 탈선하지 않도록 잡아 주는 가드레일과 가이드.

[English](README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh.md)

---

**Browser Agent Guide**는 **비개발자**도 **클릭만으로** 웹 페이지에 메모와
**그리기(요소를 원/사각형/화살표/펜으로 둘러싸기)** 를 붙일 수 있는 Chrome (Manifest V3) 확장입니다(표식·신호 버튼은 AI가 동사 레지스트리로 붙입니다).
이를 통해 브라우저를 조작하는 AI(이 확장의 채팅 또는 외부 AI 채팅 UI)가 페이지 맥락을 이해하고
결정적으로 동작합니다.

주석은 **페이지 단위(origin + path)로 영속화**되고 **방문할 때마다 같은 위치로 복원**됩니다(재현성).
각 대상 요소는 **다중 신호 기반의 견고한 앵커**(안정 ID 경로, `data-testid`, `name`, `aria-label`, 텍스트 일치)로
매번 다시 해석되므로 *항상 같은 요소를 찾아냅니다*(결정성). **맥락 복사** 버튼은 외부 AI 채팅에
붙여 넣을 수 있는 결정적 페이지 설명을 내보냅니다.

사이드 패널 채팅에서 AI(Structured Outputs)에게 직접 지시할 수도 있지만, AI는 오직
**닫힌 결정적 동사 레지스트리**(`clickAffordance`, `fillAffordance`, `markElement`, `addNote` …)만 사용합니다.
**안정적인 요소 ID**와 **Structured Outputs**가 결합되어 *같은 프롬프트가 같은 동작을 만들어 냅니다*.

> 용어: "보충(메모)을 붙이는" 동작은 내부적으로 **주석(annotation)** 으로 저장됩니다.
> 클릭으로 붙이는 것은 **💬메모(AI에게 줄 지시)** 와 **🖍그리기(요소를 원/사각형/화살표/펜으로 둘러싸기)** 입니다.
> **📌표식(요소에 결정적인 이름 부여)** / **🔘신호 버튼** 은 AI가 붙이는 종류입니다.

## 왜 가드레일인가

| 목표 | Browser Agent Guide의 구현 |
| --- | --- |
| AI 연동 + Structured Outputs | 서비스 워커가 엄격한 JSON Schema(`reply` + `actions`)로 AI를 호출 |
| API 키 저장 | 옵션 페이지에서 설정하며 `chrome.storage.local`에만 저장 |
| 필요한 페이지 기억 | 주석 저장이나 채팅 기반 페이지 변경 후 규칙을 자동 추가. 주입 기억 범위는 현재 URL / 현재 도메인 / 모든 사이트 중 선택 가능하며 수동 편집도 가능 |
| 사이드바에서 보조 UI 심기 | AI는 안전한 동사 레지스트리 동작을 사용. 명시적으로 요청된 HTML / CSS / JS 주입은 재적용 레시피로 저장 가능 |
| 결정적·일관된 동작 | AI는 등록된 동사만 사용 가능. 요소에는 안정적인 `aiId` 부여. 레시피는 로드할 때마다 재적용 |

AI는 원시 DOM 호출을 즉흥적으로 하지 않습니다. **동사 레지스트리**에서 선택하므로 동작이
예측 가능합니다: *같은 지시 → 같은 동사 → 같은 결과*.
페이지 텍스트와 HTML 속성은 신뢰할 수 없는 데이터로 취급합니다. `setStyle`, `removeElement`,
`defineMarker` 같은 고위험 DOM 변경 동사는 채팅 AI에게 숨겨지고 채팅 / 자동 레시피 실행 경로에서
거부됩니다. `injectHtml`, `injectCss`, `injectScript`는 사용자가 명시적으로 요청한 페이지 추가에만
사용되며 성공 시 재적용 레시피로 저장됩니다. `injectScript`는 Chrome User Scripts API를 통해
실행되므로 페이지의 인라인 스크립트 CSP에 의존하지 않습니다.

## 설치 (압축 해제된 확장)

1. `chrome://extensions` 열기
2. **개발자 모드** 켜기
3. **압축 해제된 확장 프로그램 로드** → 이 폴더 선택
4. 도구 모음 아이콘을 클릭해 사이드 패널 열기

> Chrome 135 이상 필요 (Side Panel API + User Scripts API).
> Chrome 138 이상에서 `injectScript`를 사용하려면 확장 세부 정보 페이지에서 **Allow User Scripts**를 켜세요.

## 초기 설정

1. 아이콘 우클릭 → **옵션** (또는 사이드 패널의 **설정** 버튼)
2. **① AI 연결** — 제공자(OpenAI / Anthropic / Gemini / OpenAI 호환 커스텀) 선택 후 API 키와 모델을 입력하고 저장
   - OpenAI 호환: `response_format: json_schema`에 `strict: true` 사용
   - Anthropic: `tool_choice`로 구조화 출력을 강제
   - Gemini: `generationConfig.responseMimeType: "application/json"`과 `responseJsonSchema` 사용
3. **② AI 주입 자동 저장**에서 주입한 HTML / CSS / JS를 현재 URL / 현재 도메인 / 모든 사이트 중 어디에 저장할지 선택
4. 주석을 저장하거나 채팅으로 페이지를 변경하면 Browser Agent Guide가 해당 범위를 자동으로 기억
5. 필요 시 **③ 기억된 URL / 활성화 규칙**과 **④ 기억 규칙**(매 로드 시 재적용되는 동사)을 편집

## 사용법

아무 페이지나 열고 사이드 패널 채팅에 자연어 지시를 입력하세요:

- "로그인 버튼을 찾아서 강조해 줘"
- "오른쪽 아래에 *요약* 버튼을 심어 줘. 이 페이지를 AI에게 요약 요청하는 용도야"
- "검색창에 *Chrome 확장* 을 입력하고 제출해 줘"
- "이 페이지에 고정 안내문을 주입하고 다음에도 계속 보여 줘"
- "이 도메인에서 제목이 더 잘 보이도록 CSS를 주입해 줘"

AI는 구조화된 `reply`(설명)와 `actions`(동사)를 반환하며 순서대로 실행됩니다. 각 동사의 결과는
채팅에 인라인으로 표시됩니다. 주석 저장이나 채팅 기반 페이지 변경이 성공하면 선택한 URL / 도메인 /
모든 사이트 범위와 영속 재적용 규칙이 자동으로 기억됩니다. `outlineElement` 같은 저장된 시각적
변경은 페이지 새로고침 후에도 재적용됩니다. 되돌리려면 설정에서 해당 기억된 URL이나 기억 규칙을
삭제한 뒤 페이지를 새로고침하세요.

도구 모음:
- **단서 남기기**: **메모 추가**(요소를 클릭해 AI용 메모 1개 첨부; 대상은 빨간 테두리로 표시)와 **그리기**(원/사각형/화살표/펜으로 대상을 표시하고 코멘트 첨부).
- **AI에게 알려주기**: **AI용 복사**로 URL, 제목, 저장된 단서, 조작 가능한 요소를 다른 AI 채팅에 붙여 넣을 텍스트로 만듭니다. 그림이 있으면 **이미지로 AI에 보내기**로 시각 단서도 전달할 수 있습니다.
- **페이지 확인**: **요소 보기**로 현재 조작 가능한 요소를 나열합니다.
- **기록**은 보낸 프롬프트를 재사용합니다(입력란 끝에서 ↑/↓로도 가능). **설정**은 AI 연결, 기억 URL, 재방문 규칙을 엽니다.

### 그리기 (요소를 원/사각형/화살표/펜으로 둘러싸기)

**🖍 お描き/그리기**를 눌러 그리기 모드로 들어가 페이지 위에 스케치하고(◯원 / ▭사각형 / ↗화살표 / ✎펜 + 색),
**완료**를 눌러 AI용 지시 1개를 첨부합니다. 각 그림은 **둘러싼 요소에 앵커**되며 좌표는
**요소 박스의 비율**로 저장되므로, 그림이 요소를 따라가고 **재방문·스크롤·리플로우에도 같은 위치로
복원**됩니다. AI는 평이한 설명(예: *"빨간색 원으로 표시. 코멘트: …"*)을 받으므로
"여기를 봐 / 이 표시한 부분을 고쳐"같은 지시가 정확히 전달됩니다. 저장된 그림은
"이 페이지의 단서" 목록에서 편집·삭제할 수 있습니다.

## 동사 레지스트리 (발췌)

`content/content-script.js`의 `AI_VERBS`로 구현됩니다. 모든 함수 이름이 곧 동사입니다.

| 동사 | 용도 |
| --- | --- |
| `annotatePage` / `listAffordances` | 안정 ID 부여 / 상호작용 요소 목록 |
| `clickAffordance` / `clickElement` | 클릭 |
| `fillAffordance` / `fillInput` / `selectOption` | 입력 / 선택 |
| `submitForm` / `focusElement` / `scrollToElement` | 제출 / 포커스 / 스크롤 |
| `highlightElement` / `outlineElement` | 임시 강조 / 영속 테두리 |
| `injectHtml` / `injectCss` / `injectScript` | 명시적 HTML / CSS / JS 주입 및 재방문 시 재적용 |
| `injectButton` / `injectPanel` | 신호 버튼과 살균된 패널 심기 |
| `waitForElement` | 요소 대기 |
| `navigateTo` / `goBack` / `notify` | 이동 / 토스트 |
| `readText` / `extractData` / `readSignals` | 읽기 / 추출 / 사용자 신호 읽기 |
| `startAnnotating` / `startDrawing` | 클릭 주석 / 그리기(원·사각형·화살표·펜) 모드 시작 |

### 어포던스와 인간-AI 협업

`annotatePage`는 문서 순서대로 **결정적인 `aiId`**(`button#1`, `input-text#2`, …)를 부여합니다.
AI는 `clickAffordance({aiId})`로 이 ID를 참조하므로 추측 셀렉터로 인한 흔들림이 없습니다.

`injectButton`으로 심은 버튼에는 중립적인 DOM 속성(예: `data-bag-intent`)이 붙고, 클릭하면
`readSignals`로 읽을 수 있는 **신호**가 기록됩니다. 이로써 *사람이 심어진 버튼을 클릭 → AI가 의도를
읽고 작업을 이어 감*이라는 협업 루프가 완성됩니다.

## 아키텍처

```
sidepanel (채팅 UI)
   │  CHAT {text, history, tabId}
   ▼
background (service worker)
   │  ① COLLECT_CONTEXT → content (동사 카탈로그 + 어포던스 수집)
   │  ② callAI (Structured Outputs → reply + actions)
   │  ③ RUN_ACTIONS → content (동사를 순서대로 실행)
   ▼
content-script (페이지 내 / 동사 레지스트리 + 실행기)
```

- `lib/ai-client.js` — 제공자 비의존 Structured Outputs 호출
- `lib/prompt.js` — 동사 카탈로그 + 어포던스를 담은 시스템 프롬프트
- `lib/site-matcher.js` — URL / 도메인 / 정규식 매칭
- `lib/storage.js` — 설정 영속화

## 보안 / 개인정보

- API 키는 `chrome.storage.local`에만 저장되며 선택한 AI API로만 전송됩니다.
- 프롬프트 기록과 페이지별 채팅 기록도 `chrome.storage.local`에 저장됩니다.
- 파괴적/되돌릴 수 없는 동작(제출, 구매, 삭제)은 실행 전에 `reply`에서 명시합니다.
- 동사 레지스트리는 닫힌 집합이므로 AI가 예상치 못한 DOM 동작을 수행할 수 없습니다.

## 확장하기

`content/content-script.js`의 `AI_VERBS`에 `{ description, args, run }` 항목을 하나 추가하면
동사가 늘어납니다. 그 `description`과 `args`는 시스템 프롬프트와 Structured Outputs 스키마(`verb` enum)에
자동으로 반영됩니다.

## 기술

빌드 단계 없는 바닐라 JavaScript. Manifest V3, Side Panel API, `chrome.scripting`, `chrome.storage`.

## 품질 게이트

패키징 전에 `npm run check`를 실행하세요. JavaScript 문법 검사, 결정적 앵커 테스트,
사이드 패널과 옵션 페이지에 대한 Playwright + axe UI 검사를 함께 수행합니다.

채택한 anti-slop 워크플로는 [docs/ui-quality-workflow.md](docs/ui-quality-workflow.md)에 정리되어 있습니다.

## 라이선스

[MIT](LICENSE)
