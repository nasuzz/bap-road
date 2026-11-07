// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title 밥길 포인트 (BGP 결제 토큰 + 적립 포인트 + 주문 정산)
/// @notice
///  - BGP: 학생이 tKRW를 예치하면 1:1로 발행되는 결제용 ERC-20
///  - 포인트: 혜택 매장이 tKRW 재원을 부담해 적립해 주는 별도 온체인 잔액 (양도 / 현금 반환 불가)
///  - 컨트랙트가 tKRW를 보관하고, 결제 시 주문 금액을 매장에 지급해요.
///
///  불변식: tKRW 보관액 >= BGP 총공급량 + 미사용 전체 포인트
///  운영자는 매장 등록만 할 수 있어요. 임의 발행 / 보관 재원 인출 / 업그레이드 기능은 없어요.
contract BabgilPoint is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // 타입 / 상태
    // ---------------------------------------------------------------------

    enum OrderStatus {
        None, // 존재하지 않는 주문
        Created, // 매장이 등록, 결제 대기
        Paid, // 결제 완료
        Refunded // 환불 완료
    }

    struct Store {
        bool registered;
        uint16 rewardBps; // 적립률 (500 = 5%). 0이면 적립 없음
        string name;
    }

    struct Order {
        address buyer;
        address store;
        uint256 amount; // 확정 주문 금액
        uint64 expiresAt; // 결제 만료 시각 (unix time)
        OrderStatus status;
        uint256 paidBgp; // 결제에 사용한 BGP
        uint256 paidPoints; // 결제에 사용한 포인트
        uint256 rewardPoints; // 이 주문으로 적립된 포인트 (0이면 미적립)
    }

    uint16 public constant MAX_REWARD_BPS = 2_000; // 적립률 상한 20%
    uint64 public constant MAX_ORDER_DURATION = 1 days;

    IERC20 public immutable tkrw;

    mapping(address => Store) public stores;
    address[] public storeList;

    mapping(uint256 => Order) private _orders;
    uint256 public orderCount; // 주문 ID는 1부터 시작

    mapping(address => uint256) public pointBalanceOf;
    uint256 public totalPoints;

    // ---------------------------------------------------------------------
    // 이벤트 / 에러
    // ---------------------------------------------------------------------

    event StoreAdded(address indexed store, string name, uint16 rewardBps);
    event Deposited(address indexed student, uint256 amount);
    event Redeemed(address indexed student, uint256 amount);
    event OrderCreated(uint256 indexed orderId, address indexed store, address indexed buyer, uint256 amount, uint64 expiresAt);
    event OrderPaid(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 bgpUsed, uint256 pointsUsed);
    event PointsAwarded(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 points);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 bgpRestored, uint256 pointsRestored);

    error ZeroAddress();
    error ZeroAmount();
    error AlreadyRegistered(address store);
    error InvalidRewardRate(uint16 rewardBps);
    error InvalidDuration(uint64 duration);
    error NotRegisteredStore(address caller);
    error NotOrderStore(uint256 orderId, address caller);
    error NotOrderBuyer(uint256 orderId, address caller);
    error InvalidOrderStatus(uint256 orderId, OrderStatus status);
    error OrderExpired(uint256 orderId, uint64 expiresAt);
    error PointsExceedAmount(uint256 points, uint256 amount);
    error InsufficientPoints(uint256 requested, uint256 available);
    error AlreadyRewarded(uint256 orderId);
    error NoRewardForStore(address store);
    error RewardedOrderNotRefundable(uint256 orderId);

    // ---------------------------------------------------------------------
    // 생성자
    // ---------------------------------------------------------------------

    constructor(IERC20 tkrw_) ERC20("Babgil Pay", "BGP") Ownable(msg.sender) {
        if (address(tkrw_) == address(0)) revert ZeroAddress();
        tkrw = tkrw_;
    }

    /// @dev tKRW와 같은 단위(소수점 없음)로 맞춰요.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ---------------------------------------------------------------------
    // 운영자
    // ---------------------------------------------------------------------

    /// @notice 참여 매장 등록. 운영자 권한은 이것뿐이에요.
    function addStore(address store, string calldata name, uint16 rewardBps) external onlyOwner {
        if (store == address(0)) revert ZeroAddress();
        if (stores[store].registered) revert AlreadyRegistered(store);
        if (rewardBps > MAX_REWARD_BPS) revert InvalidRewardRate(rewardBps);

        stores[store] = Store({registered: true, rewardBps: rewardBps, name: name});
        storeList.push(store);
        emit StoreAdded(store, name, rewardBps);
    }

    // ---------------------------------------------------------------------
    // 학생
    // ---------------------------------------------------------------------

    /// @notice tKRW를 예치하고 같은 수량의 BGP를 받아요. 사전에 tkrw.approve(this, amount) 필요.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        tkrw.safeTransferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice 주문 결제. 포인트를 먼저 쓰고 부족분은 BGP로 결제해요.
    ///         포인트 차감 / BGP 소각 / 매장 지급 / 상태 갱신이 한 거래로 처리되고,
    ///         어느 하나라도 실패하면 전부 되돌아가요.
    /// @param pointsToUse 사용할 포인트 (0 ~ min(주문 금액, 보유 포인트))
    function pay(uint256 orderId, uint256 pointsToUse) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Created) revert InvalidOrderStatus(orderId, o.status);
        if (msg.sender != o.buyer) revert NotOrderBuyer(orderId, msg.sender);
        if (block.timestamp > o.expiresAt) revert OrderExpired(orderId, o.expiresAt);
        if (pointsToUse > o.amount) revert PointsExceedAmount(pointsToUse, o.amount);
        uint256 available = pointBalanceOf[msg.sender];
        if (pointsToUse > available) revert InsufficientPoints(pointsToUse, available);

        uint256 bgpToUse = o.amount - pointsToUse;

        // effects
        o.status = OrderStatus.Paid;
        o.paidBgp = bgpToUse;
        o.paidPoints = pointsToUse;
        pointBalanceOf[msg.sender] = available - pointsToUse;
        totalPoints -= pointsToUse;
        if (bgpToUse > 0) _burn(msg.sender, bgpToUse); // 잔액 부족 시 revert

        // interaction: 사용 매장에 주문 금액 전액 지급 (BGP분 + 포인트분)
        tkrw.safeTransfer(o.store, o.amount);

        emit OrderPaid(orderId, msg.sender, o.store, bgpToUse, pointsToUse);
    }

    /// @notice 미사용 BGP를 소각하고 같은 수량의 tKRW를 돌려받아요. 포인트는 반환 대상이 아니에요.
    function redeem(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        tkrw.safeTransfer(msg.sender, amount);
        emit Redeemed(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // 매장
    // ---------------------------------------------------------------------

    modifier onlyStore() {
        if (!stores[msg.sender].registered) revert NotRegisteredStore(msg.sender);
        _;
    }

    /// @notice 구매자 / 금액 / 만료 시간을 확정해 주문을 등록해요.
    /// @param duration 지금부터 결제 가능한 시간(초). 1초 ~ 1일
    function createOrder(address buyer, uint256 amount, uint64 duration) external onlyStore returns (uint256 orderId) {
        if (buyer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0 || duration > MAX_ORDER_DURATION) revert InvalidDuration(duration);

        orderId = ++orderCount;
        uint64 expiresAt = uint64(block.timestamp) + duration;
        _orders[orderId] = Order({
            buyer: buyer,
            store: msg.sender,
            amount: amount,
            expiresAt: expiresAt,
            status: OrderStatus.Created,
            paidBgp: 0,
            paidPoints: 0,
            rewardPoints: 0
        });
        emit OrderCreated(orderId, msg.sender, buyer, amount, expiresAt);
    }

    /// @notice 결제 완료 주문에 대해 매장 적립률만큼 포인트를 한 번 적립해요.
    ///         매장이 같은 양의 tKRW를 재원으로 예치해야 해요. 사전에 tkrw.approve(this, reward) 필요.
    function awardPoints(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Paid) revert InvalidOrderStatus(orderId, o.status);
        if (o.rewardPoints != 0) revert AlreadyRewarded(orderId);

        uint256 reward = rewardFor(orderId);
        if (reward == 0) revert NoRewardForStore(msg.sender);

        // 재원 입금이 먼저 성공해야 적립돼요 (실패 시 전체 revert)
        tkrw.safeTransferFrom(msg.sender, address(this), reward);

        o.rewardPoints = reward;
        pointBalanceOf[o.buyer] += reward;
        totalPoints += reward;
        emit PointsAwarded(orderId, o.buyer, msg.sender, reward);
    }

    /// @notice 주문 전액 환불. 매장이 주문 금액만큼 tKRW를 반환하면
    ///         학생에게 사용한 BGP와 포인트를 각각 그대로 복구해요.
    ///         새 포인트가 적립된 주문은 이번 범위에서 환불하지 않아요.
    ///         사전에 tkrw.approve(this, amount) 필요.
    function refund(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Paid) revert InvalidOrderStatus(orderId, o.status);
        if (o.rewardPoints != 0) revert RewardedOrderNotRefundable(orderId);

        tkrw.safeTransferFrom(msg.sender, address(this), o.amount);

        o.status = OrderStatus.Refunded;
        if (o.paidBgp > 0) _mint(o.buyer, o.paidBgp);
        if (o.paidPoints > 0) {
            pointBalanceOf[o.buyer] += o.paidPoints;
            totalPoints += o.paidPoints;
        }
        emit OrderRefunded(orderId, o.buyer, msg.sender, o.paidBgp, o.paidPoints);
    }

    // ---------------------------------------------------------------------
    // 조회
    // ---------------------------------------------------------------------

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function getStores() external view returns (address[] memory) {
        return storeList;
    }

    /// @notice 결제 완료 주문의 예상 적립 포인트 (매장 적립률 기준)
    function rewardFor(uint256 orderId) public view returns (uint256) {
        Order storage o = _orders[orderId];
        return (o.amount * stores[o.store].rewardBps) / 10_000;
    }

    /// @notice 필요 재원 = BGP 총공급량 + 미사용 전체 포인트
    function requiredReserve() public view returns (uint256) {
        return totalSupply() + totalPoints;
    }

    /// @notice 실제 보관 중인 tKRW
    function reserveBalance() public view returns (uint256) {
        return tkrw.balanceOf(address(this));
    }

    function isFullyBacked() external view returns (bool) {
        return reserveBalance() >= requiredReserve();
    }
}
