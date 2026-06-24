# pi-patty-bg-tasks

<p align="center">
  <a href="README.md">English</a> · <strong>한국어</strong> · <a href="README.zh.md">中文</a>
</p>

**Claude Code의 백그라운드 작업 경험을 Pi로.** 장시간 실행 명령이 에이전트를 차단하지 않습니다 — 15초 후 자동 백그라운드, Ctrl+Shift+B로 수동 백그라운드, 출력 캡처, 정체 감지, 통합 작업 관리자.

## 설치

```
pi install npm:pi-patty-bg-tasks
```

또는 GitHub에서:

```
pi install git:github.com/patrickrho-patty/pi-patty-bg-tasks
```

Pi v0.37+ 필요. tmux는 선택 사항이지만 권장됩니다 (tmux 기반 프로세스 격리 활성화).

## 왜 pi-patty-bg-tasks인가

**세션 차단 없음.** 개발 서버, 테스트 스위트, 빌드 — 15초 이상 실행되는 모든 명령이 자동으로 백그라운드됩니다. 에이전트는 알림을 받고 즉시 다음 작업을 계속합니다. 언제든 수동으로 명령을 백그라운드할 수도 있습니다.

**Pi에서 Claude Code 동작.** Ctrl+B로 백그라운드, 출력 캡처, 완료 알림, 정체 감지 — Claude Code의 구현을 직접 모델로 삼았습니다. 동일한 메시지 형식, 터미널 네이티브 아이콘, "에이전트가 계속 작업" 흐름.

**내장 작업 관리자.** `/bg-list`로 인터랙티브 작업 관리자를 엽니다. 모든 백그라운드 잡을 나열, 출력 확인, 종료, 또는 완료 대기할 수 있습니다.

## 빠른 시작

```
# 에이전트가 긴 명령 실행 — 15초 후 자동 백그라운드
bash({ command: "npm run build" })

# 즉시 백그라운드로 시작
bash_bg({ command: "npm run dev", name: "devserver" })

# 백그라운드 잡 확인
jobs({ action: "list" })

# 모든 잡 출력에서 검색
jobs({ action: "search", pattern: "error|warning" })

# 백그라운드 에이전트 생성
agent_bg({ prompt: "auth 모듈 리팩터링" })
```

**Ctrl+Shift+B**를 눌러 실행 중인 명령을 즉시 백그라운드합니다. 에이전트는 알림을 받고 바로 다음 작업을 시작합니다.

## 도구

### bash (오버라이드)

내장 bash 도구를 확장합니다. 명령은 정상적으로 실행되지만, 15초를 초과하면 자동으로 백그라운드되고 에이전트에게 `job_decide`를 통해 결정(유지, 종료, 출력 확인)을 요청합니다.

| 파라미터 | 설명 |
|---------|------|
| `command` | 실행할 셸 명령 |
| `timeout` | 커스텀 타임아웃 (초 단위, 기본값: 15) |

### bash_bg

명령을 즉시 백그라운드로 시작합니다 — 포그라운드 레이스나 타임아웃 없음.

| 파라미터 | 설명 |
|---------|------|
| `command` | 실행할 셸 명령 |
| `name` | 선택적 사람이 읽을 수 있는 잡 라벨 |
| `timeout` | 선택적 타임아웃 (초); 동일한 자동 백그라운드 결정 흐름 트리거 |
| `notify` | 완료 알림 전송 (기본값: true) |

### jobs

백그라운드 잡 관리: 목록, 출력 읽기, 종료, 대기, 검색, 정리, 통계.

| 액션 | 설명 |
|------|------|
| `list` | 실행 중인 잡과 최근 완료된 잡 표시 |
| `output` | 특정 잡의 로그 끝부분 읽기 |
| `kill` | 실행 중인 잡 종료 |
| `attach` | 잡 완료까지 대기 후 출력 반환 |
| `search` | 모든 잡 로그에서 정규식 검색 |
| `cleanup` | 완료/실패 잡 정리 및 디스크 회수 |
| `stats` | 집계 메트릭: 총 시작, 실행 중, 완료, 실패, 평균 소요 시간 |

### job_decide

자동 백그라운드된 명령에 대한 결정. 15초 타이머가 발동하면 에이전트가 이 프롬프트를 받습니다.

| 파라미터 | 설명 |
|---------|------|
| `jobId` | 백그라운드된 잡의 ID |
| `decision` | `keep` (계속 실행), `kill` (종료), `check` (먼저 출력 확인) |

### agent_bg

현재 세션에서 파생된 연속성 프롬프트로 분리된 `pi -p` 프로세스를 생성합니다.

| 파라미터 | 설명 |
|---------|------|
| `prompt` | 백그라운드 에이전트에 전달할 작업 설명 |
| `cwd` | 작업 디렉터리 (기본값: 현재) |

## 키보드 단축키

| 단축키 | 동작 |
|-------|------|
| **Ctrl+Shift+B** | 현재 프로세스를 백그라운드 — 에이전트 즉시 계속 작업 (Claude Code Ctrl+B와 동일) |
| **Ctrl+Shift+J** | 백그라운드 작업 관리자 열기 |
| **Shift+Down** | 백그라운드 작업 관리자 열기 |
| **Ctrl+Shift+X** | 가장 최근 실행 중인 잡 종료 |

## 커맨드

| 커맨드 | 설명 |
|-------|------|
| `/bg` | 현재 프로세스를 백그라운드 (Ctrl+Shift+B와 동일) |
| `/bg-list` | 인터랙티브 백그라운드 작업 관리자 열기 |

## 작동 원리

```
명령 시작
  → 2초 이내 완료?        결과 즉시 반환
  → 15초에도 실행 중?     자동 백그라운드 → 에이전트에 job_decide 프롬프트
  → 사용자가 Ctrl+Shift+B? 즉시 백그라운드 → 에이전트 계속

백그라운드 잡 실행 중
  → 출력을 /tmp/pi-bg-<id>.log에 캡처
  → 정체 감지: 출력이 인터랙티브 프롬프트처럼 보이면 에이전트에 경고
  → 과대 출력 감지: 제한 초과 시 잡 종료
  → 완료 시: 에이전트에 상태 + 출력 경로 알림

tmux 사용 가능?
  → 예: tmux 윈도우에서 실행, sentinel 파일 기반 완료 감지
  → 아니오: detached 자식 프로세스로 직접 실행
```

## 상태 바

실행 중인 잡의 소요 시간과 명령 미리보기를 보여주는 라이브 위젯. 완료 및 실패 카운트가 상태 줄에 표시됩니다. Shift+Down 또는 `/bg-list`로 전체 작업 관리자를 엽니다.

## 개발

```
git clone https://github.com/patrickrho-patty/pi-patty-bg-tasks.git
cd pi-patty-bg-tasks
pnpm install
pnpm check    # 타입 체크
pnpm test     # 테스트 실행
```

Node.js ≥ 22, pnpm ≥ 10 필요. tmux 선택 사항.

## 기여

1. 저장소 포크
2. 기능 브랜치 생성 (`git checkout -b feat/my-feature`)
3. `pnpm check`와 `pnpm test` 통과 확인
4. [컨벤셔널 커밋](https://www.conventionalcommits.org/)으로 커밋
5. `main`에 대한 PR 오픈

## 라이선스

[MIT](LICENSE) © Patty

## 저자

**Patty** · [GitHub](https://github.com/patrickrho-patty)
