const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const RESTAURANT_BPS = 500; // 5%
const CAFE_BPS = 0;
const TEN_MIN = 600;

const Status = { None: 0n, Created: 1n, Paid: 2n, Refunded: 3n };

async function deployFixture() {
  const [owner, student, restaurant, cafe, other] = await ethers.getSigners();

  const tkrw = await ethers.deployContract("TKRW");
  const bgp = await ethers.deployContract("BabgilPoint", [await tkrw.getAddress()]);
  const bgpAddr = await bgp.getAddress();

  await bgp.addStore(restaurant.address, "학생식당", RESTAURANT_BPS);
  await bgp.addStore(cafe.address, "교내카페", CAFE_BPS);

  await tkrw.connect(student).faucet();

  return { tkrw, bgp, bgpAddr, owner, student, restaurant, cafe, other };
}

/** 학생이 10,000 tKRW를 충전한 상태 */
async function chargedFixture() {
  const f = await deployFixture();
  await f.tkrw.connect(f.student).approve(f.bgpAddr, 10_000);
  await f.bgp.connect(f.student).deposit(10_000);
  return f;
}

/** 발표 시나리오 ①~④를 모두 마친 상태 */
async function scenarioFixture() {
  const f = await chargedFixture();
  const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = f;

  await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN); // order 1
  await bgp.connect(student).pay(1, 0);
  await tkrw.connect(restaurant).approve(bgpAddr, 300);
  await bgp.connect(restaurant).awardPoints(1);

  await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN); // order 2
  await bgp.connect(student).pay(2, 300);
  return f;
}

async function snapshot({ tkrw, bgp, student, restaurant, cafe }) {
  return {
    studentBgp: await bgp.balanceOf(student.address),
    studentPoints: await bgp.pointBalanceOf(student.address),
    reserve: await bgp.reserveBalance(),
    restaurantTkrw: await tkrw.balanceOf(restaurant.address),
    cafeTkrw: await tkrw.balanceOf(cafe.address),
  };
}

async function expectBacked(bgp) {
  expect(await bgp.reserveBalance()).to.be.gte(await bgp.requiredReserve());
  expect(await bgp.isFullyBacked()).to.equal(true);
}

describe("BabgilPoint - 발표 시나리오 (정상 흐름)", function () {
  it("① 충전 → ② 식당 결제 → ③ 포인트 적립 → ④ 카페 혼합 결제 잔액표가 문서와 일치한다", async function () {
    const f = await loadFixture(deployFixture);
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = f;

    // ① 충전 10,000 tKRW → 10,000 BGP
    await tkrw.connect(student).approve(bgpAddr, 10_000);
    await expect(bgp.connect(student).deposit(10_000))
      .to.emit(bgp, "Deposited").withArgs(student.address, 10_000);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 10_000n, studentPoints: 0n, reserve: 10_000n, restaurantTkrw: 0n, cafeTkrw: 0n,
    });
    await expectBacked(bgp);

    // ② 식당 결제 6,000 BGP → 식당 6,000 tKRW
    await expect(bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN))
      .to.emit(bgp, "OrderCreated");
    await expect(bgp.connect(student).pay(1, 0))
      .to.emit(bgp, "OrderPaid").withArgs(1, student.address, restaurant.address, 6_000, 0);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 4_000n, studentPoints: 0n, reserve: 4_000n, restaurantTkrw: 6_000n, cafeTkrw: 0n,
    });
    await expectBacked(bgp);

    // ③ 포인트 적립: 식당이 300 tKRW 부담 → 300점
    expect(await bgp.rewardFor(1)).to.equal(300);
    await tkrw.connect(restaurant).approve(bgpAddr, 300);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.emit(bgp, "PointsAwarded").withArgs(1, student.address, restaurant.address, 300);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 4_000n, studentPoints: 300n, reserve: 4_300n, restaurantTkrw: 5_700n, cafeTkrw: 0n,
    });
    await expectBacked(bgp);

    // ④ 카페 혼합 결제: 300점 + 2,700 BGP → 카페 3,000 tKRW
    await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN);
    await expect(bgp.connect(student).pay(2, 300))
      .to.emit(bgp, "OrderPaid").withArgs(2, student.address, cafe.address, 2_700, 300);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 1_300n, studentPoints: 0n, reserve: 1_300n, restaurantTkrw: 5_700n, cafeTkrw: 3_000n,
    });

    // ⑤ 전체 현황: 필요 재원 = BGP 공급 1,300 + 포인트 0 = 1,300
    expect(await bgp.totalSupply()).to.equal(1_300);
    expect(await bgp.totalPoints()).to.equal(0);
    expect(await bgp.requiredReserve()).to.equal(1_300);
    await expectBacked(bgp);

    const o2 = await bgp.getOrder(2);
    expect(o2.status).to.equal(Status.Paid);
    expect(o2.paidBgp).to.equal(2_700);
    expect(o2.paidPoints).to.equal(300);
  });

  it("보유 포인트가 주문액보다 많으면 주문액만큼만 쓰고 나머지 포인트는 유지된다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await tkrw.connect(restaurant).approve(bgpAddr, 300);
    await bgp.connect(restaurant).awardPoints(1); // 300점

    await bgp.connect(cafe).createOrder(student.address, 200, TEN_MIN);
    await bgp.connect(student).pay(2, 200); // 포인트만으로 전액 결제

    expect(await bgp.pointBalanceOf(student.address)).to.equal(100);
    expect(await bgp.balanceOf(student.address)).to.equal(4_000); // BGP는 그대로
    expect(await tkrw.balanceOf(cafe.address)).to.equal(200);
    await expectBacked(bgp);
  });

  it("redeem: 미사용 BGP를 소각하고 같은 양의 tKRW를 돌려받는다", async function () {
    const f = await loadFixture(scenarioFixture);
    const { tkrw, bgp, student } = f;
    const before = await tkrw.balanceOf(student.address);

    await expect(bgp.connect(student).redeem(1_300))
      .to.emit(bgp, "Redeemed").withArgs(student.address, 1_300);

    expect(await bgp.balanceOf(student.address)).to.equal(0);
    expect(await tkrw.balanceOf(student.address)).to.equal(before + 1_300n);
    expect(await bgp.reserveBalance()).to.equal(0);
    await expectBacked(bgp);
  });

  it("BGP 일반 전송은 가능하지만 주문 결제로 인정되지 않는다 (주문 상태 유지)", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN);
    await bgp.connect(student).transfer(cafe.address, 3_000);

    expect(await bgp.balanceOf(cafe.address)).to.equal(3_000);
    expect((await bgp.getOrder(1)).status).to.equal(Status.Created);
    await expectBacked(bgp);
  });
});

describe("BabgilPoint - 환불", function () {
  it("카페 3,000 주문 전액 환불: 카페 3,000 tKRW 반환 → 2,700 BGP + 300점 복구", async function () {
    const f = await loadFixture(scenarioFixture);
    const { tkrw, bgp, bgpAddr, student, cafe } = f;

    await tkrw.connect(cafe).approve(bgpAddr, 3_000);
    await expect(bgp.connect(cafe).refund(2))
      .to.emit(bgp, "OrderRefunded").withArgs(2, student.address, cafe.address, 2_700, 300);

    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 4_000n, studentPoints: 300n, reserve: 4_300n, restaurantTkrw: 5_700n, cafeTkrw: 0n,
    });
    expect((await bgp.getOrder(2)).status).to.equal(Status.Refunded);
    await expectBacked(bgp);
  });

  it("매장의 반환 재원 승인이 부족하면 환불 전체가 실패한다", async function () {
    const f = await loadFixture(scenarioFixture);
    const { tkrw, bgp, bgpAddr, cafe } = f;
    const before = await snapshot(f);

    await tkrw.connect(cafe).approve(bgpAddr, 2_999);
    await expect(bgp.connect(cafe).refund(2)).to.be.revertedWithCustomError(tkrw, "ERC20InsufficientAllowance");

    expect(await snapshot(f)).to.deep.equal(before);
    expect((await bgp.getOrder(2)).status).to.equal(Status.Paid);
  });

  it("새 포인트가 적립된 주문(식당)은 환불할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, restaurant } = await loadFixture(scenarioFixture);
    await tkrw.connect(restaurant).approve(bgpAddr, 6_000);
    await expect(bgp.connect(restaurant).refund(1))
      .to.be.revertedWithCustomError(bgp, "RewardedOrderNotRefundable").withArgs(1);
  });

  it("같은 주문을 두 번 환불할 수 없고, 환불된 주문에는 적립할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = await loadFixture(scenarioFixture);
    await tkrw.connect(cafe).approve(bgpAddr, 6_000);
    await bgp.connect(cafe).refund(2);
    await expect(bgp.connect(cafe).refund(2)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");

    // 식당 주문을 적립 전에 환불하면, 이후 적립은 거절
    await bgp.connect(restaurant).createOrder(student.address, 1_000, TEN_MIN); // order 3
    await bgp.connect(student).pay(3, 0);
    await tkrw.connect(restaurant).approve(bgpAddr, 1_050);
    await bgp.connect(restaurant).refund(3);
    await expect(bgp.connect(restaurant).awardPoints(3)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
    await expectBacked(bgp);
  });
});

describe("BabgilPoint - 막히는 장면", function () {
  it("같은 주문으로 다시 결제 / 적립하면 거절된다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant } = await loadFixture(chargedFixture);
    await bgp.connect(restaurant).createOrder(student.address, 1_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await expect(bgp.connect(student).pay(1, 0))
      .to.be.revertedWithCustomError(bgp, "InvalidOrderStatus").withArgs(1, Status.Paid);

    await tkrw.connect(restaurant).approve(bgpAddr, 1_000);
    await bgp.connect(restaurant).awardPoints(1);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.be.revertedWithCustomError(bgp, "AlreadyRewarded").withArgs(1);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(50);
  });

  it("등록되지 않은 매장은 주문을 만들 수 없다", async function () {
    const { bgp, student, other } = await loadFixture(chargedFixture);
    await expect(bgp.connect(other).createOrder(student.address, 1_000, TEN_MIN))
      .to.be.revertedWithCustomError(bgp, "NotRegisteredStore").withArgs(other.address);
  });

  it("지정된 구매자가 아니면 결제할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, student, cafe, other } = await loadFixture(chargedFixture);
    await tkrw.connect(other).faucet();
    await tkrw.connect(other).approve(bgpAddr, 5_000);
    await bgp.connect(other).deposit(5_000);

    await bgp.connect(cafe).createOrder(student.address, 1_000, TEN_MIN);
    await expect(bgp.connect(other).pay(1, 0))
      .to.be.revertedWithCustomError(bgp, "NotOrderBuyer").withArgs(1, other.address);
  });

  it("다른 매장의 주문에는 적립 / 환불할 수 없다", async function () {
    const { bgp, cafe } = await loadFixture(scenarioFixture);
    await expect(bgp.connect(cafe).awardPoints(1))
      .to.be.revertedWithCustomError(bgp, "NotOrderStore").withArgs(1, cafe.address);
    await expect(bgp.connect(cafe).refund(1))
      .to.be.revertedWithCustomError(bgp, "NotOrderStore").withArgs(1, cafe.address);
  });

  it("운영자만 매장을 등록할 수 있고, 적립률 상한을 넘을 수 없다", async function () {
    const { bgp, owner, other } = await loadFixture(deployFixture);
    await expect(bgp.connect(other).addStore(other.address, "가짜", 500))
      .to.be.revertedWithCustomError(bgp, "OwnableUnauthorizedAccount");
    await expect(bgp.connect(owner).addStore(other.address, "과한적립", 2_001))
      .to.be.revertedWithCustomError(bgp, "InvalidRewardRate");
  });

  it("재원(tKRW) 없이 BGP 발행 / 포인트 적립을 할 수 없다", async function () {
    const { tkrw, bgp, student, restaurant, other } = await loadFixture(chargedFixture);

    // 임의 발행 함수 자체가 없다
    expect(bgp.interface.getFunction("mint", [])).to.equal(null);
    expect(bgp.interface.fragments.some((f) => f.type === "function" && /mint/i.test(f.name))).to.equal(false);

    // 승인 없이 deposit → 실패
    await tkrw.connect(other).faucet();
    await expect(bgp.connect(other).deposit(1_000))
      .to.be.revertedWithCustomError(tkrw, "ERC20InsufficientAllowance");
    expect(await bgp.balanceOf(other.address)).to.equal(0);

    // 매장이 재원을 승인하지 않으면 적립 실패
    await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.be.revertedWithCustomError(tkrw, "ERC20InsufficientAllowance");
    expect(await bgp.pointBalanceOf(student.address)).to.equal(0);
    expect((await bgp.getOrder(1)).rewardPoints).to.equal(0);
  });

  it("적립률 0% 매장(카페)은 적립할 수 없다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await expect(bgp.connect(cafe).awardPoints(1))
      .to.be.revertedWithCustomError(bgp, "NoRewardForStore").withArgs(cafe.address);
  });

  it("결제 전 주문에는 적립할 수 없다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.be.revertedWithCustomError(bgp, "InvalidOrderStatus").withArgs(1, Status.Created);
  });

  it("가진 BGP보다 많은 금액을 결제하면 거절되고, 잔액과 주문 상태가 유지된다", async function () {
    const f = await loadFixture(chargedFixture);
    const { bgp, student, cafe } = f;
    await bgp.connect(cafe).createOrder(student.address, 10_001, TEN_MIN);
    const before = await snapshot(f);

    await expect(bgp.connect(student).pay(1, 0))
      .to.be.revertedWithCustomError(bgp, "ERC20InsufficientBalance");

    expect(await snapshot(f)).to.deep.equal(before);
    expect((await bgp.getOrder(1)).status).to.equal(Status.Created);
  });

  it("보유 포인트보다 많이 쓰려 하면 거절된다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN);
    await expect(bgp.connect(student).pay(1, 1))
      .to.be.revertedWithCustomError(bgp, "InsufficientPoints").withArgs(1, 0);
  });

  it("주문액보다 많은 포인트를 쓰려 하면 거절된다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await tkrw.connect(restaurant).approve(bgpAddr, 300);
    await bgp.connect(restaurant).awardPoints(1); // 300점

    await bgp.connect(cafe).createOrder(student.address, 200, TEN_MIN);
    await expect(bgp.connect(student).pay(2, 300))
      .to.be.revertedWithCustomError(bgp, "PointsExceedAmount").withArgs(300, 200);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(300);
  });

  it("만료된 주문은 결제할 수 없다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(cafe).createOrder(student.address, 1_000, TEN_MIN);
    await time.increase(TEN_MIN + 1);
    await expect(bgp.connect(student).pay(1, 0)).to.be.revertedWithCustomError(bgp, "OrderExpired");
  });

  it("존재하지 않는 주문은 결제할 수 없다", async function () {
    const { bgp, student } = await loadFixture(chargedFixture);
    await expect(bgp.connect(student).pay(99, 0))
      .to.be.revertedWithCustomError(bgp, "InvalidOrderStatus").withArgs(99, Status.None);
  });

  it("잘못된 주문 입력(0원, 0초 / 1일 초과 만료, 0 주소 구매자)은 거절된다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await expect(bgp.connect(cafe).createOrder(student.address, 0, TEN_MIN)).to.be.revertedWithCustomError(bgp, "ZeroAmount");
    await expect(bgp.connect(cafe).createOrder(student.address, 100, 0)).to.be.revertedWithCustomError(bgp, "InvalidDuration");
    await expect(bgp.connect(cafe).createOrder(student.address, 100, 86_401)).to.be.revertedWithCustomError(bgp, "InvalidDuration");
    await expect(bgp.connect(cafe).createOrder(ethers.ZeroAddress, 100, TEN_MIN)).to.be.revertedWithCustomError(bgp, "ZeroAddress");
  });
});

describe("BabgilPoint - 매장 지급 토큰 전송 실패 (모의 토큰)", function () {
  async function failingFixture() {
    const [owner, student, restaurant, cafe] = await ethers.getSigners();
    const ftk = await ethers.deployContract("FailingToken");
    const bgp = await ethers.deployContract("BabgilPoint", [await ftk.getAddress()]);
    const bgpAddr = await bgp.getAddress();
    await bgp.addStore(restaurant.address, "학생식당", RESTAURANT_BPS);
    await bgp.addStore(cafe.address, "교내카페", CAFE_BPS);

    await ftk.mint(student.address, 10_000);
    await ftk.connect(student).approve(bgpAddr, 10_000);
    await bgp.connect(student).deposit(10_000);

    // 포인트 300점 보유 상태 만들기
    await bgp.connect(restaurant).createOrder(student.address, 6_000, TEN_MIN);
    await bgp.connect(student).pay(1, 0);
    await ftk.connect(restaurant).approve(bgpAddr, 300);
    await bgp.connect(restaurant).awardPoints(1);
    return { ftk, bgp, student, restaurant, cafe };
  }

  it("지급 전송이 false를 반환하면 포인트 차감 / BGP 소각 / 주문 갱신이 모두 취소된다", async function () {
    const { ftk, bgp, student, cafe } = await loadFixture(failingFixture);
    await bgp.connect(cafe).createOrder(student.address, 3_000, TEN_MIN); // order 2

    const before = {
      bgp: await bgp.balanceOf(student.address),
      points: await bgp.pointBalanceOf(student.address),
      supply: await bgp.totalSupply(),
      totalPoints: await bgp.totalPoints(),
      reserve: await bgp.reserveBalance(),
    };
    expect(before.bgp).to.equal(4_000);
    expect(before.points).to.equal(300);

    await ftk.setFailTransfers(true);
    await expect(bgp.connect(student).pay(2, 300))
      .to.be.revertedWithCustomError(bgp, "SafeERC20FailedOperation");

    expect(await bgp.balanceOf(student.address)).to.equal(before.bgp);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(before.points);
    expect(await bgp.totalSupply()).to.equal(before.supply);
    expect(await bgp.totalPoints()).to.equal(before.totalPoints);
    expect(await bgp.reserveBalance()).to.equal(before.reserve);
    expect((await bgp.getOrder(2)).status).to.equal(Status.Created);
    expect(await ftk.balanceOf(cafe.address)).to.equal(0);

    // 전송이 정상화되면 같은 주문을 다시 결제할 수 있다
    await ftk.setFailTransfers(false);
    await bgp.connect(student).pay(2, 300);
    expect(await ftk.balanceOf(cafe.address)).to.equal(3_000);
    expect(await bgp.balanceOf(student.address)).to.equal(1_300);
  });

  it("redeem 전송이 실패하면 BGP 소각도 취소된다", async function () {
    const { ftk, bgp, student } = await loadFixture(failingFixture);
    await ftk.setFailTransfers(true);
    await expect(bgp.connect(student).redeem(1_000))
      .to.be.revertedWithCustomError(bgp, "SafeERC20FailedOperation");
    expect(await bgp.balanceOf(student.address)).to.equal(4_000);
  });
});
