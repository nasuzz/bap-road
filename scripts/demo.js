// 발표 시나리오 ①~⑤를 로컬 Hardhat 네트워크에서 실행하고 시점별 잔액표를 출력해요.
// 실행: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");

async function main() {
  const [owner, student, restaurant, cafe] = await ethers.getSigners();
  const tkrw = await ethers.deployContract("TKRW");
  const bgp = await ethers.deployContract("BabgilPoint", [await tkrw.getAddress()]);
  const bgpAddr = await bgp.getAddress();

  await (await bgp.addStore(restaurant.address, "학생식당", 500)).wait();
  await (await bgp.addStore(cafe.address, "교내카페", 0)).wait();
  await (await tkrw.connect(student).faucet()).wait();

  const rows = [];
  const record = async (label) => {
    rows.push({
      시점: label,
      "학생 BGP": Number(await bgp.balanceOf(student.address)),
      포인트: Number(await bgp.pointBalanceOf(student.address)),
      "보관 tKRW": Number(await bgp.reserveBalance()),
      "필요 재원": Number(await bgp.requiredReserve()),
      "식당 순수령": Number(await tkrw.balanceOf(restaurant.address)),
      "카페 수령": Number(await tkrw.balanceOf(cafe.address)),
    });
  };

  // ① 충전
  await (await tkrw.connect(student).approve(bgpAddr, 10_000)).wait();
  await (await bgp.connect(student).deposit(10_000)).wait();
  await record("① 충전 직후");

  // ② 식당 결제
  await (await bgp.connect(restaurant).createOrder(student.address, 6_000, 600)).wait();
  await (await bgp.connect(student).pay(1, 0)).wait();
  await record("② 식당 결제");

  // ③ 포인트 적립
  await (await tkrw.connect(restaurant).approve(bgpAddr, 300)).wait();
  await (await bgp.connect(restaurant).awardPoints(1)).wait();
  await record("③ 포인트 적립");

  // ④ 카페 혼합 결제 (포인트 전액 + 부족분 BGP)
  await (await bgp.connect(cafe).createOrder(student.address, 3_000, 600)).wait();
  const pts = await bgp.pointBalanceOf(student.address);
  const order = await bgp.getOrder(2);
  const usePoints = pts < order.amount ? pts : order.amount; // "포인트 전액 사용" 버튼 계산
  await (await bgp.connect(student).pay(2, usePoints)).wait();
  await record("④ 카페 결제");

  console.table(rows);
  console.log("⑤ 재원 충분 여부(isFullyBacked):", await bgp.isFullyBacked());

  // 막히는 장면 예시: 같은 주문 재결제
  try {
    await bgp.connect(student).pay(2, 0);
  } catch (e) {
    console.log("중복 결제 시도 → 거절:", e.revert?.name ?? e.shortMessage ?? e.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
