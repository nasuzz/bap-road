# 밥길 포인트 (bap-road)

교내 식당 / 카페에서 메뉴를 골라 토큰(BGP)과 포인트로 결제하고, 포인트를 적립해 다른 참여 매장에서도 쓰는 서비스의 스마트 컨트랙트예요.

주문 흐름은 배달앱과 같아요.

1. 매장이 메뉴와 가격을 컨트랙트에 등록해요.
2. 학생이 메뉴를 골라 주문하면, 컨트랙트가 메뉴 가격으로 금액을 계산하고 결제한 BGP와 포인트를 금고에 잡아둬요.
3. 매장이 **접수**하면 금고에서 매장으로 tKRW를 지급하고, **거절**하거나 **30분 안에 접수하지 않으면** 학생에게 그대로 돌려줘요.
4. 적립은 **BGP로 결제한 금액** 기준이에요. 포인트로 낸 금액에는 다시 적립하지 않아요.

## 구성

| 파일 | 역할 |
|---|---|
| `contracts/TKRW.sol` | 시연용 테스트 원화 ERC-20 (`faucet()`으로 50,000 지급, 소수점 0) |
| `contracts/BabgilPoint.sol` | BGP 결제 토큰(ERC-20) + 적립 포인트 잔액 + 메뉴 / 주문·결제 / 접수·거절 / 적립 / 환불 / 반환 |
| `contracts/mocks/FailingToken.sol` | 테스트 전용. 전송 실패를 일으키는 모의 토큰 |
| `test/BabgilPoint.test.js` | 발표 시나리오 + 접수·거절·취소 + 메뉴 + 막히는 장면 + 환불 + 전송 실패 테스트 |
| `scripts/demo.js` | 로컬에서 시나리오 ①~⑤를 실행하고 잔액표 출력 |
| `web/` | 메타마스크로 연결하는 시연 웹 (학생 / 매장 / 전체 현황) |

## 컨트랙트 함수

| 함수 | 호출자 | 설명 |
|---|---|---|
| `addStore(store, name, rewardBps)` | 운영자 | 참여 매장 등록 (`500` = 5%, 상한 20%) |
| `deposit(amount)` | 학생 | tKRW 예치 → 같은 수량 BGP 발행. 사전 `tkrw.approve` 필요 |
| `addMenuItem(name, price)` | 등록 매장 | 메뉴 추가 (메뉴 번호는 0부터, 매장당 50개까지) |
| `updateMenuItem(itemId, price, available)` | 등록 매장 | 가격 변경 / 판매 중지·재개. 이미 들어온 주문 금액은 그대로 |
| `placeOrder(store, itemIds, quantities, pointsToUse)` | 학생 | 메뉴 가격으로 금액 계산 → 포인트 + 나머지 BGP로 결제, 매장 접수 전까지 금고에 잡아둠 (BGP 승인 불필요) |
| `acceptOrder(orderId)` | 해당 매장 | 접수 (주문 후 30분 이내). 잡아둔 BGP 소각 + 포인트 차감 + 주문 금액 전액 매장 지급 (한 거래) |
| `rejectOrder(orderId)` | 해당 매장 | 거절. 잡아둔 BGP / 포인트를 학생에게 그대로 돌려줌 |
| `cancelOrder(orderId)` | 학생 (시간 초과 후 누구나) | 접수 전 취소. 잡아둔 BGP / 포인트를 학생에게 돌려줌 |
| `awardPoints(orderId)` | 해당 매장 | 접수한 주문에 BGP 결제액 × 적립률만큼 1회 적립. 매장이 같은 양의 tKRW를 금고에 넣음. 사전 `tkrw.approve` 필요 |
| `refund(orderId)` | 해당 매장 | 접수 후 환불. 매장이 주문액 tKRW 반환 → 사용 BGP / 포인트 복구 (적립된 주문 제외) |
| `redeem(amount)` | BGP 보유자 | BGP 소각 → 같은 수량 tKRW 반환 |
| `getMenu`, `getOrder`, `getOrderLines`, `getStores`, `pointBalanceOf`, `rewardFor`, `requiredReserve`, `reserveBalance`, `isFullyBacked` | 누구나 | 조회 |

**주문 상태:** `Placed`(접수 대기) → `Accepted`(접수·정산) / `Rejected`(거절) / `Cancelled`(취소·시간 초과), `Accepted` → `Refunded`(환불)

**불변식:** `금고 tKRW ≥ BGP 총공급 + 전체 포인트(접수 대기 주문에 잡아둔 포인트 포함)`. 운영자에게는 임의 발행 / 금고 인출 / 업그레이드 권한이 없어요.

## 로컬 실행

```bash
npm install
npm test                          # 테스트 실행
npx hardhat run scripts/demo.js   # 시나리오 잔액표 출력
```

## Remix + Sepolia 배포 순서

1. 메타마스크에 계정 4개(운영자 / 학생 / 식당 / 카페)를 준비하고 각각 Sepolia 테스트 ETH를 받아요.
2. Remix에 `TKRW.sol`, `BabgilPoint.sol`을 붙여넣어요. `@openzeppelin/...` import는 Remix가 자동으로 불러와요.
3. 컴파일러 `0.8.24`, Optimization 200으로 컴파일해요.
4. Deploy & Run에서 환경을 **Injected Provider - MetaMask**(Sepolia)로 고르고, 운영자 계정으로 배포해요.
   - `TKRW` 배포
   - `BabgilPoint` 배포 (생성자 인자: TKRW 주소)
5. 운영자: `addStore(식당주소, "학생식당", 500)`, `addStore(카페주소, "교내카페", 0)`
6. 식당: `addMenuItem("제육덮밥", 6000)` / 카페: `addMenuItem("아메리카노", 3000)` (웹 매장 화면의 **메뉴 관리**에서도 할 수 있어요)
7. 학생: `tkrw.faucet()` → `tkrw.approve(BabgilPoint주소, 10000)` → `deposit(10000)`
8. 학생: `placeOrder(식당주소, [0], [1], 0)` → 식당: `acceptOrder(1)`
9. 식당: `tkrw.approve(BabgilPoint주소, 300)` → `awardPoints(1)`
10. 학생: `placeOrder(카페주소, [0], [1], 300)` → 카페: `acceptOrder(2)`
11. `requiredReserve()`, `reserveBalance()`, `isFullyBacked()`로 확인하고, 거래 해시를 Sepolia Etherscan에서 확인해요.

Remix에서 배열 인자는 `[0]`, `[1]`처럼 대괄호로 입력해요.

메타마스크에 BGP / tKRW 토큰을 "토큰 가져오기"로 추가하면 잔액이 보여요 (소수점 0). 포인트는 ERC-20이 아니라서 웹 / `pointBalanceOf`로 확인해요.

## 웹 화면 실행

**온라인 주소: https://nasuzz.github.io/bap-road/** (main에 `web/` 변경을 push하면 GitHub Actions가 자동으로 다시 배포해요)

로컬에서 띄우려면:

1. `web/config.js`에 배포한 `tkrw`, `babgil` 주소와 `deployBlock`을 넣어요. (현재 Sepolia 배포 주소가 들어 있어요)
2. `npm run web` → 브라우저에서 http://localhost:5173 접속
3. 지갑 없이도 **전체 현황**(돈의 흐름, 금고 잔액, 매장 정산, 온체인 기록)은 바로 보여요.
4. **지갑 연결**을 누르면 계정 역할(학생 / 매장 / 운영자)에 맞는 화면이 자동으로 열려요. 메타마스크 계정을 바꾸면 화면도 바뀌어요.

| 화면 | 할 수 있는 것 |
|---|---|
| 학생 | 결제 가능 금액(BGP + 포인트) 카드, 충전 / 반환, 매장·메뉴 고르기와 장바구니(포인트 먼저 쓰기, 포인트와 BGP 비율 막대, 예상 적립), 접수 대기 주문(남은 시간, 취소), 이용 내역 |
| 매장 | 정산 수령액, 메뉴 관리(추가 / 가격 변경 / 판매 중지), 접수 대기 · 적립 필요 · 완료 보드, 접수 / 거절 / 적립 / 환불 |
| 전체 현황 | 학생 → 컨트랙트 → 매장 흐름, 내줘야 할 돈 vs 금고 잔액 게이지, 참여 매장, 온체인 타임라인, 발표 증거용 거래 해시 |

**보기 전용 모드:** `http://localhost:5173/?as=0x주소`로 열면 그 계정의 화면을 서명 없이 보여줘요. 발표 화면에 학생 / 매장 화면을 띄울 때 편해요.

**메뉴 사진:** 사진을 `web/img/menu/`에 넣고 `web/config.js`의 `menuImages`에 `매장 주소 → { "메뉴 이름": "img/menu/파일.jpg" }`로 적어요. 메뉴 이름은 컨트랙트에 등록한 이름과 똑같아야 해요. 사진이 없는 메뉴는 기본 아이콘이 나와요.

컨트랙트를 수정했다면 `npm run abi`로 `web/abi.js`를 다시 만들어요.

## 테스트 범위

- 발표 시나리오 ①~⑤ 잔액표 (문서 2쪽 표와 일치하는지 검증), 여러 메뉴·수량 금액 계산, 주문 시점 가격 고정
- 적립 기준(BGP 결제분만), 포인트 사용 한도
- 매장 거절 / 학생 취소 / 접수 시간 초과 시 BGP·포인트 반환, 처리된 주문 재처리 거절
- 메뉴 권한·입력 검증, 판매 중지 메뉴 주문 거절, 메뉴 개수 상한
- 미등록 매장, 빈 주문, 없는 메뉴, 수량 범위, 잔액 초과, 포인트 초과
- 중복 적립, 적립 없는 주문, 승인 부족 시 적립 실패, 카페 주문 환불, 적립된 주문 환불 거절
- 운영자 권한, tKRW 없는 발행, 컨트랙트로 직접 보낸 BGP
- 매장 지급 / 반환 전송 실패 시 전체 롤백 (모의 토큰)
