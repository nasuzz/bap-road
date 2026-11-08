# Sepolia 배포 기록

| 항목 | 값 |
|---|---|
| 네트워크 | Sepolia (chainId 11155111) |
| TKRW | [`0x8645F7b1465DC39186209b57162c7F14BF0a24b3`](https://sepolia.etherscan.io/address/0x8645F7b1465DC39186209b57162c7F14BF0a24b3) |
| BabgilPoint (BGP) | [`0x4204a19535B63c95B6E635f9525C21A36C42714E`](https://sepolia.etherscan.io/address/0x4204a19535B63c95B6E635f9525C21A36C42714E) |
| BabgilPoint 배포 블록 / 거래 | 12088451 / [`0x7ec98b51…8f29`](https://sepolia.etherscan.io/tx/0x7ec98b514d7834678899c6a486901f61f3089791777e6f4a9431a45478ae8f29) |
| 컴파일러 | Remix, solc 0.8.24 |

## 계정

| 역할 | 주소 |
|---|---|
| 운영자 (owner) | `0x9275a30A72E0d3DA391e2956aA9b778f5117c8C6` |
| 학생 | `0xB56f978082d29D0A722cCA7894fA181dB51Eca25` |
| 학생식당 (적립률 5%) | `0x142DAEb09bdC4de45bC64835002AA11E4C5bD85A` |
| 교내카페 (적립률 0%) | `0x6CAf43E1c96c2016019e6fD210d0B82896338913` |

## 시나리오 결과 (온체인 조회로 확인)

| 시점 | 학생 BGP | 포인트 | 보관 tKRW | 식당 순수령 | 카페 수령 |
|---|---:|---:|---:|---:|---:|
| ① 충전 직후 | 10,000 | 0 | 10,000 | 0 | 0 |
| ② 식당 결제 | 4,000 | 0 | 4,000 | 6,000 | 0 |
| ③ 포인트 적립 | 4,000 | 300 | 4,300 | 5,700 | 0 |
| ④ 카페 결제 | **1,300** | **0** | **1,300** | **5,700** | **3,000** |

⑤ 최종: BGP 총공급 1,300 + 미사용 포인트 0 = 필요 재원 1,300, 보관 tKRW 1,300, `isFullyBacked() = true`.
발표 구성안 2쪽의 표와 일치해요.

| 주문 | 매장 | 금액 | BGP 사용 | 포인트 사용 | 적립 |
|---|---|---:|---:|---:|---:|
| #1 | 학생식당 | 6,000 | 6,000 | 0 | 300 |
| #2 | 교내카페 | 3,000 | 2,700 | 300 | 0 |

## 거래 기록

| 블록 | 내용 | 거래 |
|---|---|---|
| 12088451 | BabgilPoint 배포 | [`0x7ec98b51…8f29`](https://sepolia.etherscan.io/tx/0x7ec98b514d7834678899c6a486901f61f3089791777e6f4a9431a45478ae8f29) |
| 12088467 | 매장 등록 · 학생식당 (5%) | [`0x62e2561b…3846`](https://sepolia.etherscan.io/tx/0x62e2561b71fd9c3b06e60d8af4c7515f1cac5f7069a7613ebf61d253bdba3846) |
| 12088473 | 매장 등록 · 교내카페 (0%) | [`0xeecd39b4…68c7`](https://sepolia.etherscan.io/tx/0xeecd39b49d1ed7f7ca0fdd1892a410f2dd34ea13ba427c08265db0682df768c7) |
| 12088496 | ① 충전 10,000 tKRW → 10,000 BGP | [`0xd8d615b1…fcbe`](https://sepolia.etherscan.io/tx/0xd8d615b13174ffdd02b838a926b3e2426d11a4648fbcdfbf4bd0bc124132fcbe) |
| 12088547 | 주문 #1 등록 · 학생식당 6,000 | [`0xdc885e83…c1c6`](https://sepolia.etherscan.io/tx/0xdc885e833d21487bf3cf8196649e9af2661b2327f8184cc6d7a1a91dbf78c1c6) |
| 12088549 | ② 주문 #1 결제 · BGP 6,000 → 식당 6,000 tKRW | [`0xa678fe34…967a`](https://sepolia.etherscan.io/tx/0xa678fe34845e1879d160af6ba50e6963191dde816a07a0300a8feee7b6b1967a) |
| 12088559 | ③ 주문 #1 적립 · 식당 300 tKRW 부담 → 300점 | [`0xe84d087d…1d23`](https://sepolia.etherscan.io/tx/0xe84d087d6c145ba094e43a7a446c415ec02c078411f79b5774f9f8ec3f771d23) |
| 12088564 | 주문 #2 등록 · 교내카페 3,000 | [`0x709c8de8…44ac`](https://sepolia.etherscan.io/tx/0x709c8de8e7be51c0c7bfd2a7c26c651d572e816b37e97af21aa6d44ec9b444ac) |
| 12088566 | **④ 주문 #2 결제 · 포인트 300 + BGP 2,700 → 카페 3,000 tKRW (한 거래)** | [`0x3b661adb…3da6`](https://sepolia.etherscan.io/tx/0x3b661adb031730bc939236c08f5a058478ce06048d088e999bf7924b609f3da6) |

## 진행 상황

- [x] TKRW, BabgilPoint 배포
- [x] 매장 등록 (학생식당 500, 교내카페 0)
- [x] ① 학생 충전
- [x] ② 식당 주문 결제
- [x] ③ 포인트 적립
- [x] ④ 카페 혼합 결제
- [x] ⑤ 전체 현황 확인
- [ ] 막히는 장면 시연 (중복 결제, 잔액 초과 등)
- [ ] Etherscan 컨트랙트 코드 공개 (verify)
- [ ] 시연 녹화
