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

## 진행 상황

- [x] TKRW, BabgilPoint 배포
- [x] 매장 등록 (학생식당 500, 교내카페 0)
- [x] ① 학생 충전 10,000 tKRW → 10,000 BGP (온체인 조회로 확인: BGP 10,000 / 보관 10,000)
- [ ] ② 식당 주문 결제 6,000
- [ ] ③ 포인트 적립 300
- [ ] ④ 카페 혼합 결제 300점 + 2,700 BGP
- [ ] ⑤ 전체 현황 확인
- [ ] 막히는 장면 시연 (중복 결제, 잔액 초과 등)
