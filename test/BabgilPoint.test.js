const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const RESTAURANT_BPS = 500; // 5%
const CAFE_BPS = 0;
const ACCEPT_WINDOW = 30 * 60;

const Status = { None: 0n, Placed: 1n, Accepted: 2n, Rejected: 3n, Cancelled: 4n, Refunded: 5n };

// 메뉴 번호
const R = { JEYUK: 0, RAMEN: 1 }; // 학생식당: 제육덮밥 6,000 / 라면 3,000
const C = { AMERICANO: 0, LATTE: 1 }; // 교내카페: 아메리카노 3,000 / 카페라테 3,500

async function setupStores(bgp, restaurant, cafe) {
  await bgp.addStore(restaurant.address, "학생식당", RESTAURANT_BPS);
  await bgp.addStore(cafe.address, "교내카페", CAFE_BPS);
  await bgp.connect(restaurant).addMenuItem("제육덮밥", 6_000);
  await bgp.connect(restaurant).addMenuItem("라면", 3_000);
  await bgp.connect(cafe).addMenuItem("아메리카노", 3_000);
  await bgp.connect(cafe).addMenuItem("카페라테", 3_500);
}

async function deployFixture() {
  const [owner, student, restaurant, cafe, other] = await ethers.getSigners();

  const tkrw = await ethers.deployContract("TKRW");
  const bgp = await ethers.deployContract("BabgilPoint", [await tkrw.getAddress()]);
  const bgpAddr = await bgp.getAddress();

  await setupStores(bgp, restaurant, cafe);
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

/** 식당 주문·접수·적립까지 마친 상태 (학생 4,000 BGP + 300점) */
async function rewardedFixture() {
  const f = await chargedFixture();
  const { tkrw, bgp, bgpAddr, student, restaurant } = f;
  await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0); // order 1
  await bgp.connect(restaurant).acceptOrder(1);
  await tkrw.connect(restaurant).approve(bgpAddr, 300);
  await bgp.connect(restaurant).awardPoints(1);
  return f;
}

/** 발표 시나리오 ①~④를 모두 마친 상태 */
async function scenarioFixture() {
  const f = await rewardedFixture();
  const { bgp, student, cafe } = f;
  await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 300); // order 2
  await bgp.connect(cafe).acceptOrder(2);
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
  it("① 충전 → ② 식당 주문·접수 → ③ 적립 → ④ 카페 혼합 결제 잔액표가 문서와 일치한다", async function () {
    const f = await loadFixture(deployFixture);
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = f;

    // ① 충전
    await tkrw.connect(student).approve(bgpAddr, 10_000);
    await expect(bgp.connect(student).deposit(10_000))
      .to.emit(bgp, "Deposited").withArgs(student.address, 10_000);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 10_000n, studentPoints: 0n, reserve: 10_000n, restaurantTkrw: 0n, cafeTkrw: 0n,
    });

    // ② 학생이 제육덮밥 주문·결제 → BGP는 금고에 잡혀 있고 아직 식당에 안 감
    await expect(bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0))
      .to.emit(bgp, "OrderPlaced").withArgs(1, student.address, restaurant.address, 6_000, 6_000, 0);
    expect(await bgp.balanceOf(student.address)).to.equal(4_000);
    expect(await bgp.balanceOf(bgpAddr)).to.equal(6_000);
    expect(await tkrw.balanceOf(restaurant.address)).to.equal(0);
    await expectBacked(bgp);

    // 식당 접수 → 잡아둔 BGP 소각 + 6,000 tKRW 지급
    await expect(bgp.connect(restaurant).acceptOrder(1))
      .to.emit(bgp, "OrderAccepted").withArgs(1, student.address, restaurant.address, 6_000);
    expect(await bgp.balanceOf(bgpAddr)).to.equal(0);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 4_000n, studentPoints: 0n, reserve: 4_000n, restaurantTkrw: 6_000n, cafeTkrw: 0n,
    });

    // ③ 적립 (BGP 6,000 × 5% = 300, 식당이 300 tKRW 부담)
    expect(await bgp.rewardFor(1)).to.equal(300);
    await tkrw.connect(restaurant).approve(bgpAddr, 300);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.emit(bgp, "PointsAwarded").withArgs(1, student.address, restaurant.address, 300);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 4_000n, studentPoints: 300n, reserve: 4_300n, restaurantTkrw: 5_700n, cafeTkrw: 0n,
    });

    // ④ 카페 아메리카노: 포인트 300 + BGP 2,700 → 접수 시 카페에 3,000 전액
    await expect(bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 300))
      .to.emit(bgp, "OrderPlaced").withArgs(2, student.address, cafe.address, 3_000, 2_700, 300);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(0);
    expect(await bgp.totalPoints()).to.equal(300); // 잡아둔 포인트도 금고가 책임짐
    await expectBacked(bgp);

    await bgp.connect(cafe).acceptOrder(2);
    expect(await snapshot(f)).to.deep.equal({
      studentBgp: 1_300n, studentPoints: 0n, reserve: 1_300n, restaurantTkrw: 5_700n, cafeTkrw: 3_000n,
    });

    // ⑤ 최종 상태
    expect(await bgp.totalSupply()).to.equal(1_300);
    expect(await bgp.totalPoints()).to.equal(0);
    expect(await bgp.requiredReserve()).to.equal(1_300);
    await expectBacked(bgp);

    const o2 = await bgp.getOrder(2);
    expect(o2.status).to.equal(Status.Accepted);
    expect(o2.paidBgp).to.equal(2_700);
    expect(o2.paidPoints).to.equal(300);
  });

  it("여러 메뉴·수량을 고르면 컨트랙트가 메뉴 가격으로 금액을 계산하고 주문 내역을 남긴다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    // 라면 2개(6,000) + 제육덮밥 0개는 불가 → 라면 2개 + 제육덮밥 1개는 12,000이라 잔액 초과
    // 라면 1개(3,000) + 제육덮밥 1개(6,000) = 9,000
    await bgp.connect(student).placeOrder(restaurant.address, [R.RAMEN, R.JEYUK], [1, 1], 0);

    const o = await bgp.getOrder(1);
    expect(o.amount).to.equal(9_000);
    expect(o.paidBgp).to.equal(9_000);
    expect(o.acceptDeadline - o.placedAt).to.equal(ACCEPT_WINDOW);
    const lines = await bgp.getOrderLines(1);
    expect(lines.map((l) => [l.itemId, l.quantity, l.unitPrice])).to.deep.equal([[1n, 1n, 3_000n], [0n, 1n, 6_000n]]);
  });

  it("주문 시점 가격이 고정되어, 이후 가격을 바꿔도 이미 들어온 주문 금액은 그대로다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(student).placeOrder(cafe.address, [C.LATTE], [1], 0);
    await bgp.connect(cafe).updateMenuItem(C.LATTE, 4_000, true);

    expect((await bgp.getOrder(1)).amount).to.equal(3_500);
    expect((await bgp.getOrderLines(1))[0].unitPrice).to.equal(3_500);
    expect((await bgp.getMenu(cafe.address))[C.LATTE].price).to.equal(4_000);
  });

  it("적립은 BGP로 결제한 금액 기준이다 (포인트 사용분 제외)", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant } = await loadFixture(rewardedFixture);
    // 라면 3,000 = 포인트 300 + BGP 2,700 → 적립 2,700 × 5% = 135
    await bgp.connect(student).placeOrder(restaurant.address, [R.RAMEN], [1], 300); // order 2
    await bgp.connect(restaurant).acceptOrder(2);
    expect(await bgp.rewardFor(2)).to.equal(135);

    await tkrw.connect(restaurant).approve(bgpAddr, 135);
    await bgp.connect(restaurant).awardPoints(2);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(135);
    await expectBacked(bgp);
  });

  it("보유 포인트가 주문액보다 많아도 주문액만큼만 쓸 수 있고 나머지는 유지된다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant, cafe } = await loadFixture(chargedFixture);
    await tkrw.connect(student).approve(bgpAddr, 5_000);
    await bgp.connect(student).deposit(5_000); // 15,000 BGP
    // 제육덮밥 1개 (BGP) → 300점, 다시 1개 (BGP) → 300점 → 600점, BGP 3,000 남음
    for (const id of [1, 2]) {
      await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
      await bgp.connect(restaurant).acceptOrder(id);
      await tkrw.connect(restaurant).approve(bgpAddr, 300);
      await bgp.connect(restaurant).awardPoints(id);
    }
    await bgp.connect(cafe).addMenuItem("샷 추가", 500); // itemId 2
    await expect(bgp.connect(student).placeOrder(cafe.address, [2], [1], 600))
      .to.be.revertedWithCustomError(bgp, "PointsExceedAmount");
    await bgp.connect(student).placeOrder(cafe.address, [2], [1], 500);
    expect((await bgp.getOrder(3)).paidBgp).to.equal(0);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(100);
  });

  it("redeem: 미사용 BGP를 소각하고 같은 양의 tKRW를 돌려받는다", async function () {
    const { tkrw, bgp, student } = await loadFixture(scenarioFixture);
    const before = await tkrw.balanceOf(student.address);
    await expect(bgp.connect(student).redeem(1_300))
      .to.emit(bgp, "Redeemed").withArgs(student.address, 1_300);
    expect(await bgp.balanceOf(student.address)).to.equal(0);
    expect(await tkrw.balanceOf(student.address)).to.equal(before + 1_300n);
    expect(await bgp.reserveBalance()).to.equal(0);
    await expectBacked(bgp);
  });
});

describe("BabgilPoint - 접수 대기 / 거절 / 취소", function () {
  it("매장이 거절하면 잡아둔 BGP와 포인트가 학생에게 그대로 돌아간다", async function () {
    const f = await loadFixture(rewardedFixture);
    const { bgp, bgpAddr, student, cafe } = f;
    const before = await snapshot(f);

    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 300); // order 2
    await expect(bgp.connect(cafe).rejectOrder(2))
      .to.emit(bgp, "OrderRejected").withArgs(2, student.address, cafe.address);

    expect(await snapshot(f)).to.deep.equal(before);
    expect(await bgp.balanceOf(bgpAddr)).to.equal(0);
    expect((await bgp.getOrder(2)).status).to.equal(Status.Rejected);
    await expectBacked(bgp);
  });

  it("학생은 접수 전이면 언제든 취소할 수 있다", async function () {
    const f = await loadFixture(rewardedFixture);
    const { bgp, student, cafe } = f;
    const before = await snapshot(f);
    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 300);
    await expect(bgp.connect(student).cancelOrder(2))
      .to.emit(bgp, "OrderCancelled").withArgs(2, student.address, cafe.address, student.address);
    expect(await snapshot(f)).to.deep.equal(before);
  });

  it("접수 시간(30분)이 지나면 매장은 접수할 수 없고, 누구나 취소해서 학생에게 돌려줄 수 있다", async function () {
    const f = await loadFixture(chargedFixture);
    const { bgp, student, cafe, other } = f;
    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 0);

    // 시간 안에는 제3자가 취소할 수 없다
    await expect(bgp.connect(other).cancelOrder(1)).to.be.revertedWithCustomError(bgp, "NotOrderBuyer");

    await time.increase(ACCEPT_WINDOW + 1);
    await expect(bgp.connect(cafe).acceptOrder(1)).to.be.revertedWithCustomError(bgp, "AcceptWindowClosed");
    await bgp.connect(other).cancelOrder(1);
    expect(await bgp.balanceOf(student.address)).to.equal(10_000);
    expect((await bgp.getOrder(1)).status).to.equal(Status.Cancelled);
  });

  it("접수 / 거절 / 취소가 끝난 주문은 다시 처리할 수 없다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 0); // 1
    await bgp.connect(cafe).acceptOrder(1);
    await expect(bgp.connect(cafe).acceptOrder(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
    await expect(bgp.connect(cafe).rejectOrder(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
    await expect(bgp.connect(student).cancelOrder(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");

    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 0); // 2
    await bgp.connect(cafe).rejectOrder(2);
    await expect(bgp.connect(cafe).acceptOrder(2)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
    await expect(bgp.connect(student).cancelOrder(2)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
  });

  it("다른 매장의 주문은 접수 / 거절할 수 없다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    const [, , , cafe] = await ethers.getSigners();
    await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
    await expect(bgp.connect(cafe).acceptOrder(1)).to.be.revertedWithCustomError(bgp, "NotOrderStore");
    await expect(bgp.connect(cafe).rejectOrder(1)).to.be.revertedWithCustomError(bgp, "NotOrderStore");
  });

  it("접수 전에는 적립 / 환불할 수 없다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
    await expect(bgp.connect(restaurant).awardPoints(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
    await expect(bgp.connect(restaurant).refund(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
  });
});

describe("BabgilPoint - 메뉴", function () {
  it("등록된 매장만 메뉴를 추가 / 수정할 수 있다", async function () {
    const { bgp, other } = await loadFixture(deployFixture);
    await expect(bgp.connect(other).addMenuItem("김밥", 2_500)).to.be.revertedWithCustomError(bgp, "NotRegisteredStore");
    await expect(bgp.connect(other).updateMenuItem(0, 2_500, true)).to.be.revertedWithCustomError(bgp, "NotRegisteredStore");
  });

  it("잘못된 메뉴 입력(빈 이름, 0원, 없는 메뉴 번호)은 거절된다", async function () {
    const { bgp, cafe } = await loadFixture(deployFixture);
    await expect(bgp.connect(cafe).addMenuItem("", 1_000)).to.be.revertedWithCustomError(bgp, "EmptyName");
    await expect(bgp.connect(cafe).addMenuItem("물", 0)).to.be.revertedWithCustomError(bgp, "ZeroAmount");
    await expect(bgp.connect(cafe).updateMenuItem(9, 1_000, true)).to.be.revertedWithCustomError(bgp, "InvalidMenuItem");
    await expect(bgp.connect(cafe).updateMenuItem(0, 0, true)).to.be.revertedWithCustomError(bgp, "ZeroAmount");
  });

  it("판매 중지한 메뉴는 주문할 수 없고, 다시 판매하면 주문할 수 있다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    await bgp.connect(cafe).updateMenuItem(C.LATTE, 3_500, false);
    await expect(bgp.connect(student).placeOrder(cafe.address, [C.LATTE], [1], 0))
      .to.be.revertedWithCustomError(bgp, "MenuItemUnavailable");
    await bgp.connect(cafe).updateMenuItem(C.LATTE, 3_500, true);
    await bgp.connect(student).placeOrder(cafe.address, [C.LATTE], [1], 0);
  });

  it("매장 메뉴는 50개까지만 등록할 수 있다", async function () {
    const { bgp, cafe } = await loadFixture(deployFixture);
    for (let i = 2; i < 50; i++) await bgp.connect(cafe).addMenuItem(`메뉴${i}`, 1_000);
    await expect(bgp.connect(cafe).addMenuItem("51번째", 1_000)).to.be.revertedWithCustomError(bgp, "MenuFull");
  });
});

describe("BabgilPoint - 잘못된 주문", function () {
  it("등록되지 않은 매장에는 주문할 수 없다", async function () {
    const { bgp, student, other } = await loadFixture(chargedFixture);
    await expect(bgp.connect(student).placeOrder(other.address, [0], [1], 0))
      .to.be.revertedWithCustomError(bgp, "NotRegisteredStore");
  });

  it("빈 주문, 없는 메뉴, 수량 0 / 100 초과, 목록 길이 불일치는 거절된다", async function () {
    const { bgp, student, cafe } = await loadFixture(chargedFixture);
    const s = bgp.connect(student);
    await expect(s.placeOrder(cafe.address, [], [], 0)).to.be.revertedWithCustomError(bgp, "EmptyOrder");
    await expect(s.placeOrder(cafe.address, [7], [1], 0)).to.be.revertedWithCustomError(bgp, "InvalidMenuItem");
    await expect(s.placeOrder(cafe.address, [0], [0], 0)).to.be.revertedWithCustomError(bgp, "InvalidQuantity");
    await expect(s.placeOrder(cafe.address, [0], [101], 0)).to.be.revertedWithCustomError(bgp, "InvalidQuantity");
    await expect(s.placeOrder(cafe.address, [0, 1], [1], 0)).to.be.revertedWithCustomError(bgp, "LengthMismatch");
    const many = Array(21).fill(0);
    await expect(s.placeOrder(cafe.address, many, many.map(() => 1), 0)).to.be.revertedWithCustomError(bgp, "TooManyLines");
  });

  it("가진 BGP보다 비싼 주문은 거절되고, 잔액과 주문 번호가 그대로다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    await expect(bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [2], 0)) // 12,000
      .to.be.revertedWithCustomError(bgp, "ERC20InsufficientBalance");
    expect(await bgp.balanceOf(student.address)).to.equal(10_000);
    expect(await bgp.orderCount()).to.equal(0);
  });

  it("보유 포인트보다 많이 쓰려 하면 거절된다", async function () {
    const { bgp, student, cafe } = await loadFixture(rewardedFixture);
    await expect(bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 301))
      .to.be.revertedWithCustomError(bgp, "InsufficientPoints");
  });
});

describe("BabgilPoint - 적립 / 환불 규칙", function () {
  it("같은 주문에 두 번 적립할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, restaurant } = await loadFixture(rewardedFixture);
    await tkrw.connect(restaurant).approve(bgpAddr, 300);
    await expect(bgp.connect(restaurant).awardPoints(1)).to.be.revertedWithCustomError(bgp, "AlreadyRewarded");
  });

  it("적립률 0% 매장(카페)이나 포인트로만 낸 주문은 적립할 수 없다", async function () {
    const { bgp, student, restaurant, cafe } = await loadFixture(rewardedFixture);
    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 0); // 2
    await bgp.connect(cafe).acceptOrder(2);
    await expect(bgp.connect(cafe).awardPoints(2)).to.be.revertedWithCustomError(bgp, "NoReward");

    // 식당에서 포인트 300으로만 결제할 메뉴가 없으니 300원 메뉴를 추가
    await bgp.connect(restaurant).addMenuItem("단무지 추가", 300);
    await bgp.connect(student).placeOrder(restaurant.address, [2], [1], 300); // 3
    await bgp.connect(restaurant).acceptOrder(3);
    await expect(bgp.connect(restaurant).awardPoints(3)).to.be.revertedWithCustomError(bgp, "NoReward");
  });

  it("매장의 tKRW 승인이 부족하면 적립 전체가 실패한다", async function () {
    const { bgp, student, restaurant } = await loadFixture(chargedFixture);
    await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
    await bgp.connect(restaurant).acceptOrder(1);
    await expect(bgp.connect(restaurant).awardPoints(1))
      .to.be.revertedWithCustomError(bgp, "ERC20InsufficientAllowance");
    expect(await bgp.pointBalanceOf(student.address)).to.equal(0);
  });

  it("카페 주문 환불: 카페가 3,000 tKRW를 돌려주면 2,700 BGP + 300점이 복구된다", async function () {
    const f = await loadFixture(scenarioFixture);
    const { tkrw, bgp, bgpAddr, student, cafe } = f;
    await tkrw.connect(cafe).approve(bgpAddr, 3_000);
    await expect(bgp.connect(cafe).refund(2))
      .to.emit(bgp, "OrderRefunded").withArgs(2, student.address, cafe.address, 2_700, 300);
    expect(await bgp.balanceOf(student.address)).to.equal(4_000);
    expect(await bgp.pointBalanceOf(student.address)).to.equal(300);
    expect(await tkrw.balanceOf(cafe.address)).to.equal(0);
    expect((await bgp.getOrder(2)).status).to.equal(Status.Refunded);
    await expectBacked(bgp);

    await expect(bgp.connect(cafe).refund(2)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
  });

  it("포인트가 적립된 주문(식당)은 환불할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, restaurant } = await loadFixture(rewardedFixture);
    await tkrw.connect(restaurant).approve(bgpAddr, 6_000);
    await expect(bgp.connect(restaurant).refund(1)).to.be.revertedWithCustomError(bgp, "RewardedOrderNotRefundable");
  });

  it("환불된 주문에는 적립할 수 없다", async function () {
    const { tkrw, bgp, bgpAddr, student, restaurant } = await loadFixture(chargedFixture);
    await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
    await bgp.connect(restaurant).acceptOrder(1);
    await tkrw.connect(restaurant).approve(bgpAddr, 6_300);
    await bgp.connect(restaurant).refund(1);
    await expect(bgp.connect(restaurant).awardPoints(1)).to.be.revertedWithCustomError(bgp, "InvalidOrderStatus");
  });
});

describe("BabgilPoint - 권한 / 금고", function () {
  it("운영자만 매장을 등록할 수 있고, 적립률 상한·빈 이름·중복 등록은 거절된다", async function () {
    const { bgp, other, cafe } = await loadFixture(deployFixture);
    await expect(bgp.connect(other).addStore(other.address, "가짜", 100))
      .to.be.revertedWithCustomError(bgp, "OwnableUnauthorizedAccount");
    await expect(bgp.addStore(other.address, "편의점", 2_001)).to.be.revertedWithCustomError(bgp, "InvalidRewardRate");
    await expect(bgp.addStore(other.address, "", 100)).to.be.revertedWithCustomError(bgp, "EmptyName");
    await expect(bgp.addStore(cafe.address, "교내카페", 0)).to.be.revertedWithCustomError(bgp, "AlreadyRegistered");
  });

  it("tKRW 없이 BGP 발행이나 포인트 적립은 할 수 없다", async function () {
    const { bgp, other } = await loadFixture(deployFixture);
    await expect(bgp.connect(other).deposit(1_000)).to.be.revertedWithCustomError(bgp, "ERC20InsufficientAllowance");
    expect(await bgp.totalSupply()).to.equal(0);
  });

  it("BGP를 컨트랙트로 직접 보내도 주문으로 인정되지 않고, 금고는 여전히 충분하다", async function () {
    const { bgp, bgpAddr, student } = await loadFixture(chargedFixture);
    await bgp.connect(student).transfer(bgpAddr, 1_000);
    expect(await bgp.orderCount()).to.equal(0);
    await expectBacked(bgp);
  });
});

describe("BabgilPoint - 전송 실패 시 전체 취소", function () {
  async function failingFixture() {
    const [owner, student, restaurant, cafe] = await ethers.getSigners();
    const ftk = await ethers.deployContract("FailingToken");
    const bgp = await ethers.deployContract("BabgilPoint", [await ftk.getAddress()]);
    const bgpAddr = await bgp.getAddress();
    await setupStores(bgp, restaurant, cafe);

    await ftk.mint(student.address, 10_000);
    await ftk.connect(student).approve(bgpAddr, 10_000);
    await bgp.connect(student).deposit(10_000);

    // 포인트 300점 보유 상태 만들기
    await bgp.connect(student).placeOrder(restaurant.address, [R.JEYUK], [1], 0);
    await bgp.connect(restaurant).acceptOrder(1);
    await ftk.connect(restaurant).approve(bgpAddr, 300);
    await bgp.connect(restaurant).awardPoints(1);
    return { ftk, bgp, bgpAddr, student, restaurant, cafe };
  }

  it("접수 시 지급 전송이 false를 반환하면 BGP 소각 / 포인트 차감 / 상태 변경이 모두 취소된다", async function () {
    const { ftk, bgp, bgpAddr, student, cafe } = await loadFixture(failingFixture);
    await bgp.connect(student).placeOrder(cafe.address, [C.AMERICANO], [1], 300); // order 2

    const before = {
      held: await bgp.balanceOf(bgpAddr),
      supply: await bgp.totalSupply(),
      totalPoints: await bgp.totalPoints(),
      reserve: await bgp.reserveBalance(),
    };
    expect(before.held).to.equal(2_700);

    await ftk.setFailTransfers(true);
    await expect(bgp.connect(cafe).acceptOrder(2)).to.be.revertedWithCustomError(bgp, "SafeERC20FailedOperation");

    expect(await bgp.balanceOf(bgpAddr)).to.equal(before.held);
    expect(await bgp.totalSupply()).to.equal(before.supply);
    expect(await bgp.totalPoints()).to.equal(before.totalPoints);
    expect(await bgp.reserveBalance()).to.equal(before.reserve);
    expect((await bgp.getOrder(2)).status).to.equal(Status.Placed);
    expect(await ftk.balanceOf(cafe.address)).to.equal(0);

    // 전송이 정상화되면 같은 주문을 다시 접수할 수 있다
    await ftk.setFailTransfers(false);
    await bgp.connect(cafe).acceptOrder(2);
    expect(await ftk.balanceOf(cafe.address)).to.equal(3_000);
    expect(await bgp.balanceOf(student.address)).to.equal(1_300);
  });

  it("redeem 전송이 실패하면 BGP 소각도 취소된다", async function () {
    const { ftk, bgp, student } = await loadFixture(failingFixture);
    await ftk.setFailTransfers(true);
    await expect(bgp.connect(student).redeem(1_000)).to.be.revertedWithCustomError(bgp, "SafeERC20FailedOperation");
    expect(await bgp.balanceOf(student.address)).to.equal(4_000);
  });
});
