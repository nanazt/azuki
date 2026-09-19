# Docker 빌드 캐시 전환 실행 티켓

## 계획 깊이와 사용법

[구현 명세](docker-build-cache.md)를 동작을 끝까지 연결하는 구현 티켓 4개, 결합 검증 1개, 승인된 원격 확인 1개로 나눠요.
Docker 컴파일 경로와 스냅샷 전송은 독립적으로 구현할 수 있고, 생산자 보호와 workflow 연결은 공통 전송 계약을 인수한 뒤 병행할 수 있어요.
계층별 준비 작업이나 테스트를 마지막으로 미루는 분할 대신, 각 티켓이 실제 결과와 자체 검증을 제공하게 해요.

기존 [로컬 실행 티켓](voice-recovery-and-bot-restart-tickets.md)처럼 명세와 같은 디렉터리에 기록해요.
`DBC-*`는 이 문서 안의 식별자이며 GitHub 이슈 번호가 아니에요.
명세가 전체 계약의 기준이며, 사용자 결정과 제안된 기술적 기본안의 구분도 그대로 유지해요.
이 티켓 분해는 기본안을 새 사용자 승인으로 바꾸거나 명세의 범위를 줄이지 않아요.

계획 작성 이후 DBC-01부터 DBC-05까지의 로컬 구현·검증을 진행하라는 요청을 받았어요.
당시 승인 범위는 로컬 작업이었으며, 이후 별도로 승인된 원격 확인과 v0.5.0 릴리스 결과는 아래 실행 기록에 구분해 남겨요.
상태 변경은 완료 근거를 대신하지 않으며, 로컬 구현·로컬 검증·실제 GHCR 확인을 구분해 기록해요.

## 의존성과 공통 실행 계약

| 티켓 | 관찰 가능한 결과 | 필요한 선행 산출물 |
|---|---|---|
| [DBC-01](#dbc-01) | cargo-chef 없이 올바른 이미지를 만들고 Rust·지원되는 C/C++ 컴파일 결과를 재사용해요. | 없음 |
| [DBC-02](#dbc-02) | 일관된 kache 저장소를 OCI 스냅샷으로 게시하고 다른 builder에 안전하게 복원해요. | 없음 |
| [DBC-03](#dbc-03) | 동시 생산자의 후보와 현재 참조를 보호하면서 정상 스냅샷을 정리해요. | DBC-02 |
| [DBC-04](#dbc-04) | 태그 workflow에서 캐시를 사용하되 캐시 장애가 실제 이미지·릴리스 성공을 뒤집지 않아요. | DBC-01, DBC-02 |
| [DBC-05](#dbc-05) | 새 builder·빈 target·변경된 입력·캐시 장애가 결합된 실제 빌드를 검증하고 자원 상한을 확정해요. | DBC-03, DBC-04 |
| [DBC-06](#dbc-06) | 승인된 실제 workflow에서 GHCR 접근·태그 간 복원·보호된 정리 결과를 확인해요. | DBC-05, 범위가 명확한 원격 실행 권한과 대상 실행 |

의존성은 티켓의 완료 표시가 아니라 아래에서 정의한 실제 동작·인터페이스·검증 결과를 뜻해요.
DBC-01과 DBC-02는 서로를 기다리지 않아요.
DBC-02의 전송 계약이 준비되면 DBC-03이 시작할 수 있고, DBC-01도 준비되면 DBC-04를 병행할 수 있어요.
DBC-04는 정리 알고리즘을 다시 구현하지 않으며, DBC-03의 추가 동작까지 결합한 검증은 DBC-05가 맡아요.
DBC-06의 원격 권한이나 다음 릴리스를 기다린다는 이유로 독립적인 로컬 작업을 중단하지 않아요.

### 병행 작업의 접점과 소유권

DBC-01은 `Dockerfile`, 루트 `.kache.toml`, `azuki-db`의 migration 입력 추적과 해당 집중 검증을 소유해요.
실제 builder 이름은 실행자가 선택할 수 있고, Docker 컴파일에 사용하는 kache mount의 ID·경로와 플랫폼·형식 식별 값을 workflow에서 맞출 수 있는 접점을 제공해요.
`target`과 kache mount를 분리하고, kache의 재사용 가능한 저장소와 런타임 전용 상태의 위치도 구분해 인계해요.

DBC-02는 명세의 의존성 없는 Node CI helper와 그 전송 검증을 소유해요.
helper는 호출자가 선택한 builder·mount 식별 정보, 캐시 전용 저장소·참조, 플랫폼·형식·kache 버전, 생산 저장소·run ID·attempt·소스 SHA, 명시적인 자원 상한을 받아 동작해요.
DBC-01의 아직 정하지 않은 내부 경로나 Dockerfile 텍스트를 추측해서 파싱하지 않아요.
복원은 검증된 저장소 또는 깨끗한 miss 상태를 제공하고, 게시는 추출·업로드·검증·자기 스냅샷 승격을 완료하거나 실패를 명확히 반환해요.
정확한 CLI 표기와 내부 직렬화는 DBC-02에서 결정해 실행 가능한 호출 예시와 함께 인계해요.

DBC-03은 같은 helper의 게시 성공 이후 경로에 정리를 연결하고 기존 복원·게시 호출 계약을 유지해요.
DBC-04가 별도 정리 엔진이나 다른 상태 저장소를 만들 필요가 없도록 해요.
DBC-03과 DBC-04를 병행할 때 helper 변경은 DBC-03, workflow 원본과 생성 YAML 변경은 DBC-04가 소유해요.
공유 접점을 바꿔야 하면 통합 담당자 한 명이 조율하고 해당 변경만 직렬화해요.

자격 증명은 runner 측 인증 경계에만 두고 빌드 인수·컨텍스트·이미지·스냅샷·로그로 넘기지 않아요.
S3, GitHub artifact, 원격 target 스냅샷, 새 runner, master warmup, 다중 아키텍처나 범용 캐시 프레임워크를 추가하지 않아요.
로컬 검증에서는 임시 저장소·builder·registry·빈 DB만 사용하고 실제 DB·WAL·미디어를 읽거나 Discord에 접속하지 않아요.
각 변경은 필요 없어진 기존 경로와 호출부를 함께 정리하며 cargo-chef나 GHA 레이어 캐시를 호환용 우회로로 남기지 않아요.

## DBC-01 — 직접 Docker 빌드와 컴파일 캐시의 정합성을 연결해요
<a id="dbc-01"></a>

**근거:** [명세](docker-build-cache.md)의 Docker 컴파일 계약, 캐시 계층과 저장 경계, migration과 컴파일 입력 정합성을 따라요.
**상태:** 로컬 구현·집중 검증·전체 앱의 새 builder 결합 검증을 마쳤어요.
**선행 산출물:** 없으며 바로 시작할 수 있어요.

현재 `Dockerfile`의 chef·planner·cook 경로를 제거하고 기존 소스 복사와 최종 런타임 이미지까지 직접 Cargo 빌드로 연결해요.
사전 빌드된 kache v0.20.0을 버전과 무결성 검증으로 고정하고, Rust wrapper와 지원되는 C/C++ 호출의 실제 경로를 하나의 방식으로 연결해요.
현재 `cc`·`cmake` 버전에서 지원되는 연동을 선택하고, `RUSTC_WRAPPER`만 설정하면 네이티브 컴파일도 적중한다고 가정하지 않아요.

`cargo build --locked --release --bin azuki`, `SQLX_OFFLINE`, 기존 release profile과 의존성 의미를 유지해요.
`target`, Cargo registry/git와 kache 저장소는 각각 적절한 builder 로컬 mount를 사용해요.
kache의 적응형 incremental 동작으로 release 정책이 바뀌지 않게 하고, 별도 mount 사이의 zero-copy를 보장한다고 표현하지 않아요.
바이너리는 mount가 살아 있는 동일한 RUN에서 일반 파일 경로로 반출해 최종 이미지에 복사해요.

`azuki-db`에 Cargo 자체의 migration 디렉터리 변경 추적을 연결하고, 루트 `.kache.toml`에는 해당 크레이트의 migration 내용을 추가 컴파일 입력으로 선언해요.
wrapper를 쓰지 않는 빌드도 새 migration 파일을 발견해야 하며, kache는 파일의 추가·변경·삭제를 적중 키에 반영해야 해요.
새 설정을 Docker에 명시적으로 복사하되 `COPY . .`로 실제 데이터나 비밀을 포함하지 않아요.

**관찰 가능한 완료 기준**

- 캐시가 전혀 없는 상태에서도 정상 런타임 이미지를 만들고 임시 빈 DB로 기존 시작 경로를 실행해요.
- 같은 builder의 동일 입력 재빌드에서는 Cargo freshness와 kache 적중을 별도로 관찰해요.
  컴파일 RUN을 실제로 실행하는 조건에서 target이 비어 있어도 보존된 kache의 Rust 적중과 지원되는 네이티브 object 적중을 확인해요.
- 지원하지 않는 네이티브 호출은 원래 컴파일러로 정확히 통과하고, 캐시 적중 수를 늘리려고 링킹·build script 실행을 캐시된 것처럼 처리하지 않아요.
- 새 migration만 추가한 경우, 기존 migration 내용 변경, 삭제를 각각 반영한 바이너리를 만들어요.
  임시 DB에 적용되는 실제 스키마·데이터로 확인하고 정상 전환 전후의 컴파일 로그만으로 정합성을 판단하지 않아요.
- 변경 전 migration을 적용한 별도 임시 DB를 각각 준비하고, 변경·삭제한 바이너리에서 SQLx가 checksum 불일치와 누락된 적용 이력을 기존처럼 거부하는지 확인해요.
- kache를 끈 빌드도 같은 migration 결과를 제공해요.
  추적 기능을 처음 적용하는 빌드는 해당 크레이트를 실제로 재빌드해 과거 dep-info를 그대로 재사용하지 않아요.
- 최종 이미지의 사용자, 포트, 볼륨, 정적 파일, 런타임 의존성과 실행 방식이 유지되고 캐시·컴파일 도구·인증 없이 실행돼요.

**검증과 인계:** 실제 Docker 빌드와 임시 컨테이너 실행을 사용하고, 캐시를 지우지 않은 재실행만으로 빈 target 적중을 주장하지 않아요.
새 migration만 추가한 구별 사례가 추적 없는 기존 경로의 결함을 탐지하는지 확인하고 유용한 회귀 검사로 남겨요.
추가·변경·삭제에는 후속 migration이 의존하지 않는 독립적인 검증용 입력을 사용하고, SQL 자체의 오류를 캐시 무효화의 근거로 삼지 않아요.
Docker·Rust·네이티브 도구 버전, 선택한 mount 접점, 저장소와 런타임 상태 경계, cold 빌드의 저장 크기와 시간을 기록해 DBC-04·DBC-05에 인계해요.
DBC-02의 원격 전송이 없어도 로컬 kache 재사용과 최종 이미지의 정합성을 검증할 수 있어야 해요.

## DBC-02 — kache 저장소를 스냅샷으로 왕복해 새 builder에 복원해요
<a id="dbc-02"></a>

**근거:** [명세](docker-build-cache.md)의 GHCR 저장 형식과 식별, 복원·게시 수명주기, 실패·자원·신뢰 경계를 따라요.
**상태:** 로컬 구현과 실제 독립 builder 왕복 검증을 마쳤어요.
**선행 산출물:** 없으며 바로 시작할 수 있어요.

한 개의 Node CI helper에서 실제 저장소 추출, OCI 스냅샷 업로드, 고정 참조 갱신, 다운로드·검증과 builder mount 복원을 연결해요.
단순 archive 라이브러리나 명령 forwarding만 만드는 티켓이 아니에요.
DBC-01을 기다리지 않고 고정된 kache로 작은 실제 컴파일 입력의 저장소를 만든 뒤 로컬 OCI registry와 독립 builder 두 개로 전송 경로를 검증해요.
애플리케이션 전체의 복원 적중은 DBC-05에서 결합해 확인해요.

컴파일과 kache의 쓰기·GC가 끝난 일관된 저장소를 추출하고 SQLite/WAL 상태를 안전하게 다뤄요.
인증·로그·socket·lock 등 런타임 전용 상태를 제외하고, 큰 payload를 메모리에 통째로 적재하지 않아요.
일반 레이어 cache hit가 있어도 주입·추출이 생략되지 않게 하며 실제 빌드에 쓰는 동일한 builder와 mount를 지정해요.
cache-dance를 사용한다면 기본 post 추출보다 먼저 필요한 게시 순서에 맞는 명시적 경로를 사용해요.

캐시 패키지는 `ghcr.io/nanazt/azuki-build-cache`를 기본안으로 사용하고 런타임 패키지와 분리해요.
일반 레이어 캐시와 kache 스냅샷은 참조와 종류를 구분해요.
플랫폼·형식·kache 호환성에 따른 안정된 namespace를 사용하고 릴리스 태그·SHA·Cargo.lock 전체를 복원 주소로 삼지 않아요.
생산 저장소·run ID·attempt를 불변 스냅샷 식별에 포함하고, 복원 시 고정 참조를 한 번 해석한 digest의 내용을 검증해요.

자신이 새로 업로드하고 검증한 스냅샷만 승격하며 정상 완료된 생산자가 과거 후보를 나중에 승격하는 경로를 두지 않아요.
불완전한 게시, 취소, runner 상실이나 결과를 확정하지 못한 게시를 정상 완료로 기록하지 않아요.
기존 정상 참조를 먼저 삭제하거나 실패 시 과거 스냅샷을 새로 승격하는 rollback을 구현하지 않아요.
정리 자체는 DBC-03이 추가하며 이 티켓은 원격 버전을 삭제하지 않아요.

**관찰 가능한 완료 기준**

- 실제 kache 저장소를 로컬 registry에 게시한 뒤 새 builder·빈 target에 복원하고 같은 입력을 다시 컴파일해 적중과 올바른 출력을 확인해요.
- 없는 snapshot, 인증 거부, 손상·부분 다운로드, 형식·플랫폼·호환성 불일치를 구분하고 해당 캐시를 빌드 입력으로 사용하지 않아요.
  실패한 복원은 부분 데이터가 남은 mount가 아니라 깨끗한 miss 상태로 이어져요.
- OCI 이미지를 데이터로만 취급하고 entrypoint를 실행하지 않아요.
  archive 경로 탈출·위험한 링크를 차단하면서 필요한 파일 내용과 실행 권한을 보존해요.
- 추출·압축·다운로드·해제·업로드에 크기·시간·디스크 경계를 적용하고 중단 시 자식 작업까지 유한하게 종료해요.
  upload 성공 뒤 조회·무결성 확인이 실패하면 고정 참조를 갱신하지 않아요.
- OCI payload, 메타데이터, 최종 이미지와 로그에 GitHub 인증정보가 남지 않아요.
- 복원·게시 결과와 실패를 호출자가 구별할 수 있고 cache miss를 거짓 hit로 보고하지 않아요.

**검증과 인계:** 실제 로컬 registry 왕복과 독립 builder의 컴파일 결과를 proof로 사용하고, 파일 복사 성공이나 mock 응답만으로 kache 재사용을 주장하지 않아요.
부분·손상 입력과 각 상한의 안팎을 구별하는 Node `node:test` 검사를 helper에 함께 두고, source 문자열이나 우연한 로그 문구를 고정하지 않아요.
resource limit은 처음부터 명시적으로 설정·검증할 수 있어야 하며 DBC-05가 실제 azuki 측정값으로 workflow의 수치를 확정해요.
실제 호출 방법, mount 주입·추출 조건, metadata와 생산 완료·불확실성 판정, 실패 결과를 DBC-03·DBC-04에 인계해요.

## DBC-03 — 진행 중 스냅샷을 보호하면서 정상 보관 개수를 유지해요
<a id="dbc-03"></a>

**근거:** [명세](docker-build-cache.md)의 게시, 보관과 정리, 생산자와 참조의 보호 불변 조건을 따라요.
**상태:** 로컬 구현과 상태를 가진 OCI·GitHub fixture 검증을 마쳤어요.
**선행 산출물:** DBC-02의 실제 불변 스냅샷, 검증 후 승격, 생산자 식별과 게시 종료 판정이 필요해요.
DBC-01이나 DBC-04의 완료를 기다릴 필요는 없어요.

helper의 정상 게시·참조 갱신 뒤에 해당 플랫폼의 정상 스냅샷 정리를 연결해요.
현재 참조와 보존할 이전 스냅샷을 포함한 최신 정상 2개 보관을 기본안으로 삼고, 진행 중·불확실한 후보의 보호가 개수보다 우선하게 해요.
오래된 마지막 정상 스냅샷을 릴리스 간격만으로 만료시키지 않아요.

기록된 생산 workflow와 attempt가 확실히 `completed`이며 게시 종료가 확인된 helper 관리 스냅샷만 삭제 후보로 삼아요.
생산자 상태 조회는 runner 측의 `actions: read` 범위 안에서 하고 실패·불확실성은 보호로 처리해요.
삭제 직전에 현재·보존 참조를 다시 확인하며, 다른 생산자가 참조를 바꿔 보호 대상을 확정할 수 없으면 정리를 생략해요.
분산 lock 저장소, snapshot 병합이나 workflow 전체의 새로운 직렬화·취소 정책을 도입하지 않아요.

**관찰 가능한 완료 기준**

- 보호가 필요한 추가 후보가 없는 경우 플랫폼별 최신 정상 2개를 남기며 둘 다 계속 복원할 수 있어요.
- 생산자 A가 새 후보를 올리고 승격하기 전에 B가 게시·정리해도 A의 후보는 삭제되지 않아요.
  A는 자신의 검증된 후보만 완료 전에 승격할 수 있고 완료된 생산자는 삭제된 후보를 나중에 승격하지 못해요.
- 진행 중·취소·runner 상실·상태 조회 실패·게시 종료 불명확 후보는 보호되고, 보호 때문에 보관 개수를 넘긴 사실을 숨기지 않아요.
- 다른 플랫폼, 일반 레이어 캐시, 알 수 없는 버전, 현재·이전 보호 참조, 런타임 패키지는 삭제하지 않아요.
  manifest 의존 객체를 지워 보존 스냅샷을 깨뜨리거나 untagged 전체를 삭제하지 않아요.
- 새 게시 실패에는 기존 정상 참조와 보관 대상을 그대로 두고, 개별 정리 실패는 게시 성공을 되돌리지 않아요.
- 후보 조회가 불완전하거나 삭제 직전 참조가 바뀌면 안전하게 정리를 생략하고 유한한 시간 안에 끝나요.

**검증과 인계:** 격리된 GitHub API fixture로 생산자 상태·페이지 누락·삭제 실패·참조 변경 순서를 제어하고, 로컬 registry의 보존된 실제 digest를 다시 복원해요.
A의 승격 직전에 B의 정리를 끼워 넣는 결정적 순서가 진행 중 후보를 잘못 삭제하는 구현을 탐지해야 해요.
정리 결과와 경고를 기존 게시 결과에 연결하고, DBC-04가 helper 내부를 다시 수정하지 않아도 같은 게시 호출을 사용할 수 있게 해요.
실제 GHCR 삭제 권한과 원격 package version 동작은 fixture로 확인했다고 주장하지 않고 DBC-06에 남겨요.
일반 registry 레이어 캐시의 전체 과거 버전 정리는 이 티켓의 범위가 아니에요.

## DBC-04 — 태그 workflow에 캐시를 연결하고 릴리스 실패 경계를 유지해요
<a id="dbc-04"></a>

**근거:** [명세](docker-build-cache.md)의 workflow와 릴리스 호환성, 실패·자원·신뢰 경계를 따라요.
**상태:** 원본·생성 YAML 연결, release fixture, 실제 앱의 로컬 실패 경계 검증을 마쳤어요.
**선행 산출물:** DBC-01의 실제 Docker 빌드와 mount 접점, DBC-02의 실행 가능한 복원·게시 helper가 필요해요.
DBC-03은 같은 게시 호출 내부를 확장하므로 이 티켓의 로컬 연결 작업을 막지 않아요.

`workflows/docker.ts`에서 setup-buildx가 선택한 builder, 실제 컴파일 mount와 helper의 복원·추출 대상을 일치시켜요.
복원은 실제 이미지 빌드 전에, kache 추출·게시는 실제 이미지 빌드·push가 성공한 뒤에만 실행해요.
생산 run·attempt의 식별과 호환 namespace를 전달하고, DBC-03의 조회에 필요한 `actions: read`를 해당 job에 선언해요.
자격 증명은 runner의 registry/API 인증에만 사용해요.

현재 `type=gha` 일반 레이어 캐시는 kache snapshot과 다른 GHCR registry cache 참조로 완전히 전환해요.
BuildKit의 cache mount가 registry 레이어 exporter에 자동 포함된다고 가정하지 않아요.
레이어 cache import/export와 kache 전송·정리는 각각 비치명적인 실패 경계로 연결하고, 실제 빌드·이미지 push 오류를 함께 무시하지 않아요.

`docker.yml` 경로, `v*` push trigger, GitHub 제공 runner, 런타임 image 참조, 버전·major.minor·latest metadata 규칙을 유지해요.
원본에서 변경하고 `npx gaji build`로 `.github/workflows/docker.yml`을 재생성해요.
release core의 fingerprint, 정확한 태그·SHA, 최종 workflow `completed/success`, 동시 릴리스 차단과 자동 재실행 금지를 약화하지 않아요.
새 workflow에 새 inspect/plan이 필요하다는 기존 동작을 유지하고 오래된 승인 계획을 고쳐 재사용하지 않아요.

**관찰 가능한 완료 기준**

- 실제 build 단계와 helper가 같은 builder·kache mount를 사용하고, 캐시 miss와 복원 실패 모두 정상 cold build로 이어져요.
- kache 전송·정리와 일반 레이어 cache export만 실패하면 경고를 남기고 성공한 이미지 게시의 결과를 유지해요.
- 실제 애플리케이션 빌드나 이미지 push가 실패하면 실패를 보존하고 정상 kache 게시·release 생성으로 넘어가지 않아요.
- workflow의 태그·metadata·승인 fingerprint와 기존 publish/resume 계약이 유지돼요.
- 새 helper의 실행 방법·검증 명령을 기존 task runner 관례에 연결하고, 중복된 release 핵심 모듈이나 새 원격 release 경로를 만들지 않아요.

**검증과 인계:** gaji 생성 결과를 기존 release fixture의 workflow 검사와 완료 판정에 통과시키고, 캐시 오류와 실제 빌드·push 오류를 구분하는 실행 경로를 집중 검증해요.
로컬 registry와 통제된 API·명령 실패로 실제 helper의 종료 결과와 다음 단계 수행 여부를 확인해요.
이 검증은 실제 GitHub runner의 최종 conclusion을 대신하지 않으며 해당 관찰은 DBC-06이 맡아요.
DBC-01의 초기 크기·시간 측정에 근거한 보수적인 상한을 빠짐없이 설정해요.
최종 수치는 DBC-05의 전체 왕복 측정으로 확정하고, 선택한 builder·cache 참조·권한·실패 처리와 실행 명령을 인계해요.

## DBC-05 — 새 실행 환경과 입력 변경을 결합해 정합성과 비용을 검증해요
<a id="dbc-05"></a>

**근거:** [명세](docker-build-cache.md)의 관찰 가능한 완료 기준, 검증 방식과 실행 의존성, 남은 기술적 확인을 따라요.
**상태:** 전체 앱의 새 builder·입력 변경 matrix, 자원·시간 측정, 최종 production 이미지와 로컬 실패 경계 검증을 마쳤어요.
**선행 산출물:** DBC-03의 보호된 게시·정리와 DBC-04의 연결된 실제 Docker 빌드·workflow 설정이 필요해요.
이 티켓은 앞선 티켓이 자신의 검증을 미루는 장소가 아니라, 전체 애플리케이션과 저장 경로가 결합됐을 때만 확인할 위험을 맡아요.

격리된 로컬 registry에서 실제 azuki 빌드의 kache 저장소를 왕복하고 완전히 새 builder에서 다시 빌드해요.
workflow와 같은 builder 지정·mount·인수·순서로 실행하며, 일반 RUN cache hit가 컴파일이나 주입·추출을 생략해 잘못된 성공을 만들지 않게 해요.
검증 때문에 운영 workflow에 상시 중복 빌드나 새 trigger를 추가하지 않아요.

**관찰 가능한 완료 기준**

- cache 없음, 같은 builder의 target 재사용, 새 builder·빈 target·복원된 kache를 구분해 실행해요.
  마지막 경우 컴파일 RUN과 Cargo 빌드가 실제로 실행되며 지원되는 Rust·네이티브 적중과 올바른 최종 이미지가 관찰돼요.
- 임시 소스 복제본에서 소스, 의존성 또는 lockfile, workspace 버전, 새 migration만의 추가와 기존 migration 변경·삭제를 구분해요.
  변경 후 결과가 올바르고 변경하지 않은 입력의 재사용 기회가 유지되며, 의도된 miss를 캐시 고장으로 판정하지 않아요.
- kache를 끈 경우와 켠 경우의 실제 migration 적용 결과가 같아요.
  정상 적용 결과는 각 시나리오의 새 임시 DB에서 확인해 과거 적용 기록이 검증을 가리지 않게 해요.
  기존 적용 이력에 대한 검증은 DBC-01의 별도 임시 DB 사례를 사용하고 production DB는 사용하지 않아요.
- 없음·손상·비호환·부분 복원, 전송 실패, 크기·시간·디스크 경계에서도 실제 애플리케이션 cold build가 정확히 동작해요.
  캐시 때문에 생긴 자원 실패와 컴파일 자체의 실패를 구분해요.
- 게시·정리 경합을 거친 보존 스냅샷을 실제로 다시 복원하고, 캐시 도구와 인증 없이 최종 런타임을 실행해요.
- cold·target warm·snapshot restore 상태를 구분하고, cold build·동일 소스·소스 변경·workspace 버전 변경·의존성 또는 lockfile 변경 각각에서 컴파일 시간, 캐시 반출입 시간, 전체 경과 시간과 전송 크기를 나눠 기록해요.
  복원·추출·게시의 세부 시간, 압축 전후 크기, 디스크 사용과 적중·miss도 같은 조건으로 기록해요.
  고정된 속도 향상을 약속하거나 적중률만으로 전체 빌드가 빨라졌다고 판단하지 않아요.
- 실제 측정값과 GHCR의 레이어·전송 제약을 근거로 크기·시간·디스크 상한 및 여유분을 코드·설정에 구체적으로 확정해요.
  맞지 않는 기본값을 그대로 두거나 전송·메모리 상한을 무제한으로 풀지 않아요.

**검증과 인계:** 입력 버전·캐시 상태·실행 순서와 실제 도달한 검증 상태를 남기고, migration 추적 누락과 손상 snapshot의 구별 사례가 의도한 오류를 잡는지 확인해요.
결합 과정에서 드러난 구현 오류는 해당 소유 경로에서 고치고 영향을 받은 검증을 반복해요.
측정 수치와 호환성 결론은 이 문서의 실행 기록과 필요한 기존 명세·설정에 반영해요.

관련 입력이 안정된 뒤 `mise run check`, `mise run test`, `mise run test-release`, 새 helper의 집중 검사를 실행해요.
`frontend`에서는 `npx tsc --noEmit` 다음 `npm run build`를 실행하고, gaji 생성 결과가 현재 원본과 일치하도록 해요.
병행 수정 중인 입력을 대상으로 한 검사나 source 검토를 최종 실행 근거로 대신하지 않아요.
cache 수명주기·삭제 경계·릴리스 실패 경계는 독립 검토를 받고 남은 지적을 해소해요.

성공한 smoke 실행 후 필요 없어진 검증용 스크립트·결함 주입·임시 데이터와 서비스를 정리하고, 유효한 회귀 검사와 재현 명령만 남겨요.
필요한 기존 문서·변경 기록을 갱신하되 계획 단계의 권장값을 실측 결과로 표현하지 않아요.
DBC-06에는 검증한 소스·도구 버전, 실제 helper 명령, 참조·삭제 보호 대상, 측정값과 아직 확인하지 못한 GHCR 권한을 인계해요.

## DBC-06 — 승인된 실제 workflow에서 GHCR 지속성을 확인해요
<a id="dbc-06"></a>

**근거:** [명세](docker-build-cache.md)의 실제 GHCR 확인, workflow와 릴리스 호환성, 원격 작업 권한 경계를 따라요.
**상태:** 일부 원격 근거를 확보했지만 v0.5.0의 snapshot 게시가 실패해, 후속 runner 복원·보관 검증은 대상 실행과 별도 권한을 기다려요.
**선행 산출물:** DBC-05의 로컬 결합 검증 결과와 확인할 소스 버전이 필요해요.
대상 저장소·참조·실행, 캐시 package 게시·정리와 필요한 태그·workflow 동작을 포함한 명시적 원격 권한도 필요해요.
**담당:** 사용자가 직접 실행한 결과를 인계하거나, 해당 원격 동작과 범위를 명시적으로 승인받은 실행자가 진행해요.

승인된 실제 GitHub 제공 runner에서 캐시 전용 비공개 GHCR package의 생성·읽기·쓰기와 허용된 정리를 확인해요.
첫 정상 게시와 별도의 후속 실행을 구분해 고정 참조가 릴리스 태그를 넘어 복원되는지 관찰해요.
승인된 정상 릴리스와 실행만 사용하고 검증을 위해 임의의 `v*` 태그, workflow 재실행, 공개 package 전환이나 추가 PAT를 만들지 않아요.
필요한 대상 실행이 아직 없으면 관찰을 대기 상태로 남기고 로컬 완료를 취소하거나 원격 성공을 추정하지 않아요.

**관찰 가능한 완료 기준**

- 실제 workflow token으로 비공개 cache package를 읽고 게시하며, package 연결과 필요한 관리 권한이 의도한 범위에서 동작해요.
  일반 레이어 cache와 kache snapshot의 참조가 분리되고 런타임 package에 cache version이 섞이지 않아요.
- 후속 새 runner가 앞선 실행의 정상 snapshot digest를 복원해 사용해요.
  복원 성공, Cargo freshness, kache 적중과 도구·입력 변경으로 인한 정상 miss를 구분해 기록해요.
- 정상 게시·참조 갱신 뒤 허용된 관리 snapshot만 정리되고 현재·이전·진행 중 보호 대상과 런타임 참조가 유지돼요.
  처음에는 삭제할 정상 이력이 부족할 수 있으므로 실제 삭제 경로를 관찰하지 못했다면 그 항목을 완료 처리하지 않아요.
- 실제 이미지 게시 성공과 정확한 태그·SHA의 workflow `completed/success`가 기존 release 판정에 연결돼요.
  캐시 전용 실패가 실제로 발생한 경우 경고와 최종 conclusion을 함께 확인하며, 발생하지 않은 실패 경로는 로컬 근거와 구분해요.
- 로그·스냅샷·이미지에서 자격 증명이 노출되지 않고, 실제 전송 비용·크기·시간이 설정된 상한과 일치해요.

**검증과 인계:** run URL·ID·attempt, 소스 SHA, 복원·게시 digest, package 가시성·권한 결과, 보존·삭제한 관리 version과 workflow conclusion을 민감 정보 없이 기록해요.
성공한 정상 실행만으로 실제 장애 경로까지 확인했다고 주장하지 않아요.
원격 장애 주입이나 추가 실행이 필요하면 해당 행위와 영향이 원격 승인 범위에 포함됐는지 먼저 확인해요.
운영 런타임 package나 사용자 데이터를 검증용 삭제 대상으로 삼지 않고, 권한 부족을 이유로 자동 권한 확대를 하지 않아요.
이 티켓은 배포 권한을 추가하지 않으며 원격 확인 성공도 새로운 릴리스·배포를 승인하지 않아요.

## 명세 완료 기준의 담당 범위

아래 연결표는 전체 범위를 빠뜨리지 않기 위한 것이며 각 티켓의 완료 근거를 대신하지 않아요.
DBC-05는 결합된 로컬 경로, DBC-06은 실제 GHCR·GitHub 동작만 증명해요.

| 명세의 시나리오·제약 | 주 구현·집중 검증 | 결합·원격 확인 |
|---|---|---|
| cargo-chef 제거, cold build, target freshness | DBC-01 | DBC-05 |
| 새 builder·빈 target의 Rust·네이티브 적중 | DBC-01, DBC-02 | DBC-05, DBC-06 |
| 지원하지 않는 호출의 정확한 passthrough | DBC-01 | DBC-05 |
| 소스·의존성·workspace 버전 변경 | DBC-01 | DBC-05 |
| migration 추가·변경·삭제와 wrapper 없는 빌드 | DBC-01 | DBC-05 |
| 같은 builder·mount의 명시적 주입·추출 | DBC-02, DBC-04 | DBC-05 |
| SQLite 일관성, payload 권한·안전한 해제 | DBC-02 | DBC-05 |
| 없는·손상된·비호환·부분 snapshot | DBC-02 | DBC-05 |
| 게시 실패와 기존 정상 참조 보존 | DBC-02, DBC-03 | DBC-05 |
| 시간·크기·메모리·디스크 경계와 실측 | DBC-02, DBC-04 | DBC-05, DBC-06 |
| 동시 생산·완료 후 승격 금지·상태 불확실성 | DBC-02, DBC-03 | DBC-05 |
| 보관 개수·플랫폼·종류·manifest 보호 | DBC-03 | DBC-05, DBC-06 |
| 레이어 cache의 GHCR 전환과 비치명적 실패 | DBC-04 | DBC-05, DBC-06 |
| 실제 빌드·push 실패와 release 성공 경계 | DBC-04 | DBC-05, DBC-06 |
| 태그·metadata·fingerprint·자동 재실행 금지 | DBC-04 | DBC-05, DBC-06 |
| cache·target·인증 없는 기존 런타임 실행 | DBC-01 | DBC-05 |
| 비공개 GHCR 권한·안정된 태그 간 참조 | DBC-02, DBC-04 | DBC-06 |
| 인증·실제 데이터·런타임 package 보호 | DBC-01, DBC-02, DBC-03, DBC-04 | DBC-05, DBC-06 |

## 현재 실행 기록

### 구현과 권한

초기 로컬 구현의 기준 소스는 `807c5637fc8b5829e32fd239cfa405cb54f66ec7`이며, 당시 변경은 로컬 작업 트리에 있었어요.
`Dockerfile`의 cargo-chef를 직접 Cargo 빌드로 교체하고 `.kache.toml`, `crates/azuki-db/build.rs`, `scripts/docker-cache.mjs`와 집중·통합 검증 명령을 연결했어요.
`workflows/docker.ts`가 workflow의 유일한 편집 원본이며 `.github/workflows/docker.yml`은 `npx gaji build`로 생성했어요.
실제 DB·WAL·미디어를 사용하거나 Discord에 접속하지 않았고, registry 쓰기는 이번 세션 소유의 loopback registry로만 제한했어요.
초기 로컬 구현 단계에서는 GitHub·GHCR의 게시·삭제·push·릴리스를 실행하지 않았어요.

### 고정된 구현 접점

| 항목 | 구현 값 |
|---|---|
| 플랫폼·도구 | `linux/amd64`, kache `v0.20.0` |
| kache 배포물 SHA-256 | `fe5ce52406e0dcb8c9a49798671a073440cae13a88731b1b712b7c0fa372b85b` |
| 컴파일 | `cargo build --locked --release --bin azuki`, `SQLX_OFFLINE=true` |
| cache/runtime | `/var/cache/kache` locked mount, `/run/kache` tmpfs |
| 일반 레이어 참조 | `buildkit-linux-amd64-v1` |
| snapshot 참조 | `kache-linux-amd64-s1-kache-0.20.0` |
| 저장 형식 | OCI gzip layer, gzip level 1, compressed layer digest와 raw tar `diff_id` 구분 |
| GC 설정 | `KACHE_MAX_SIZE=3GiB`, 컴파일 뒤 명시적 GC·daemon stop·run lock drain |
| helper hard 상한 | compressed layer·raw tar·payload 파일 각각 4 GiB, staging 12 GiB, 파일 100,000개 |
| 시간 경계 | helper 개별 작업 600,000 ms, workflow cache-only step 전체 15분 |
| 정리 조건 | 정확한 run·attempt의 `completed/success`와 일치하는 completion receipt 필요 |

3 GiB는 컴파일 중의 연속적인 hard disk 상한이 아니며 12 GiB도 Docker·runner 전체가 아닌 helper staging 상한이에요.
첫 실제 cold store는 1,181,588,715 bytes였고, 실제 gzip 게시의 payload 파일 1,196,528,468 bytes·raw tar 1,200,855,040 bytes가 429,074,298 bytes로 전송되었어요.
[GHCR 공식 제한](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)의 레이어당 10 GB·upload 10분보다 작은 전송 상한을 사용해요.
현재 관측값이 상한 안에 있다는 사실을 모든 미래 입력이나 GitHub runner 전체 디스크 사용량의 보장으로 해석하지 않아요.

### 완료된 집중 검증

- `mise run check && mise run test`가 최종 Rust 변경에서 통과했어요.
  기존 `result_large_err`를 해결하기 위해 사용자 승인 후 공개 `register_commands`를 기존 `BotError::Serenity(String)` 관례로 바꾸었고, 유일한 호출부의 오류 로그 처리는 유지했어요.
  비공개 setup handler는 기존 상태 코드·JSON을 유지한 `(StatusCode, Json<_>)` 오류로 바꾸었어요.
- `mise run test-docker-cache`의 28개 검사가 gzip 무결성·경계·실패·게시·receipt·정리 보호를 통과했어요.
  실제 상태를 가진 loopback OCI/GitHub fixture에서 승격 전 A와 정리 B의 순서를 제어하고 보호·삭제 후 보존 snapshot의 복원을 확인했어요.
- `mise run test-docker-cache-integration -- --kache /tmp/kache`가 독립 builder 두 개와 실제 Rust 바이너리로 통과했어요.
  새 builder의 빈 target에서 kache report의 실제 `local_hit`, `compiler_runs=0`, 양수 payload 크기와 올바른 실행 결과를 확인했어요.
  이 작은 입력의 전송은 gzip 215,198 bytes·raw tar 577,024 bytes였고 전체 검사는 81.65초였어요.
- `mise run test-migration-cache -- --kache /tmp/kache`가 wrapper-free와 cached 경로에서 migration 추가·변경·삭제, 새 DB의 schema/data, 기존 DB의 `VersionMismatch(901)`·`VersionMissing(902)`를 확인했어요.
  전역 Cargo 설정의 wrapper까지 명시적으로 해제한 scratch에서 `build.rs`를 빈 함수로 바꾸면 새 migration 검사만 실패했고, 정상 watcher를 둔 검사는 53.58초에 통과했어요.
- `mise run test-release`의 36개 검사가 통과했어요.
  기존 승인 fingerprint·태그·SHA·최종 workflow 성공 판정과 자동 재실행 금지 계약을 유지해요.
- frontend의 `npx tsc --noEmit && npm run build`와 최종 workflow 원본의 `npx gaji build`가 통과했어요.
- 실제 BuildKit context 반출로 `.dockerignore`의 중첩 `.env` 제외를 검증했어요.
  root 전용 패턴에서는 `frontend/.env.local` fixture가 포함되었고, 재귀 패턴에서는 root·중첩 dotenv와 SQLite/WAL fixture가 모두 제외되면서 `.env.example`과 일반 파일은 유지되었어요.
- cache 전송·정리·workflow와 추가 Rust 오류 타입 변경에 독립 검토를 받았고, 해소되지 않은 지적은 없어요.

전송 RUN의 `--no-cache`가 실제 BuildKit cache mount를 비우는 문제는 실물 mount의 sentinel과 비어 버린 store로 구별했어요.
현재 helper는 `--no-cache` 없이 실행마다 다른 `SNAPSHOT_NONCE`를 사용하며, 독립 builder 회귀 검사가 실제 복원 적중을 확인해요.
kache가 남기는 PID 내용의 정규 advisory lock 파일은 동기화 확인 후 제외하고, 진행 중 staging·WAL·`.snapshot-uncertain`은 게시하지 않아요.

### 전체 앱 측정 조건

Ryzen 5 5600X·31 GiB 메모리의 Linux x64 호스트에서 Docker client/server 29.8.0, Buildx 0.37.1, BuildKit 0.32.2와 세션 소유 loopback registry를 사용했어요.
실제 builder의 Rust/Cargo는 1.98.1, GCC는 Debian 14.2.0-19의 14.2.0이며 kache는 0.20.0이에요.
실제 release 앱에 유한한 입력·migration 관측 guard와 작은 로컬 의존성을 추가한 허용 목록 기반 임시 복제본을 사용하며, 이 guard는 production 소스에 들어가지 않아요.
이 복제본은 최종 Clippy 오류 타입 수정 전의 동결 소스를 기준으로 하므로 정확한 최종 production 이미지 실행은 별도로 확인해요.
각 복원 사례는 builder 자체를 다시 만들어 Cargo registry/git와 target까지 비운 뒤 snapshot만 복원해요.
일반 레이어 참조는 cold baseline으로 맞추고, migration 변경·삭제는 각각 추가·변경 snapshot을 복원해 이전 입력의 캐시에서 전환해요.
진단 Dockerfile의 실행별 literal을 바꿔 Cargo RUN이 실행되게 하고 빈 target을 확인하며, report 반출은 같은 RUN 결과의 레이어 적중으로만 수행해 중복 컴파일을 측정에서 제외해요.
전체 실행 구간은 restore·실제 이미지 build/push·publish의 합이며, 비교용 builder 준비·target 비우기·report 반출·runtime probe는 별도로 기록해요.
이 수치는 실제 GitHub job 전체 시간이나 GHCR 네트워크 비용을 뜻하지 않아요.

### 전체 앱 matrix 결과

9개 사례가 모두 통과했고, 측정·진단·실행 확인을 포함한 driver 전체 경과 시간은 2,048.47초였어요.
아래 시간은 초 단위이며 Cargo 열은 Cargo가 보고한 release build 경과 시간으로, 순수 CPU 시간이나 병렬 compiler 시간의 합이 아니에요.
Rust/C·C++ hit 열은 해당 이름 범주의 `local_hit`, `compiler_runs=0`, 양수 크기 event를 집계하며 어셈블리 event와 passthrough를 섞지 않아요.

| 입력·상태 | Cargo | restore | image build/push | publish | 실행 구간 합계 | Rust/C·C++ hit |
|---|---:|---:|---:|---:|---:|---:|
| cold-baseline | 144.00 | 1.85 | 178.49 | 64.97 | 245.30 | 0/0 |
| target-warm | 0.34 | — | 8.43 | 64.53 | 72.96 | — |
| same-source | 19.43 | 49.55 | 99.89 | 60.75 | 210.19 | 568/259 |
| source-only | 41.68 | 50.79 | 103.27 | 60.90 | 214.96 | 567/259 |
| workspace-version-only | 49.19 | 50.89 | 101.94 | 61.30 | 214.12 | 561/259 |
| dependency-lockfile-only | 41.13 | 52.23 | 105.06 | 59.09 | 216.38 | 566/259 |
| migration-add | 53.68 | 50.52 | 101.62 | 60.09 | 212.24 | 561/259 |
| migration-change | 50.36 | 52.43 | 105.29 | 61.63 | 219.35 | 561/259 |
| migration-delete | 18.67 | 56.15 | 124.24 | 62.67 | 243.07 | 568/259 |

동일 소스에서 report로 관측한 Rust compiler 실행은 568회에서 0회, C/C++ compiler 실행은 261회에서 2회로 줄었어요.
해당 두 event는 `dup`이며 miss로 바꾸어 집계하지 않아요.
동일 소스의 Cargo 시간 감소와 달리 전체 구간 감소는 약 14.3%였고, snapshot 반출입 비용은 여전히 커요.
캐시 게시가 없는 cold image build/push 자체의 178.49초보다 snapshot을 사용하는 전체 구간 210.19초는 길어요.
이는 기존 cargo-chef workflow와의 비교나 GHCR에서의 속도 향상을 증명하지 않아요.

소스 변경은 `probe-v1`에서 `probe-v2`, workspace 버전은 `0.4.0`에서 `0.4.1`, 경로 의존성·lockfile 변경은 실제 반환값 `11`에서 `22`로 구별했어요.
새 migration 901은 새 DB에 테이블과 값 901을 만들었고, 같은 migration의 변경은 값 902, 삭제는 테이블 없음으로 관측했어요.
각 image에서 실제 바이너리를 실행해 결과를 확인했으며 네이티브 compiler 버전 질의와 같은 경로의 object를 교체한 재링크도 원래 출력과 변경된 출력을 정확히 반환했어요.

### 전송 단계와 크기

세부 시간은 helper의 monotonic timer로 관측한 초 단위 값이에요.
download에는 참조·metadata·압축 payload 조회가, decompression에는 gzip 해제·엄격한 tar 검사·파일 구성이, injection에는 BuildKit mount 주입이 포함돼요.
extraction에는 BuildKit 반출과 안전한 파일 구성이, compression에는 gzip pipeline이, upload에는 payload/config/후보 게시와 고정 참조 확인이 포함돼요.
raw tar 작성·receipt·CLI 준비·정리 등은 바깥 실행 구간에 포함되지만 아래 단계 열에 모두 배분되지는 않아요.
cold miss의 mount 비우기와 target-warm의 생략된 restore를 가짜 다운로드·주입 시간으로 표시하지 않아요.

| 입력·상태 | download | decompression | injection | extraction | compression | upload |
|---|---:|---:|---:|---:|---:|---:|
| cold-baseline | 0.03 | — | — | 49.58 | 11.22 | 0.99 |
| target-warm | — | — | — | 49.62 | 10.90 | 0.88 |
| same-source | 0.58 | 34.49 | 14.36 | 45.19 | 10.89 | 1.01 |
| source-only | 0.57 | 34.69 | 15.49 | 45.29 | 11.51 | 0.95 |
| workspace-version-only | 0.57 | 35.23 | 14.96 | 45.22 | 11.73 | 0.97 |
| dependency-lockfile-only | 0.58 | 36.30 | 15.30 | 43.93 | 11.40 | 0.98 |
| migration-add | 0.59 | 34.72 | 15.09 | 44.51 | 11.61 | 0.99 |
| migration-change | 0.63 | 36.50 | 15.17 | 45.14 | 12.38 | 1.00 |
| migration-delete | 0.63 | 36.22 | 19.17 | 46.03 | 12.44 | 0.99 |

크기는 bytes이며 miss/dup는 Rust·C/C++·어셈블리를 포함한 report 전체 집계예요.

| 입력·상태 | gzip 전송 | raw tar | payload 파일 | miss/dup |
|---|---:|---:|---:|---:|
| cold-baseline | 429110204 | 1200889856 | 1196557928 | 931/1 |
| target-warm | 429110088 | 1200889856 | 1196557928 | —/— |
| same-source | 431508794 | 1213091328 | 1208751881 | 0/2 |
| source-only | 442412736 | 1240655360 | 1236314033 | 1/2 |
| workspace-version-only | 455709557 | 1283406848 | 1279044997 | 7/2 |
| dependency-lockfile-only | 442428804 | 1240666624 | 1236321477 | 2/2 |
| migration-add | 452661251 | 1274031616 | 1269677155 | 4/5 |
| migration-change | 476177619 | 1347200512 | 1342824218 | 4/5 |
| migration-delete | 478597365 | 1359389696 | 1355005884 | 0/2 |

matrix 종료 후 같은 마지막 store를 별도의 loopback 측정 package로 다시 게시하면서 helper 전용 임시 디렉터리의 실제 할당 block을 `du`로 약 1초 간격, 71회 관측했어요.
관측 최대 staging 할당은 3,202,596,864 bytes로 12 GiB 상한 안이었고, payload와 raw tar가 동시에 존재하는 상태도 확인했어요.
이는 샘플링한 최대치이며 순간적인 정확한 peak나 Docker·runner 전체 disk 사용량은 아니에요.
이 추가 디스크 측정의 시간은 위 matrix 성능 값에 섞지 않았어요.

### 최종 이미지와 실패 경계

최종 작업 트리의 production Dockerfile로 새 builder에 snapshot을 복원한 뒤 실제 이미지를 빌드하고 loopback registry에 게시했어요.
복원·빌드 합계는 162.60초, Cargo 보고 시간은 61초였고 GC·daemon stop도 정상 종료했어요.
이미지 index digest는 `sha256:74f0288c79f1e4d2c0229433d1a817e82a30fbbe035df65b4794f60934e15606`이에요.

이 이미지를 별도의 빈 data/media volume으로 실행하고 실제 setup 화면을 browser observe와 screenshot으로 확인했어요.
PID 1은 UID 10001이며 `kache`, `cargo`, `rustc`, `gh`, cache/runtime/target 디렉터리와 알려진 Docker 인증 파일이 없었어요.
credential 환경 변수 없이 정적 frontend를 제공했고 `ffmpeg 6.1.1-3ubuntu5`와 `yt-dlp 2026.08.19`의 실제 version 명령도 성공했어요.
필수 `X-Requested-With: XMLHttpRequest`가 없으면 기존 CSRF guard가 403을 반환했고, 이 헤더를 갖춘 잘못된 setup token 요청은 두 번 모두 401 JSON 오류를 반환했어요.
실제 Discord 설정을 제출하거나 Discord에 접속하지 않았어요.

실제 helper·BuildKit·전체 앱을 사용한 실패 경계 검증은 1,999.08초에 모두 통과했어요.
아래 복원 거부마다 해당 mount의 전체 최상위가 비었음을 확인한 뒤 각각 별도의 실제 cold build를 실행했고, 입력 값과 migration 상태가 모두 기준값과 일치했어요.

| 의도적으로 만든 복원 실패 | 관측한 오류 |
|---|---|
| 잘못된 metadata | `INVALID_CONFIG` |
| 호환되지 않는 platform | `INCOMPATIBLE_SNAPSHOT` |
| 길이를 유지한 실제 layer 손상 | `BLOB_DIGEST_MISMATCH` |
| 실제 layer 응답 잘림 | `BLOB_SIZE_MISMATCH` |
| metadata 응답 상한 초과 | `RESPONSE_LIMIT` |
| compressed 전송 상한 초과 | `TRANSFER_LIMIT` |
| 4 GiB로 낮춘 staging 상한 초과 | `DISK_LIMIT` |
| 파일 100,000개 상한 초과 | `FILE_LIMIT` |
| 45초 응답 지연과 30초 request 제한 | `REGISTRY_TIMEOUT` |

시간 초과 사례의 helper 전체 실행은 mount 정리를 포함해 31.672초였어요.
실제 transfer image 접근을 503으로 막아 주입과 정리가 모두 실패한 경우에는 `RESTORE_CLEAR_FAILED`를 관측했어요.
원래 mount에 기존 sentinel만 남았음을 확인하고, 다른 cache ID의 전체 mount가 비었음을 확인한 뒤 실제 cold build와 실행 결과를 검증했어요.

일반 cache exporter의 503과 실제 snapshot 게시의 `PUBLISH_FAILED`·원인 `REGISTRY_STATUS` 뒤에도 이미 게시된 앱 이미지는 정상 실행되었어요.
workflow와 동일한 `mode=max,ignore-error=true` 추가 실행도 13.09초에 성공했고, 의도한 503 응답 31개와 게시 이미지의 입력·migration 실행 결과를 확인했어요.
반대로 실제 `compile_error!`와 앱 image manifest 게시의 503은 빌드를 실패시켰고, 로컬 실행 조정자는 snapshot 게시를 건너뛰었어요.
실패 사례에서 마지막 정상 snapshot 참조는 바뀌지 않았어요.
이는 실제 로컬 명령과 실패 경계의 관측이며 GitHub Actions의 조건식 실행이나 최종 conclusion을 관측한 것은 아니에요.

DBC-06의 비공개 package 접근·실제 version 삭제·태그 간 지속성·GitHub 최종 conclusion은 여전히 미확인이에요.

### 로컬 검증 자원 정리

검증용 loopback registry·fault proxy·runtime을 종료하고 전용 builder 두 개를 제거했어요.
실행 기록과 일치하는 로컬 이미지 23개만 제거했으며, 두 runtime의 익명 data/media volume 네 개가 사라진 것도 확인했어요.
임시 matrix·실패 주입·측정 스크립트와 snapshot, 다운로드한 kache 파일을 제거했고, 유지할 회귀 테스트와 실행 결과는 저장소에 남겼어요.
전역 Docker prune을 사용하지 않았으며 사용자 DB·WAL·media나 관련 없는 Docker 자원을 삭제 대상으로 삼지 않았어요.
원격 게시·삭제·push·릴리스·배포는 실행하지 않았어요.

### 추가 성능 개선

후속 성능 개선 요청에 따라 `scripts/docker-cache.mjs`의 `extractTarToDirectory`에서 정규 파일마다 실행하던 `await output.sync()`만 제거하고 임시 staging이라는 이유를 주석으로 남겼어요.
각 쓰기와 닫기는 계속 기다리며, tar 구조·경로·링크·모드·digest·파일 수·크기·disk 상한과 오류 시 destination 제거는 유지해요.
이 단계는 다음 전송이 바로 읽는 임시 파일을 만들며, 기존 구현에도 부모 디렉터리까지 동기화하는 영속 commit 계약은 없었어요.
crash durability와 지연된 writeback 오류가 관측되는 시점까지 같다고 주장하지 않아요.

동일한 1,224,685,056-byte tar와 5,581개 항목으로 `기존 → 개선 → 개선 → 기존` 순서의 단일 변수 실험을 수행했어요.
추출 시간은 기존 30.900·30.825초, 개선 1.323·1.279초였으며, 매회 다시 만든 tar digest가 같아 내용·경로·권한의 동일성을 확인했어요.
입력 파일 합계는 1,221,826,560 bytes이며 정규 파일은 4,650개였어요.

#### 전체 앱 비교 조건

현재 작업 트리의 실제 production 소스를 사용하고, 매 사례마다 새 builder와 빈 target·Cargo registry/git mount를 만들었어요.
모든 사례는 같은 일반 레이어 seed를 가져오며, 캐시 사용 사례는 같은 불변 kache snapshot을 복원해요.
일반 레이어 export는 `mode=max`와 사례별 별도 참조를 사용해 seed를 덮어쓰지 않았어요.
snapshot 고정 참조를 seed로 되돌리는 조작은 이 격리된 loopback fixture에서만 수행했어요.

호스트 `/tmp`는 tmpfs였으므로 최종 비교에서는 `TMPDIR=/home/syr/.cache/azuki-cache-perf-cB4BR1/tmp`를 명시했어요.
driver가 경로와 Btrfs filesystem type `2435016766`을 확인·기록하고 tmpfs 또는 다른 filesystem이면 거부하도록 했어요.
tmpfs를 사용한 seed 시간과 중단한 초기 비교는 아래 성능 값에 포함하지 않았어요.
처음 별도 RUN에서 읽지 못한 kache report는 같은 Cargo RUN의 tmpfs 안에서 저장하고, 그 결과만 측정 뒤에 반출하도록 임시 진단 코드를 고쳤어요.

1차 순서는 `compiler cache off → 기존 helper → 개선 helper`, 2차 순서는 `개선 helper → 기존 helper → compiler cache off`였어요.
호스트 page cache를 전역으로 비우지 않았고, 순서별 결과를 별도로 기록해요.
아래 합계는 restore·이미지 build/push와 일반 레이어 export·snapshot publish를 포함하며 builder 준비·진단 반출·runtime 검증·정리는 제외해요.
캐시 사용 행에는 같은 RUN의 진단 report 생성 18.7–19.7 ms도 포함되며 합계에서 빼지 않았어요.
`compiler cache off`는 현재 Dockerfile에서 Cargo 실행 동안 Rust wrapper와 네이티브 shim만 끈 참고 값이며, kache 설치와 후처리까지 제거한 별도 Dockerfile이나 이전 cargo-chef workflow가 아니에요.

| 순서 | 사례 | restore | image build/push·layer export | publish | 합계 |
|---|---|---:|---:|---:|---:|
| 1차 | compiler cache off | — | 138.29 | — | 138.29 |
| 1차 | 기존 helper | 50.52 | 43.77 | 58.84 | 153.13 |
| 1차 | 개선 helper | 21.51 | 42.08 | 29.47 | 93.06 |
| 2차 | 개선 helper | 22.46 | 43.25 | 29.77 | 95.48 |
| 2차 | 기존 helper | 50.11 | 42.27 | 59.87 | 152.25 |
| 2차 | compiler cache off | — | 136.64 | — | 136.64 |

시간은 초 단위이고, 합계 감소는 1차 60.07초와 2차 56.77초였어요.
복원의 압축 해제·검사·파일 구성은 1차 35.13→5.91초와 2차 34.73→6.18초로 줄었어요.
게시의 반출·파일 구성은 1차 44.02→14.36초와 2차 44.70→14.23초로 줄었어요.
반면 mount 주입은 약 14.5–14.8초, gzip 압축은 약 11.1–11.4초로 남았어요.
앞선 9-case matrix와는 소스·주변 비용이 다르므로 210.19→93.06초를 이번 수정만의 효과로 계산하지 않아요.

#### 정합성과 관측 범위

네 번의 캐시 사용 빌드 모두 구조화된 report에서 Rust local hit 567개와 compiler 실행 0회를 확인했으며 seed는 567회였어요.
seed와 네 번의 캐시 사용 결과는 모두 동일한 전체 runtime image digest `sha256:a6c215c0fe212b828fafe750b632b233493b4971f1209edc885bd3af3096f468`를 만들었어요.
소스 입력 fingerprint는 `ecb5767166c1a4f5915f3d01c1cc2791ec35130ba8192f3482b30b0366349cda`였고, 여섯 사례와 seed의 실제 Node·Rust·Ubuntu FROM digest가 모두 같았어요.
서로 다른 세 runtime image를 실제 실행해 `yt-dlp` SHA256 `1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6`와 frontend index hash가 일치함을 확인했어요.
캐시 사용과 compiler cache off 앱을 각각 시작해 browser에서 실제 setup 화면을 확인했으며 Discord 설정은 제출하지 않았어요.

Linux `RLIMIT_FSIZE=65536`의 실제 부분 쓰기 실패는 기존·개선 모두 `EFBIG`로 거부하고 destination 전체를 제거했어요.
1.22 GB payload 뒤에 1 byte를 추가한 tar도 기존·개선 모두 마지막 경계까지 도달한 뒤 `INVALID_ARCHIVE`로 거부하고 전체 staging을 제거했어요.
이는 즉시 쓰기 실패와 늦은 archive 거부의 증거이며, 지연된 writeback EIO나 crash durability 검증은 아니에요.
변경 후 helper 회귀 검사 28개가 5.58초에, `mise run check && mise run test`가 40.88초에 통과했고 독립 리뷰에서도 production 변경의 결함은 발견되지 않았어요.
실제 GHCR·GitHub runner의 시간과 권한은 여전히 DBC-06의 승인된 원격 검증 대상이에요.

성능 검증용 builder는 각 사례 종료 시 제거했고, 마지막에는 전용 registry 한 개·runtime 두 개와 내려받은 runtime image 세 개를 정리했어요.
익명 volume 다섯 개가 사라진 것을 확인하고 임시 비교 스크립트·snapshot·staging도 제거했어요.
전역 prune이나 원격 작업은 실행하지 않았어요.

### 전송 경로 추가 조정

후속 요청에 따라 readonly bind mount 주입과 payload 스트림 버퍼를 따로 측정한 뒤 두 변경을 반영했어요.
이번 기준선에는 앞서 완료한 파일별 `fsync` 제거가 이미 포함돼 있어요.
tar 파서나 snapshot 형식, gzip level 1, digest 검사, 파일·전송·disk 상한, timeout과 실패 정리 경로는 바꾸지 않았어요.

주입은 `COPY store/ /incoming/` 대신 같은 RUN의 readonly context bind mount를 사용하며 기존 locked cache mount·nonce·정리·복사를 유지해요.
초기 후보에서 COPY의 루트 `0755`와 bind 원본의 `0750`이 달랐으므로 최종 구현은 복사 뒤 cache mount 루트만 `0755`로 맞춰요.
실제 helper staging 루트는 `0700`이며 이 임시 디렉터리 권한을 cache mount에 전파하지 않아요.
내부 파일·디렉터리 권한은 계속 보존해요.

payload 파일 입출력·Transform의 high-water mark와 gzip/gunzip의 chunk size를 `1 MiB`로 맞췄어요.
`128 KiB` 후보보다 빨랐으며 registry 전송 스트림은 변경하지 않았어요.
high-water mark는 queue 임계값이지 프로세스 RSS의 절대 상한이 아니며, 메모리 사용 증가를 비용으로 받아들인 조정이에요.

#### 단일 변수 측정

Node.js `v24.19.0`, Btrfs staging에서 같은 1,223,256,576-byte tar와 5,581개 항목을 사용했어요.
입력 파일 합계는 1,219,094,820 bytes이며 artifact마다 다른 random 구간을 두어 동일 파일 중복에 따른 과도한 전송 이득을 피했어요.
각 gzip 측정은 별도 Node 프로세스에서 수행하고, 검증용 압축 해제는 측정 뒤에 실행했어요.

| 작업 | 기존 A1 | 후보 B1 | 후보 B2 | 기존 A2 |
|---|---:|---:|---:|---:|
| gzip 압축, 1 MiB 후보 | 9.310 | 7.475 | 7.456 | 9.243 |
| gzip 해제, 1 MiB 후보 | 2.005 | 1.172 | 1.148 | 2.021 |
| BuildKit 주입, 초기 bind 후보 | 8.220 | 6.567 | 6.431 | 8.170 |

시간은 초 단위이며 bind 측정은 매번 새 builder를 같은 pinned Debian 이미지로 예열한 뒤 주입 명령만 측정했어요.
초기 bind 표에는 루트 권한 보정이 포함되지 않으며 최종 구현의 시간은 아래 전체 앱 비교에서 측정했어요.
모든 버퍼 후보의 gzip은 432,363,793 bytes와 SHA256 `52f4dee1ccd01d7db4b8273466f3db81f3de2a2849ebaeb472ef6239900cbe66`로 같았어요.
압축 해제 결과도 raw tar SHA256 `8f3b40e45d39e10fa8db9de68587e6e0900ba9553c2fa3592bb54bb03237edf8`와 크기가 모두 같았어요.
1 MiB 후보의 최대 RSS는 압축에서 약 102→133–134 MiB, 해제에서 약 88→136–137 MiB로 증가했어요.
이 수치는 해당 fixture의 프로세스 관측값이며 전체 CI job 메모리 상한을 뜻하지 않아요.

#### 전체 앱 재검증

실제 앱의 동일 불변 snapshot과 `mode=max` 일반 레이어 seed를 사용해 `기존 → 개선 → 개선 → 기존` 순서로 비교했어요.
각 사례는 별도 새 builder와 빈 target·Cargo registry/git mount를 사용하며 literal nonce로 Cargo RUN을 실행하고 `--no-cache`는 사용하지 않았어요.
`TMPDIR=/home/syr/.cache/azuki-cache-tune-0FuamH/tmp`의 Btrfs와 동일 device를 확인했으며 host page cache를 전역으로 비우지 않았어요.
helper 제한은 workflow와 같은 4 GiB compressed·4 GiB raw·12 GiB staging·100,000개 파일·600초를 사용했어요.
원래 고정 참조를 seed로 되돌리는 조작과 사례별 레이어 export는 격리된 loopback registry 안에서만 수행했어요.

| 순서 | 사례 | restore | image build/push·layer export | publish | 합계 |
|---|---|---:|---:|---:|---:|
| A1 | 기존 helper | 21.45 | 42.75 | 29.32 | 93.52 |
| B1 | 개선 helper | 16.52 | 45.70 | 27.57 | 89.79 |
| B2 | 개선 helper | 16.62 | 43.07 | 28.06 | 87.74 |
| A2 | 기존 helper | 21.60 | 45.40 | 29.41 | 96.42 |

시간은 초 단위이며 합계에는 restore·이미지 build/push·일반 레이어 export·snapshot publish가 포함돼요.
같은 Cargo RUN에서 report를 생성한 17.85–20.35 ms도 포함하고, builder 준비·별도 report 반출·runtime 검증·정리는 제외해요.
restore와 publish 합계는 두 비교에서 각각 6.68초와 6.34초 줄었어요.
전체 합계 차이는 3.73초와 8.67초였지만 변경하지 않은 이미지 build/push 구간도 변동했으므로 이를 수정만의 고정 효과로 해석하지 않아요.
내부 주입은 14.83–14.99→11.41–11.46초, 압축은 11.14–11.18→9.00–9.04초였어요.

네 비교 모두 Rust local hit 567개·compiler 실행 0회였고 seed는 compiler 실행 567회였어요.
source fingerprint `b1cda2d5c62c5547df8f8477cdd21778741f0dc87190c4039bfee913a083d5d6`와 실제 Node·Rust·Ubuntu FROM digest가 유지됐어요.
실험용 producer source SHA는 입력 manifest로 만든 합성 SHA1이며 실제 Git commit SHA를 뜻하지 않아요.
seed와 네 결과의 `linux/amd64` runtime manifest는 모두 `sha256:ede0577ddccadd83f95928629b47c32dcfb65b2e98eee207fe92c8363d09cdf7`였어요.
attestation descriptor가 다른 OCI index 전체 digest와는 구분해요.
각 이미지를 digest로 실행해 앱 바이너리·frontend index·yt-dlp hash가 같음을 확인하고 개선 runtime의 실제 setup 화면도 browser에서 확인했어요.
Discord 설정은 제출하지 않았어요.

#### 실패 경계와 정리

실제 helper 복원으로 루트 `0755`, 내부 `0750`·`0755`·`0640`·`0660`, 모든 파일 hash와 UID/GID의 기존·개선 동일성 및 stale 파일 제거를 확인했어요.
검증된 다운로드 파일의 gzip method byte만 고치는 격리된 fault를 넣었을 때 `INVALID_GZIP_PAYLOAD`로 거부하고 이미 채워진 실제 cache mount가 비워졌어요.
이 fault는 registry blob을 수정하지 않았으며 네트워크상 digest 검증을 우회할 수 있다는 의미가 아니에요.
기존·개선 양쪽의 압축·해제에서 `RLIMIT_FSIZE=65536`에 따른 실제 `EFBIG` 부분 쓰기를 거부하고 출력 제거와 기존 destination 보존을 확인했어요.
25 ms timeout도 양쪽에서 `OPERATION_TIMEOUT`으로 중단하고 출력을 제거했으며 관측 시간은 25.44–28.04 ms였어요.

기존 gzip 경계 회귀 검사를 여러 1 MiB chunk 뒤의 누적 초과와 정확한 크기·disk 경계의 성공까지 확인하도록 넓혔어요.
올바른 구현에서는 통과하고 출력 상한 검사를 제거한 격리된 변이에서는 기대한 거부가 없다는 이유로 실패했어요.
helper 회귀 검사 28개, `mise run check && mise run test`, frontend `npx tsc --noEmit && npm run build`가 모두 통과했어요.
독립 리뷰에서도 이번 production delta의 결함은 발견되지 않았어요.

전용 builder는 각 사례에서 제거했고 마지막에 registry·runtime container와 익명 volume 세 개의 부재를 확인했어요.
기록한 runtime image 참조 다섯 개와 임시 비교 스크립트·snapshot·staging도 제거했어요.
전역 prune이나 원격 작업은 하지 않았으며 실제 GHCR·GitHub runner 검증은 여전히 DBC-06에 남아 있어요.

### v0.5.0 인증 보정

별도로 승인된 [v0.5.0 릴리스](https://github.com/nanazt/azuki/releases/tag/v0.5.0)는 소스 `173107b2f81066587db0ac32b28d3c31606697ff`의 [workflow 실행](https://github.com/nanazt/azuki/actions/runs/35433871371)에서 전체 `success`로 완료됐어요.
runtime 이미지와 BuildKit layer cache는 게시됐지만, 별도 kache snapshot은 restore가 `not-found`였고 publish의 `upload-payload` 단계에서 `PUBLISH_FAILED`·`AUTH_REPLAY_UNSAFE`로 중단됐어요.
실패 보고의 publication은 `abandoned`, `immutableRef`와 `manifestDigest`는 `null`이었으며 새 snapshot의 검증·고정 참조 승격은 완료되지 않았어요.
이 캐시 단계의 `continue-on-error: true` 때문에 전체 workflow 성공과 snapshot 게시 실패가 함께 나타났어요.

원격 로그에는 실제 Bearer challenge의 scope가 없으므로 그 문자열이 권한 순서 차이였다고 확정하지 않아요.
다만 기존 클라이언트에서 요청의 `pull,push`와 challenge의 `push,pull`을 서로 다른 토큰 캐시 키로 취급해, 인증을 마친 뒤에도 스트리밍 PATCH에 Bearer 대신 Basic을 보내는 결함을 로컬에서 재현했어요.
`scripts/docker-cache.mjs`는 scope 항목과 각 항목의 action 순서만 정규화한 키를 토큰 저장·조회에 공통으로 사용하도록 보정했어요.
토큰 서버에 전달하는 원래 challenge, repository·권한 집합 구분, 스트리밍 요청의 `401` 재전송 금지는 유지해요.
수정된 클라이언트 직접 실행에서는 `push,pull` challenge 뒤의 PATCH와 PUT에 Bearer가 전달되고 업로드가 완료됐으며, source와 호출 경로의 독립 리뷰에서도 수정으로 생긴 결함은 발견되지 않았어요.

같은 file-backed OCI 게시 회귀 사례는 v0.5.0 원본 소스에서 `upload-payload`의 `PUBLISH_FAILED`·`AUTH_REPLAY_UNSAFE`로 실패하고, 수정본에서 검증·승격까지 통과했어요.
서로 다른 repository·권한 집합의 토큰으로 각 스트림을 인증하는 검사와, 반복 `401`에서 스트림을 재전송하거나 blob을 확정하지 않는 검사도 통과했어요.
격리된 복사본에서 모든 scope를 같은 키로 합치는 결함을 넣었을 때 토큰 분리 검사가 실제 인증 거부로 실패하는 것도 확인했어요.
`mise run test-docker-cache` 38개, `mise run test-release` 36개, `mise run check && mise run test`, frontend `npx tsc --noEmit && npm run build`가 모두 통과했어요.
원본 비교와 결함 주입에 사용한 임시 디렉터리는 제거했어요.

이번 인증 보정은 로컬 수정·검증 범위이며 push, workflow 재실행, 새 릴리스는 수행하지 않아요.
수정 후 실제 GHCR snapshot 게시·후속 runner 복원·receipt와 보관 검증은 아직 수행하지 않았고 DBC-06에 남아 있어요.
