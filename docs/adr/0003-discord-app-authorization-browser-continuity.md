# Discord 앱 승인과 원래 브라우저의 로그인 연속성

## 결정

이번 인터뷰의 목표는 Android, iPhone·iPad, PC에서 설치된 Discord 앱의 권한 승인 화면을 사용하는 Discord 앱 승인(Discord app authorization)이에요.
웹에서 계정을 다시 입력하는 횟수를 줄이는 것만으로 목표를 대체하지 않아요.
비공식 전환 경로도 가능성과 한계를 조사하지만, 동작한다고 가정하거나 바로 적용하지 않아요.

앱에서 승인한 뒤에는 처음 azuki를 열었던 브라우저에서 로그인이 완료돼야 해요.
다른 브라우저에만 로그인 상태를 만드는 것으로는 충족하지 않아요.
이 조건을 충족하지 못하는 앱 전환은 지원하지 않고 기존 웹 로그인 경로를 남겨요.

사용자는 우선 인증 시작 주소만 공식 `https://discord.com/oauth2/authorize`로 갱신하고 가능한 검증을 진행하기로 선택했어요.
기존 매개변수와 쿠키 검증은 유지하며, 실기기로 확인하지 못한 앱 전환은 미검증으로 남겨요.
이번 구현 범위에는 비공식 딥 링크, 별도 네이티브 앱, 인증 결과의 브라우저 간 전달을 포함하지 않아요.

## 이유와 현재 근거

현재 `crates/azuki-web/src/auth.rs`의 `login`은 `response_type=code`, `scope=identify`로 Discord OAuth를 시작하고, 시작한 브라우저에 `oauth_state` 쿠키를 저장해요.
`callback`은 이 쿠키와 반환된 `state`를 검증하며, 쿠키가 없으면 `/auth/login`으로 돌려보내요.
따라서 Discord 앱을 여는 것, 앱에서 권한 승인을 받는 것, 원래 브라우저의 azuki 로그인을 완료하는 것은 각각 확인해야 하는 단계예요.
앱이 실행된 사실만으로 로그인 성공을 판단하지 않아요.

[Discord 유지관리자의 2024년 설명](https://github.com/discord/discord-api-docs/discussions/7259#discussioncomment-11180541)은 사용자 계정 접근용 OAuth를 모바일 앱으로 넘기지 않는 이유로 원래 브라우저·탭과 쿠키 상태로 복귀하기 어렵다는 점을 들어요.
이는 봇이나 앱을 추가하는 설치 흐름과 구분돼요.
2026-09-13에 확인한 [Discord의 iOS 앱 링크 설정](https://discord.com/.well-known/apple-app-site-association)도 `/oauth2/authorize`에 비어 있지 않은 `response_type`이 있으면 앱 전환에서 제외해요.

[공식 모바일 Social SDK 인증](https://docs.discord.com/developers/discord-social-sdk/development-guides/account-linking-on-mobile)은 네이티브 앱, 앱별 콜백 URI, PKCE를 사용하는 별도 흐름이에요.
azuki 웹 로그인 링크를 바꾸는 것만으로 이 흐름을 사용할 수 있다고 판단하지 않아요.

검토 시작 시점의 코드는 `https://discord.com/api/oauth2/authorize`를 사용했지만, [공식 OAuth2 문서](https://docs.discord.com/developers/topics/oauth2)는 `https://discord.com/oauth2/authorize`를 안내해요.
사용자는 이 이전 주소가 웹에서 열리는 원인일 수 있다는 가설을 제시했어요.
2026-09-13에 동일한 비인증용 시험 매개변수로 HTTP GET을 비교했을 때, `/api/oauth2/authorize`는 쿼리를 유지한 채 `/oauth2/authorize`로 302 응답을 보냈고 공식 주소는 직접 200 HTML 응답을 보냈어요.
이 비교는 `client_id=0`과 `https://example.invalid/auth/callback`을 사용한 경로 확인이며, 유효한 azuki 인증이나 운영체제의 앱 전환을 검증한 것은 아니에요.
공식 주소 직접 사용은 추가 리다이렉트를 제거하지만, 그 차이가 앱 승인 동작을 바꾸는지는 별도로 확인해야 해요.
앞서 확인한 iOS의 `response_type` 제외 규칙은 공식 주소에도 적용돼요.

## 확인 한계

문서와 공개 링크 설정 및 현재 코드를 조사하고 두 인증 주소의 HTTP 응답을 비교했으며, 실제 Discord 앱에서 인증하거나 기기별 왕복 로그인을 실행하지는 않았어요.
Android와 PC의 비공식 URI가 권한 승인과 원래 브라우저 복귀까지 지원하는지는 확인되지 않았어요.
iOS의 공식 HTTPS 앱 전환 제외와 모든 비공식 방식의 기술적 불가능을 같은 주장으로 취급하지 않아요.
현재 근거만으로 전 환경의 앱 승인을 지원한다고 약속하지 않아요.

기존 [로그인 유지(Login persistence)와 전체 로그아웃(Global logout) 정책](0001-persistent-login-and-global-logout.md)은 이번 결정으로 변경하지 않아요.
