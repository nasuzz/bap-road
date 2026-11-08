# 밥길 포인트 (bap-road)

교내 식당 / 카페에서 토큰(BGP)으로 결제하고, 포인트를 적립해 다른 참여 매장에서도 쓰는 서비스의 스마트 컨트랙트예요.
컨트랙트가 결제 재원(tKRW)을 보관하고, 주문 금액을 사용 매장에 지급해요.

## 구성

| 파일 | 역할 |
|---|---|
| `contracts/TKRW.sol` | 시연용 테스트 원화 ERC-20 (`faucet()`으로 50,000 지급, 소수점 0) |
| `contracts/BabgilPoint.sol` | BGP 결제 토큰(ERC-20) + 적립 포인트 잔액 + 주문 / 결제 / 적립 / 환불 / 반환 |
| `contracts/mocks/FailingToken.sol` | 테스트 전용. 전송 실패를 일으키는 모의 토큰 |
| `test/BabgilPoint.test.js` | 발표 시나리오 + 막히는 장면 + 환불 + 전송 실패 테스트 |
| `scripts/demo.js` | 로컬에서 시나리오 ①~⑤를 실행하고 잔액표 출력 |
| `web/` | 메타마스크로 연결하는 시연 웹 (학생 / 매장 / 전체 현황) |

## 컨트랙트 함수

| 함수 | 호출자 | 설명 |
|---|---|---|
| `addStore(store, name, rewardBps)` | 운영자 | 참여 매장 등록 (`500` = 5%, 상한 20%) |
| `deposit(amount)` | 학생 | tKRW 예치 → 같은 수량 BGP 발행. 사전 `tkrw.approve` 필요 |
| `createOrder(buyer, amount, duration)` | 등록 매장 | 구매자 / 금액 / 만료(초, 최대 1일) 확정 |
| `pay(orderId, pointsToUse)` | 지정 학생 | 포인트 차감 + 부족분 BGP 소각 + 매장 지급 + 상태 갱신 (한 거래) |
| `awardPoints(orderId)` | 해당 매장 | 매장이 tKRW 재원 예치 후 1회 적립. 사전 `tkrw.approve` 필요 |
| `refund(orderId)` | 해당 매장 | 매장이 주문액 tKRW 반환 → 사용 BGP / 포인트 복구 (적립된 주문 제외) |
| `redeem(amount)` | BGP 보유자 | BGP 소각 → 같은 수량 tKRW 반환 |
| `pointBalanceOf`, `getOrder`, `getStores`, `rewardFor`, `requiredReserve`, `reserveBalance`, `isFullyBacked` | 누구나 | 조회 |

**불변식:** `보관 tKRW ≥ BGP 총공급 + 미사용 포인트`. 운영자에게는 임의 발행 / 재원 인출 / 업그레이드 권한이 없어요.

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
6. 학생: `tkrw.faucet()` → `tkrw.approve(BabgilPoint주소, 10000)` → `deposit(10000)`
7. 식당: `createOrder(학생주소, 6000, 600)` → 학생: `pay(1, 0)`
8. 식당: `tkrw.approve(BabgilPoint주소, 300)` → `awardPoints(1)`
9. 카페: `createOrder(학생주소, 3000, 600)` → 학생: `pay(2, 300)`
10. `requiredReserve()`, `reserveBalance()`, `isFullyBacked()`로 확인하고, 거래 해시를 Sepolia Etherscan에서 확인해요.

메타마스크에 BGP / tKRW 토큰을 "토큰 가져오기"로 추가하면 잔액이 보여요 (소수점 0). 포인트는 ERC-20이 아니라서 웹 / `pointBalanceOf`로 확인해요.

## 웹 화면 실행

1. `web/config.js`에 배포한 `tkrw`, `babgil` 주소와 `deployBlock`을 넣어요. (현재 Sepolia 배포 주소가 들어 있어요)
2. `npm run web` → 브라우저에서 http://localhost:5173 접속
3. 지갑 없이도 **전체 현황**(돈의 흐름, 지급 재원, 매장 정산, 온체인 기록)은 바로 보여요.
4. **지갑 연결**을 누르면 계정 역할(학생 / 매장 / 운영자)에 맞는 화면이 자동으로 열려요. 메타마스크 계정을 바꾸면 화면도 바뀌어요.

| 화면 | 할 수 있는 것 |
|---|---|
| 학생 | 결제 가능 금액(BGP + 포인트) 카드, 충전 / 반환, 결제 요청 카드(포인트 먼저 쓰기, 포인트와 BGP 비율 막대, 남은 시간), 이용 내역 |
| 매장 | 정산 수령액, 새 주문(구매자 선택, 금액 / 시간 빠른 선택), 결제 대기 · 적립 필요 · 완료 보드, 적립 / 환불 |
| 전체 현황 | 학생 → 컨트랙트 → 매장 흐름, 필요 재원 vs 보관 tKRW 게이지, 참여 매장, 온체인 타임라인, 발표 증거용 거래 해시 |

**보기 전용 모드:** `http://localhost:5173/?as=0x주소`로 열면 그 계정의 화면을 서명 없이 보여줘요. 발표 화면에 학생 / 매장 화면을 띄울 때 편해요.

컨트랙트를 수정했다면 `npm run abi`로 `web/abi.js`를 다시 만들어요.

## 테스트 범위

- 발표 시나리오 ①~⑤ 잔액표 (문서 2쪽 표와 일치하는지 검증)
- 중복 결제 / 적립, 미등록 매장, 다른 구매자, 다른 매장의 적립 / 환불
- 재원 없는 발행 / 적립, 잔액 초과 결제, 포인트 초과 사용, 만료 주문
- 카페 주문 환불, 승인 부족 시 환불 실패, 적립된 주문 환불 거절
- 매장 지급 전송 실패 시 전체 롤백 (모의 토큰)
