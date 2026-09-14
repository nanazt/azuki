# Docker 빌드 캐시 전환 구현 명세

## 근거와 권한

2026-09-13의 대화에서 사용자는 cargo-chef를 제거하고 Docker BuildKit cache mount와 kache를 사용하는 방향을 선택했어요.
릴리스 사이의 캐시 저장·복원 방식은 선택 질문을 통해 GHCR 캐시 스냅샷으로 확정했어요.
GitHub가 제공하는 runner를 사용하는 현재 환경과 태그 전용 릴리스 workflow를 유지해요.

이 문서는 해당 결정과 이어서 제안한 구현 범위를 실행 가능한 계약으로 구체화해요.
kache 저장소만 원격 보관하는 구성, 일반 레이어 캐시의 GHCR 전환, 캐시 전용 비공개 패키지, 최신 정상 스냅샷 2개 보관, 비치명적인 캐시 실패 처리, 네이티브 C/C++ 연동과 migration 입력 추적은 이어진 범위 제안의 기술적 기본안이에요.
이하 계약은 그 기본안을 구체화한 것이며, 각 항목에 대해 별도로 받은 사용자 승인이라고 기록하지 않아요.
이 명세에 따른 DBC-01부터 DBC-05까지의 로컬 구현은 후속 요청으로 승인되어 소스에 반영되었어요.
이 명세와 로컬 구현은 GHCR 패키지 생성·게시·삭제, push, 릴리스 또는 운영 서버 변경을 승인하지 않아요.
근거가 되는 현재 파일은 [Dockerfile](../../Dockerfile), [workflow 원본](../../workflows/docker.ts), [Cargo 설정](../../Cargo.toml), [의존성 잠금](../../Cargo.lock), [migration 포함 지점](../../crates/azuki-db/src/lib.rs), [릴리스 workflow 검증](../../.agents/skills/release/scripts/core.mjs), [릴리스 완료 판정](../../.agents/skills/release/scripts/publish.mjs)이에요.
외부 동작 계약의 출처는 문서 마지막에 정리해요.

## 문제와 완료 결과

전환 전 Dockerfile은 cargo-chef를 설치한 뒤 recipe를 만들고 의존성 빌드 결과를 일반 이미지 레이어에 남겼어요.
전환 전에는 Cargo registry/git만 cache mount였고 `target`은 일반 builder 파일시스템에 있었어요.
전환 전 workflow는 `ubuntu-latest`에서 `v*` 태그 push에만 실행되고 `type=gha,mode=max`로 레이어 캐시를 저장했어요.
GitHub Actions 캐시는 서로 다른 태그에서 생성한 캐시를 직접 공유하지 않으므로, 이전 릴리스 태그의 캐시가 다음 릴리스의 기본 복원 원본이 되지 못했어요.

[v0.4.0 실행](https://github.com/nanazt/azuki/actions/runs/34756435891)에서는 cargo-chef 설치에 63.6초, 의존성 cook에 176.7초, 실제 azuki 빌드에 68.8초, GHA 캐시 내보내기에 115.1초가 걸렸어요.
이 값은 기존 실행의 단계별 관측값이고, kache의 예상 절감량이나 같은 조건의 비교 실험 결과가 아니에요.

완료 결과는 cargo-chef 없이 직접 빌드하면서, 새 runner에서도 이전 릴리스의 kache 저장소를 복원해 동일 입력의 컴파일 결과를 재사용하는 것이에요.
캐시가 비어 있으면 정상적인 전체 빌드가 가능해야 하고, 캐시를 사용해도 변경한 소스·의존성·migration이 최종 산출물에서 누락되면 안 돼요.
런타임 이미지의 기능과 기존 릴리스 성공 기준은 유지해요.

## 범위와 제외

이번 구현은 Docker 내부의 Rust·지원되는 C/C++ 컴파일 캐시 연동, GHCR 스냅샷 반출입과 보관, 일반 레이어 캐시의 GHCR 전환, migration 입력 추적, 실패·삭제 경계 검증을 포함해요.
컴파일은 계속 Docker 안에서 수행하며, 호스트에서 컴파일한 바이너리를 포장하는 구조로 바꾸지 않아요.

S3/R2, Actions artifact 전송, 기본 브랜치 캐시 예열 workflow, 직접 운영하는 runner나 원격 builder 서버, 멀티 아키텍처 확대는 제외해요.
`target` 전체와 Cargo registry/git을 릴리스 간 스냅샷에 넣는 방식도 제외해요.
애플리케이션 기능·DB 스키마·release 최적화 설정·실제 배포·실패한 릴리스의 자동 재시도는 변경하지 않아요.

현재 대상은 `linux/amd64`예요.
플랫폼 구분은 잘못된 캐시 혼합을 막기 위한 것이며, 다른 플랫폼 빌드 지원을 추가한다는 뜻은 아니에요.

## 캐시 계층과 저장 경계

| 계층 | 소유하는 데이터 | 재사용 범위 |
|---|---|---|
| 일반 Docker 레이어 캐시 | 패키지 설치, 프런트엔드 빌드, 일반 파일시스템 출력이에요. | GHCR registry cache로 릴리스 사이에 공유해요. |
| Cargo registry/git mount | 내려받은 crate와 Git 의존성이에요. | 같은 BuildKit builder 안에서 재사용해요. |
| Cargo `target` mount | Cargo의 컴파일 산출물, fingerprint, 빌드 스크립트 출력이에요. | 같은 BuildKit builder 안에서 재사용해요. |
| kache mount | kache의 컴파일 결과 저장소와 복원에 필요한 인덱스예요. | GHCR 스냅샷으로 새 builder에도 전달해요. |

Cargo가 `target`을 최신으로 판단하면 rustc와 kache를 호출하지 않아도 돼요.
Cargo가 컴파일을 요청할 때 kache가 같은 입력의 결과를 복원하고, 미적중이면 실제 컴파일러를 실행해요.
Cargo의 재사용, kache의 적중, Docker의 RUN 레이어 적중을 서로 다른 관측값으로 취급해요.

BuildKit의 `cache-to=registry`와 `mode=max`는 cache mount 내용을 자동으로 내보내지 않아요.
따라서 일반 레이어 캐시 설정과 kache 스냅샷의 명시적인 추출·복원을 모두 구현해야 해요.
같은 mount ID를 사용한다는 이유만으로 새 runner의 mount가 복원됐다고 판단하지 않아요.

초기 구현은 `target`과 kache 저장소를 별도 mount로 관리해요.
서로 다른 mount 사이에서 reflink나 hardlink가 가능하다고 가정하지 않으며, zero-copy를 완료 기준이나 성능 약속으로 사용하지 않아요.
캐시가 정리되거나 mount가 없어져도 올바른 빌드를 수행하는 성질은 유지해요.

## Docker 컴파일 계약

로컬 구현은 cargo-chef 설치, planner 단계, recipe 생성, cook을 제거하고 하나의 직접적인 release 빌드 경로로 전환했어요.
기존 의존성 잠금을 따르도록 `cargo build --locked --release --bin azuki`를 사용해요.
`SQLX_OFFLINE=true`와 기존 release profile의 `strip`, `opt-level`, thin LTO, `codegen-units` 의미를 유지해요.
kache의 적응형 incremental 정책 때문에 기존 release 컴파일 정책을 암묵적으로 바꾸지 않아요.

Dockerfile은 kache `v0.20.0`의 해당 플랫폼 사전 빌드 바이너리와 SHA-256 `fe5ce52406e0dcb8c9a49798671a073440cae13a88731b1b712b7c0fa372b85b`를 고정해 검증해요.
도입을 위해 매번 `cargo install kache`로 도구 자체를 컴파일하지 않아요.
새로 도입하는 원격 실행 도구를 가변 브랜치나 검증하지 않은 다운로드에 연결하지 않아요.

Rust는 Docker 내부의 `RUSTC_WRAPPER`로 연결해요.
kache의 외부 원격 저장소나 planner는 사용하지 않고, GHCR 전송은 workflow의 캐시 helper가 맡아요.
Docker 전용 cache/runtime 경로와 실행 정책은 Docker 환경에 두어 로컬 개발자의 kache 저장 위치를 바꾸지 않아요.
구현은 `/var/cache/kache`의 로컬 전용 `KACHE_MAX_SIZE=3GiB` GC 크기 설정과 `/run/kache` tmpfs runtime을 사용해요.
자동·background GC는 끄고 컴파일 뒤에만 명시적인 동기 GC를 실행하며, 이 GC 크기 설정은 컴파일 중 또는 staging 중의 연속적인 전체 디스크 사용량 hard 상한을 뜻하지 않아요.

C/C++은 kache가 지원하는 wrapper 또는 shim 방식을 하나 선택해 연결해요.
현재 `cc = 1.2.56`은 `RUSTC_WRAPPER=kache`만으로 네이티브 컴파일까지 자동 연결되지 않으므로 실제 cc·CMake 호출을 검증해야 해요.
기존 컴파일러 선택과 네이티브 빌드 인자를 보존하고, 불필요한 의존성 업데이트나 중복 wrapping은 하지 않아요.
지원되는 오브젝트 컴파일은 캐시하고, 지원되지 않는 링크·도구 호출은 정상 컴파일로 통과시켜요.
네이티브 빌드 스크립트의 실행 자체까지 캐시된다고 주장하지 않아요.

소스 입력은 기존 `Cargo.toml`, `Cargo.lock`, `crates/`, `migrations/`의 명시적인 COPY와 이번에 필요한 kache 설정으로 제한해요.
현재 Docker에서 사용하지 않는 `.cargo/config.toml`과 루트 cmake wrapper를 무관하게 가져오지 않아요.
실제 SQLite 파일, 미디어, 사용자 설정, 인증정보가 포함될 수 있으므로 `COPY . .`로 바꾸지 않아요.

최종 바이너리는 컴파일한 같은 RUN에서 mount 밖의 일반 파일시스템으로 복사해요.
runtime stage는 그 복사본만 사용하며, 실행 시 `target`이나 kache mount가 필요하지 않아야 해요.
프런트엔드 빌드 방식과 런타임 사용자·권한·포트·볼륨·환경변수·진입점은 유지해요.

## GHCR 저장 형식과 식별

기본 저장 위치는 런타임 패키지와 분리한 `ghcr.io/nanazt/azuki-build-cache`예요.
새 패키지는 비공개를 기본으로 하고, 연결된 저장소의 기존 `GITHUB_TOKEN` 권한으로 접근해요.
패키지 생성·접근 권한의 실제 동작은 승인된 원격 workflow 실행에서 확인해야 해요.
GitHub 문서는 `GITHUB_TOKEN`의 package 삭제·복원 REST API 접근에 package admin 권한이 필요하고 이 기능이 public preview임을 명시하므로, 해당 원격 권한과 동작은 승인된 DBC-06 실행 전에는 미확인으로 유지해요.

일반 레이어 캐시와 kache 스냅샷은 같은 저장 위치를 사용하더라도 서로 다른 참조와 종류 식별자를 가져야 해요.
런타임 패키지 `ghcr.io/nanazt/azuki`의 버전·major.minor·latest 참조는 캐시 대상으로 사용하지 않아요.

복원용 고정 참조는 플랫폼, 스냅샷 형식, kache 저장소 호환성을 구분해요.
애플리케이션 릴리스 태그, 소스 SHA, `Cargo.lock` 해시는 복원 공간을 매번 새로 만드는 키로 사용하지 않아요.
개별 컴파일 입력의 변경 여부는 kache의 입력 키가 판정하고, 이 값들은 필요한 경우 출처 정보로만 기록해요.

스냅샷은 명시적으로 추출한 kache 저장소를 담은 캐시 전용 OCI 이미지로 보관해요.
이미지는 저장 형식이며 복원 과정에서 그 이미지의 진입점이나 내부 프로그램을 실행하지 않아요.
kache의 기본 원격 backend에 GHCR이 있다고 가정하거나 별도의 registry backend를 kache에 구현하지 않아요.

스냅샷에는 형식 버전, 저장소·캐시 종류, 플랫폼, kache 버전, 생성한 소스·workflow 실행의 출처와 payload의 무결성을 확인할 정보를 담아요.
생산 저장소, workflow 실행 ID와 attempt를 스냅샷의 필수 불변 식별 정보에 포함하고, 다른 실행이 같은 생산자 식별을 재사용하지 않아요.
정확한 직렬화 형식은 helper 내부 구현이지만, 출처 메타데이터와 컴파일 적중 키를 혼동하지 않아요.

구현한 OCI payload는 gzip level 1로 압축한 tar 레이어예요.
스냅샷 메타데이터와 OCI layer descriptor는 압축 payload digest를 검증하고, OCI `rootfs.diff_ids`는 압축 전 raw tar digest를 기록해 두 무결성 식별자를 구분해요.
알 수 없는 형식이나 확인하지 못한 호환성을 임의의 기본값으로 보완하지 않아요.

고정 참조를 먼저 digest로 확정하고 그 digest의 이미지를 복원해요.
전송 도구가 검증한 OCI digest를 활용하며, 검증되지 않은 부분 파일을 정상 캐시로 사용하지 않아요.
잘못된 경로나 cache root 밖을 가리키는 링크가 추출 범위를 벗어나 파일을 쓰지 못하게 해요.

## 복원·게시·정리 수명주기

### 복원

복원은 GHCR 인증 뒤, 애플리케이션 이미지 빌드 전에 수행해요.
후보 스냅샷의 종류·플랫폼·형식·도구 호환성을 확인한 뒤 job 전용 임시 위치에 받아요.
완전한 후보만 실제 빌드에 사용하는 같은 BuildKit builder와 정확한 mount ID로 주입해요.

부분 복원이나 손상된 후보는 폐기하고 오염되지 않은 빈 캐시로 빌드해요.
주입을 위한 RUN이 일반 레이어 적중으로 생략되어 빈 mount가 그대로 남지 않도록 해요.
복원은 애플리케이션 소스와 설정을 덮어쓰거나 기존 `target`을 원격에서 가져오는 작업이 아니에요.

### 게시

애플리케이션 이미지의 빌드·게시가 성공한 경우에만 이번 실행의 캐시를 게시해요.
취소되거나 실제 빌드가 실패한 실행은 정상 스냅샷의 고정 참조를 갱신하지 않아요.

컴파일러, daemon 또는 GC가 저장소를 변경하는 동안 파일을 복사해 일관성이 없는 SQLite 스냅샷을 만들지 않아요.
빌드는 먼저 `.snapshot-uncertain` marker를 만들고, 성공한 컴파일 뒤 bounded GC, daemon stop, `daemon.run.lock` 배수 확인을 모두 통과한 경우에만 marker를 지워요.
helper는 marker가 남은 저장소의 게시와 복원을 거부해 일관성을 확인하지 못한 cache mount를 정상 snapshot으로 취급하지 않아요.
필요한 인덱스와 blob의 일관성 및 파일 권한을 보존하고, runtime 소켓·잠금·실행 로그는 저장 대상에서 분리해요.
아카이브를 사용하면 안전한 경로와 권한을 보존하며, 큰 payload는 스트리밍 또는 파일 기반으로 처리해요.

캐시 추출은 별도 단계에서 명시적으로 실행하고 일반 RUN 레이어 적중으로 생략되지 않게 해요.
cache-dance를 사용한다면 기본 post 추출이 일반 업로드 단계보다 늦다는 점을 반영해 명시적 추출 경로를 사용해요.
필요한 반출입만 구현하며 여러 동등한 전송 경로나 범용 캐시 프레임워크를 만들지 않아요.

새 스냅샷을 완전히 업로드하고 조회·무결성을 확인한 뒤 복원용 고정 참조를 갱신해요.
게시 도중 실패했다고 기존 정상 스냅샷을 먼저 삭제하거나 불완전한 스냅샷을 복원 대상으로 만들지 않아요.
동시에 정상 게시가 발생하면 마지막으로 정상 갱신한 참조를 사용하며, 스냅샷을 병합하는 분산 저장소는 구현하지 않아요.

각 실행은 자신이 새로 업로드하고 검증한 불변 스냅샷만 고정 참조로 승격할 수 있으며, 과거 스냅샷이나 다른 실행의 후보를 나중에 다시 승격하지 않아요.
정상 종료 경로에서는 승격을 완료하거나 게시 시도를 명시적으로 포기한 뒤에 생산 workflow를 완료하고, 완료된 생산자에 남아 있는 승격 경로를 두지 않아요.
취소·runner 상실·응답 불확실성으로 게시 종료를 확인하지 못한 후보는 보호 상태로 남기고 정상 정리 대상에 포함하지 않아요.
이 불변 조건으로 진행 중인 생산자의 후보와 완료된 생산자의 정리 후보를 구분하며, 캐시를 위해 전체 릴리스 workflow의 실행 순서나 취소 정책을 바꾸지 않아요.

승격한 고정 참조를 다시 검증한 뒤에만 불변 snapshot과 정확히 연결된 completion receipt를 게시해요.
receipt는 snapshot의 manifest·config·layer descriptor와 raw tar digest 및 생산 run·attempt를 기록해 정리의 완료 증거로 사용해요.

### 보관과 정리

기술적 기본안은 플랫폼별 최신 정상 kache 스냅샷 2개를 보관하는 것이에요.
릴리스 간격만으로 마지막 정상 스냅샷을 만료시키지 않아요.
새 스냅샷의 게시·고정 참조 갱신이 확인된 뒤에만 정리를 수행해요.

정리는 정확한 캐시 전용 패키지 안에서 이 helper가 관리하는 정상 kache 스냅샷으로 식별된 버전만 대상으로 해요.
현재 고정 참조, 보존할 이전 스냅샷, 일반 BuildKit 레이어 캐시, 다른 플랫폼, 식별하지 못한 버전과 런타임 패키지는 삭제하지 않아요.
manifest의 의존 객체를 삭제해 보존한 스냅샷을 깨뜨리지 않도록 하고, 단순히 모든 untagged 버전을 삭제하는 정책은 사용하지 않아요.

삭제 후보는 정확한 생산 workflow run과 attempt가 `completed/success`이고 해당 snapshot과 정확히 일치하는 completion receipt를 가진 helper 관리 스냅샷으로 제한해요.
생산자가 진행 중이거나 상태를 조회할 수 없거나 게시 종료가 불명확한 후보는 삭제하지 않아요.
보호할 후보 때문에 일시적으로 보관 개수를 초과하면 개수보다 보호를 우선해요.

삭제 직전에 고정 참조와 보존할 이전 참조를 다시 조회해 보호하고, 후보 조회가 불완전하거나 참조가 바뀌어 보호 대상을 확정할 수 없으면 해당 정리를 생략하고 경고해요.
개별 정리 실패는 이미 게시한 정상 스냅샷이나 애플리케이션 이미지의 성공을 되돌리지 않아요.
이 보관 개수는 kache 스냅샷에 관한 정책이며, 일반 registry 레이어 캐시의 전체 과거 버전 정리까지 구현한다는 뜻은 아니에요.

## 실패·자원·신뢰 경계

| 상태 | 요구하는 처리 |
|---|---|
| 최초 실행·스냅샷 부재 | 정상적인 전체 빌드로 진행해요. |
| 다른 플랫폼·호환되지 않는 형식·손상 | 후보를 사용하지 않고 빈 캐시로 진행해요. |
| 조회·인증·전송·복원 오류 | 원인을 구분해 경고하고 캐시 없이 진행해요. |
| 스냅샷 추출·업로드·참조 갱신 오류 | 경고하고 기존 정상 스냅샷을 유지해요. |
| 정리 오류 | 경고하고 정리를 중단하며 정상 참조를 유지해요. |
| 실제 의존성 확보·컴파일·이미지 게시 오류 | workflow를 실패 처리하고 캐시 갱신으로 숨기지 않아요. |

첫 full cold store의 로컬 관측값은 1,181,588,715 bytes와 931개 항목이에요.
현재 helper는 compressed OCI 전송과 raw tar 및 payload 파일에 각각 4 GiB hard 상한을 적용하고 helper staging 작업 공간에만 12 GiB hard 상한을 적용해요.
이 12 GiB는 Docker builder·이미지 레이어·runner 전체의 디스크 사용량 보장이 아니에요.
workflow는 snapshot당 최대 100,000개 파일을 전달하고, helper의 개별 tar·전송·registry 작업에는 600,000 ms deadline을 적용해요.
600,000 ms는 helper CLI 전체 실행 시간의 단일 상한이 아니며, cache-only restore와 publish step의 15분 workflow timeout이 그 전체 단계의 바깥 경계예요.
GHCR의 단일 레이어 10 GB와 upload 10분 제한보다 작은 전송 상한을 사용하고, 상한 초과를 감지하면 메모리나 디스크를 무제한으로 소비하지 않고 해당 캐시 작업을 중단해요.
보관 상한이나 cache 작업 때문에 중단한 경우를 성공으로 표시하지 않으며, 성공한 애플리케이션 이미지 게시를 cache 실패로 되돌리지 않아요.

외부 입력 오류나 일시적 cache 실패는 캐시 경로에서 격리하지만, 실제 빌드 단계에 광범위한 `continue-on-error`를 적용하지 않아요.
복원 여부, 실패·생략 이유, 사용한 digest, 전송 크기·시간과 관찰한 캐시 통계를 로그에 남겨요.
새로운 외부 telemetry 서비스는 추가하지 않아요.

GHCR 인증정보는 runner의 인증 경계에만 두고 Docker ARG, COPY 대상, 스냅샷, 메타데이터 또는 로그에 넣지 않아요.
복원 원본을 임의의 PR artifact나 다른 저장소가 제공한 주소로 바꾸지 않아요.
일시적인 캐시 miss를 이유로 공개 패키지 전환, 새 PAT 발급 또는 권한 확대를 자동 수행하지 않아요.

## migration과 컴파일 입력 정합성

현재 `azuki-db`는 `sqlx::migrate!("../../migrations")`로 SQL 파일을 바이너리에 포함해요.
SQLx 0.8.6은 기존 파일을 `include_str!`로 추적하지만 Rust 소스 변경 없이 새 migration만 추가하는 경우의 감지에는 별도 경로가 필요해요.
격리 scratch migration harness는 global Cargo config의 override를 포함한 모든 Rust wrapper override를 비우고 native host wrapper도 override해 wrapper 없는 경로를 강제했어요.
그 scratch에서 `azuki-db/build.rs`를 `fn main() {}`로 바꾸면 added-migration 정합성 검사가 10.76초에 실패했고, watcher를 복원하면 wrapper-free·cached add/change/delete와 기존 DB의 `VersionMismatch(901)`·`VersionMissing(902)` 검사가 53.58초에 통과했어요.
이 재현과 검사는 production DB를 사용하지 않았어요.

로컬 구현의 `crates/azuki-db/build.rs`는 Cargo에 migration 디렉터리 변경 추적을 명시해요.
이 경로는 kache를 사용하지 않는 일반 Cargo 빌드에서도 새 파일의 추가·삭제·변경을 감지하기 위한 것이에요.

로컬 구현의 루트 `.kache.toml`은 `azuki-db`의 `migrations/**/*.sql`을 workspace 추가 입력으로 선언해요.
파일 목록과 내용이 kache 키에 반영되어야 하며, Cargo의 재빌드 요청만으로 kache의 오래된 적중을 방지했다고 판단하지 않아요.
해당 설정은 Docker의 명시적인 COPY 입력에도 포함해요.

검토한 kache v0.20.0은 추가 입력의 디렉터리 감시 정보를 Cargo dep-info에도 반영해요.
따라서 두 파일을 두는 이유는 kache가 반드시 build.rs를 요구해서가 아니라, wrapper가 없는 Cargo 경로와 wrapper의 내용 기반 키를 각각 명시하기 위해서예요.
이미 Cargo가 최신이라고 판단한 target에 설정만 추가해서는 wrapper가 실행되지 않을 수 있으므로, 전환 검증은 새 target 또는 명시적인 해당 패키지 재빌드에서 시작해요.

기존 SQL의 적용 순서·checksum·DB 스키마를 바꾸지 않아요.
검증용 SQL 파일과 DB는 격리된 작업 사본에서만 사용하며 운영 DB나 실제 migration 집합에 시험 데이터를 남기지 않아요.

## workflow와 릴리스 호환성

workflow 원본은 계속 `workflows/docker.ts`이고 생성 YAML은 `npx gaji build`로 재생성해요.
`docker.yml` 경로, `v*` push trigger, GitHub 제공 runner, 런타임 이미지 참조와 기존 버전·major.minor·latest 태그 규칙을 유지해요.
캐시 이미지를 런타임용 metadata 태그 규칙에 섞지 않아요.

로컬 workflow 원본은 기존 `type=gha` 레이어 캐시를 별도의 GHCR registry cache 참조로 전환했어요.
이름 붙인 setup-buildx step의 builder output은 실제 image build와 restore·publish helper 모두에 전달해 같은 BuildKit builder와 `/var/cache/kache` mount를 선택해요.
restore는 run·attempt 고유 `RESTORE_ID`를 대상으로 하며 helper가 성공한 뒤에만 그 ID를 output으로 기록해요.
build와 publish는 restore output 또는 별도의 run·attempt 고유 `FALLBACK_ID`를 선택하므로 실패하거나 부분적으로 reset된 restore mount가 컴파일에 도달하지 않아요.
cache 복원은 빌드 전에 실행하고 kache 추출·게시는 명시적 image build·push action이 성공한 뒤에만 실행해요.
일반 registry layer cache exporter와 kache 전송·정리는 경고를 남기는 비치명적 경계로 격리하지만 실제 의존성 확보·컴파일·이미지 push는 계속 workflow를 실패 처리해요.

정리 시 생산 workflow 상태를 확인하도록 build job에 최소 읽기 권한인 `actions: read`를 선언해요.
이 권한은 캐시 후보의 종료 상태를 조회하는 데만 사용하고, workflow 재실행·취소·수정 권한을 추가하지 않아요.

현재 release 자동화는 workflow 원본과 생성 YAML의 fingerprint, 소스 SHA, 정확한 태그·SHA의 workflow 실행, 최종 `completed/success`를 검증해요.
캐시 단계를 추가한 새 workflow에는 새 inspect/plan이 필요하며, 오래된 승인 계획이 무효화되는 기존 동작을 유지해요.
이를 피하려고 fingerprint 검사를 약화하거나 기존 승인 계획을 고치지 않아요.

캐시 상태를 release 승인·복구 상태 기계에 편입하지 않아요.
기존 inspect/plan/publish/resume 로직, 실패한 workflow의 자동 재실행 금지, 동시 릴리스 차단과 런타임 태그 검증은 유지해요.
캐시 기능만을 위해 release 핵심 모듈을 공통화하거나 새 원격 게시 경로를 release CLI에 추가하지 않아요.

## 구현 경계

| 지점 | 책임 |
|---|---|
| 기존 `Dockerfile` | chef를 제거하고 직접 빌드, kache·mount 구성, 명시적인 입력과 바이너리 복사를 소유해요. |
| 기존 `workflows/docker.ts`와 생성 YAML | 레이어 캐시와 snapshot 작업의 순서·조건·실패 경계를 소유해요. |
| 신규 CI cache helper | GHCR 후보 조회, mount 반출입, 스냅샷 게시·정리와 제한을 한곳에서 소유해요. |
| 신규 helper 회귀 테스트 | 격리된 명령·registry/API fixture로 실패 처리와 보호 경계를 검증해요. |
| 신규 루트 `.kache.toml` | workspace의 숨은 컴파일 입력을 선언해요. |
| 신규 `crates/azuki-db/build.rs` | Cargo 자체의 migration 변경 추적을 소유해요. |
| 기존 `mise.toml` | helper 테스트를 기존 검증 명령과 함께 실행할 수 있게 해요. |
| 기존 `README.md` | 캐시 사용·실패·보관 정책과 검증 한계를 짧게 설명해요. |

helper와 테스트는 기존 release 도구의 의존성 없는 Node 스크립트와 `node:test` 관례를 따라요.
기존 도구의 책임을 섞지 않고 workflow 전용 helper와 검증 경계를 만들어요.
세부 파일명·함수명·전송 명령 선택은 이 계약을 만족하는 구현 선택이며 별도 사용자 정책이 아니에요.

## 관찰 가능한 완료 기준

| 시나리오 | 반드시 관찰할 결과 |
|---|---|
| 모든 캐시가 비어 있어요. | 잠금 파일을 유지하면서 정상 런타임 이미지를 만들어요. |
| 같은 builder에서 재빌드해요. | Cargo 또는 Docker가 불필요한 작업을 생략하고 결과는 동일한 기능을 제공해요. |
| 새 builder와 빈 target에 kache만 복원해요. | 동일 입력의 실제 Rust 컴파일 실행이 줄어들고 정상 이미지를 만들어요. |
| 네이티브 컴파일 입력이 동일해요. | 실제 azuki 의존성의 지원되는 C/C++ 오브젝트 호출에서 복원 효과를 확인해요. |
| 지원되지 않는 네이티브 호출이 있어요. | 해당 호출이 정상 컴파일로 통과하고 출력이 누락되지 않아요. |
| Rust 소스·의존성·release 버전이 바뀌어요. | 바뀐 입력에 맞는 결과를 만들고 이전 산출물로 잘못 대체하지 않아요. |
| Rust 소스는 그대로이고 migration만 추가돼요. | 복원한 캐시를 사용한 바이너리가 새 migration을 포함하고 임시 DB에 적용해요. |
| 기존 migration 내용이 바뀌거나 파일이 제거돼요. | 컴파일 입력이 무효화되고 변경한 집합이 반영되며 SQLx의 기존 DB 검증 의미를 유지해요. |
| kache 없이 migration 추가를 빌드해요. | Cargo가 필요한 재빌드를 수행해요. |
| cache 형식·플랫폼·digest가 맞지 않아요. | 후보를 거부하고 부분 상태 없이 정상 전체 빌드로 진행해요. |
| 추출·게시 중 실패하거나 크기·시간 상한에 도달해요. | 작업이 유한하게 종료되고 기존 정상 참조가 유지돼요. |
| 정리 후보에 다른 종류·플랫폼·보호된 참조가 섞여요. | 삭제 경계를 넘지 않고 보존된 스냅샷을 계속 복원할 수 있어요. |
| 한 생산자가 후보를 올린 뒤 다른 생산자가 참조 갱신·정리를 수행해요. | 진행 중인 생산자의 후보는 삭제되지 않고 각 생산자는 자신의 검증된 스냅샷만 완료 전에 승격해요. |
| 생산 실행 상태나 삭제 직전 참조를 확정할 수 없어요. | 정리를 생략해 진행 중 후보와 현재 정상 참조를 보호해요. |
| 캐시만 실패하고 이미지 게시가 성공해요. | 경고가 남고 workflow와 기존 릴리스 성공 판정은 성공해요. |
| 실제 이미지 빌드·게시가 실패해요. | workflow가 실패하고 release 생성 또는 정상 캐시 갱신으로 넘어가지 않아요. |
| 최종 이미지를 독립적으로 실행해요. | 캐시·target·GitHub 인증 없이 기존 런타임 동작을 제공해요. |

## 검증 방식과 실행 의존성

먼저 Docker의 직접 빌드와 kache 연동을 빈 캐시에서 검증하고, 같은 builder의 Cargo 재사용과 kache 재사용을 구분해 관찰해요.
이후 격리된 로컬 registry와 새 builder를 사용해 실제 snapshot 저장·복원 왕복을 검증해요.
helper의 GitHub Packages 조회·삭제는 상태를 가진 격리 fixture로 검증하고, 일반 registry 왕복이 GHCR 권한·삭제 API 검증까지 대신한다고 주장하지 않아요.

Docker의 일반 RUN 적중이 컴파일 단계를 숨기지 않도록 검증용 컨텍스트에서 필요한 실행 경로를 강제로 통과시켜요.
특히 빈 target·따뜻한 kache 상태에 실제로 도달했는지 확인하고, kache hit 숫자나 `CACHED` 문자열만으로 전체 결과를 판정하지 않아요.
cache 없이 만든 결과와 비교해 변경한 입력의 효과와 migration 적용을 확인해요.

회귀 테스트는 정상 복원, 부분·손상 복원 거부, 게시 실패의 이전 참조 보존, 시간·크기 경계, 삭제 범위, 비치명적 cache 실패와 치명적 build 실패의 구분을 보호해요.
생산자 A의 참조 갱신 직전에 생산자 B의 정리를 끼워 넣는 결정적인 실행 순서로 진행 중 후보의 삭제 방지와 완료 후 승격 금지를 검증해요.
migration 누락과 손상된 snapshot은 검사가 의도한 오류를 실제로 탐지하는지 확인할 구별 사례로 사용해요.
단순 명령 forwarding, source 문자열, 우연한 로그 문구만 고정하는 테스트는 추가하지 않아요.

실제 이미지는 운영 설정이 없는 임시 DB와 격리된 포트에서 기동해 확인해요.
실제 Discord 연결·서버 조작과 운영 DB 읽기·쓰기는 이 검증에 포함하지 않아요.

필수 저장소 검사는 `mise run check`, `mise run test`, `mise run test-release`, 신규 helper 테스트, 프런트엔드의 `npx tsc --noEmit` 후 `npm run build`, gaji workflow 재생성이에요.
기존 release 실패·취소·정확한 실행 식별·자동 재실행 금지 테스트를 약화하지 않아요.
캐시만을 위해 기존 release fixture에 production이 읽지 않는 가짜 job/step 상태를 추가하지 않아요.

성능은 cold build, 같은 소스, 소스 변경, 버전 변경, 의존성 변경에서 컴파일 시간·캐시 반출입 시간·전체 시간·전송 크기를 나눠 기록해요.
동일 입력의 컴파일 감소는 구현이 제공해야 하는 결과지만 전체 시간 절감 폭은 실측 전의 가설이에요.
전송 비용 때문에 전체 시간이 증가하면 그 결과와 원인을 명시하며 성공한 속도 개선으로 표현하지 않아요.

GHCR의 실제 인증·패키지 연결·게시·정리와 GitHub의 최종 workflow conclusion은 승인된 원격 실행에서 확인해요.
로컬 구현과 검증이 끝났다는 사실은 그 원격 실행, push 또는 릴리스를 승인하지 않아요.

## 남은 기술적 확인과 현재 검증 상태

추가로 선택해야 할 저장소 종류나 runner 구조는 없어요.
DBC-01부터 DBC-05까지의 로컬 source 구현은 direct Cargo와 kache, migration 입력 추적, snapshot 전송·receipt·보관, workflow 실패 경계를 포함해 반영되었어요.
helper 회귀 검사 28개와 새 builder를 사용한 작은 실제 snapshot 왕복 integration은 통과했어요.
초기 full application 9-case matrix는 2,048.47초에 통과했고, 복원 case마다 fresh builder를 사용했어요.
동일 입력 복원에서 Rust compiler 실행은 568회에서 0회로, 지원되는 C/C++ compiler 실행은 261회에서 duplicate 2회로 줄었고, Cargo 시간은 144초에서 19.43초로, complete cache flow는 245.30초에서 210.19초로 관측됐어요.
source·version·dependency 변경과 migration add/change/delete의 runtime 출력은 해당 matrix에서 올바르게 반영됐어요.
별도 publication 측정은 71.95초와 71개 표본에서 staging 최대 3,202,596,864 allocated bytes, payload 1,355,005,884 bytes, raw tar 1,359,389,696 bytes, gzip 478,597,365 bytes를 관측했어요.
재귀 `.dockerignore` 수정 뒤 실제 BuildKit context에서는 nested/root dotenv와 SQLite/WAL fixture가 제외되고 example 파일은 유지됐어요.
실제 local fault-boundary run은 1,999.08초에 통과했고 `INVALID_CONFIG`, `INCOMPATIBLE_SNAPSHOT`, `BLOB_DIGEST_MISMATCH`, `BLOB_SIZE_MISMATCH`, `RESPONSE_LIMIT`, `TRANSFER_LIMIT`, `DISK_LIMIT`, `FILE_LIMIT`, `REGISTRY_TIMEOUT`의 9개 restore 거부 mode마다 mount가 비었음을 확인한 뒤 해당 cold application과 input·migration 출력을 검증했어요.
injection과 clear가 함께 실패한 `RESTORE_CLEAR_FAILED`에서는 원래 sentinel만 남고 별도의 fallback mount는 완전히 비었으며 해당 cold application과 출력도 통과했어요.
이 검사에서 모든 fixed ref는 변하지 않았고, 실제 compiler error와 image manifest `503`은 publication을 건너뛰었으며 cache exporter `503`과 snapshot `PUBLISH_FAILED`·`REGISTRY_STATUS`는 usable image를 유지했어요.
정확한 `mode=max,ignore-error=true` 경로는 intentional `503` 31회에서 13.09초에 통과했고 network-none application의 input·migration probe도 통과했어요.
이로써 DBC-01부터 DBC-05까지의 로컬 구현과 검증은 완료했어요.
검증용 registry·proxy·runtime과 두 builder를 종료·제거했고, 기록된 로컬 이미지 23개와 임시 스크립트·snapshot·다운로드 파일도 정리했어요.

추가 성능 개선으로 `extractTarToDirectory`에서 임시 파일마다 수행하던 `fsync`를 제거했어요.
쓰기·닫기 대기와 tar·digest·경로·자원 상한 검증은 유지하며, 임시 staging의 crash durability나 지연된 writeback 오류의 보고 시점이 같다고 보장하지 않아요.
디스크 기반 staging과 동일 snapshot·일반 레이어를 사용한 전체 앱 비교에서 합계는 153.13초에서 93.06초로, 순서를 반전한 비교에서는 152.25초에서 95.48초로 줄었어요.
기존 matrix와 직접 섞지 않은 비교 조건, 실패 검증과 동일 이미지 digest는 [추가 성능 개선 기록](docker-build-cache-tickets.md#추가-성능-개선)에 남겼어요.

추가 전송 조정으로 주입의 COPY 레이어를 readonly bind mount로 대체하고 gzip 경로의 버퍼를 `1 MiB`로 맞췄어요.
cache mount 루트 `0755`와 내부 권한은 보존하며, 버퍼 조정에는 fixture 기준 약 30–50 MiB의 최대 RSS 증가가 있어요.
파일별 `fsync` 제거가 이미 적용된 기준선과 비교해 restore·publish 합계가 약 6.3–6.7초 줄었어요.
전체 앱의 두 비교는 93.52→89.79초와 96.42→87.74초였으며 빌드 구간 변동·동일 runtime manifest·실패 검증은 [전송 경로 추가 조정](docker-build-cache-tickets.md#전송-경로-추가-조정)에 구분해 기록했어요.

GHCR의 실제 인증·패키지 연결·게시·정리와 GitHub의 최종 workflow conclusion은 여전히 승인된 원격 실행에서만 확인할 수 있으므로 DBC-06이 유일한 원격 권한·검증 blocker예요.

## 외부 근거

- [Docker cache mount 계약](https://docs.docker.com/reference/dockerfile/#run---mounttypecache)은 mount의 수명·ID·공유와 빈 캐시에서도 동작해야 하는 요구를 설명해요.
- [Docker GHA cache](https://docs.docker.com/build/cache/backends/gha/)와 [GitHub cache 접근 제한](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)은 태그별 접근 경계를 설명해요.
- [BuildKit cache mount exporter 설명](https://github.com/moby/buildkit/issues/3011)과 [cache-dance CLI](https://github.com/reproducible-containers/buildkit-cache-dance#cli-usage)는 mount의 별도 반출입 필요성과 명시적 추출 경로를 뒷받침해요.
- [Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html)는 Cargo 산출물과 compiler wrapper의 역할을 구분해요.
- [kache v0.20.0 설정](https://github.com/kunobi-ninja/kache/blob/v0.20.0/docs/getting-started/configuration.mdx)과 [입력 키](https://github.com/kunobi-ninja/kache/blob/v0.20.0/docs/how-it-works/cache-key.mdx)는 저장소·실행 정책과 숨은 입력 계약의 기준이에요.
- [SQLx 0.8.6 migrate 매크로](https://docs.rs/sqlx/0.8.6/sqlx/macro.migrate.html#triggering-recompilation-on-migration-changes)는 새 migration 파일의 재컴파일 조건을 설명해요.
- [GHCR Container registry 계약](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)은 OCI 지원, `GITHUB_TOKEN` 기반 workflow 인증, package admin이 필요한 preview 삭제·복원 API, 레이어당 10 GB와 upload 10분 제한을 설명해요.
- [GHCR 요금 정책](https://docs.github.com/en/billing/concepts/product-billing/github-packages#free-use-of-github-packages)은 작성 시점의 컨테이너 이미지 저장·대역폭 무료 정책이며 영구적인 비용 보장은 아니에요.
- [Docker bind mount 최적화](https://docs.docker.com/build/cache/optimize/#use-bind-mounts)는 임시 입력을 readonly로 제공하면서 불필요한 COPY 레이어를 피하는 방법을 설명해요.
- [Node.js zlib 메모리 조정](https://nodejs.org/docs/latest-v24.x/api/zlib.html#memory-usage-tuning)은 기본 output slab 크기와 호출 수·메모리·성능의 교환 관계를 설명해요.
