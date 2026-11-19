// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title 밥길 포인트 (BGP 결제 토큰 + 적립 포인트 + 메뉴 주문 / 정산)
/// @notice
///  - BGP: 학생이 tKRW를 예치하면 1:1로 발행되는 결제용 ERC-20
///  - 포인트: 혜택 매장이 tKRW를 부담해 적립해 주는 별도 온체인 잔액 (양도 / 현금 반환 불가)
///  - 주문 흐름 (배달앱 방식):
///      1) 매장이 메뉴와 가격을 등록
///      2) 학생이 메뉴를 골라 주문 → 컨트랙트가 금액을 계산하고, 결제한 BGP와 포인트를 금고에 잡아둠
///      3) 매장이 접수하면 매장에 tKRW 지급 / 거절하거나 접수 시간이 지나면 학생에게 그대로 돌려줌
///  - 적립은 BGP로 결제한 금액 기준이에요. (포인트로 낸 금액에는 다시 적립하지 않음)
///
///  불변식: tKRW 보관액 >= BGP 총공급량 + 전체 포인트 (잡아둔 포인트 포함)
///  운영자는 매장 등록만 할 수 있어요. 임의 발행 / 금고 인출 / 업그레이드 기능은 없어요.
contract BabgilPoint is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // 타입 / 상태
    // ---------------------------------------------------------------------

    enum OrderStatus {
        None, // 존재하지 않는 주문
        Placed, // 학생이 주문·결제, 매장 접수 대기 (돈은 금고에 잡혀 있음)
        Accepted, // 매장 접수 → 매장에 지급 완료
        Rejected, // 매장 거절 → 학생에게 돌려줌
        Cancelled, // 학생 취소 또는 접수 시간 초과 → 학생에게 돌려줌
        Refunded // 접수 후 매장이 환불
    }

    struct Store {
        bool registered;
        uint16 rewardBps; // 적립률 (500 = 5%). 0이면 적립 없음
        string name;
    }

    struct MenuItem {
        string name;
        uint256 price;
        bool available; // 판매 중 여부
    }

    struct OrderLine {
        uint32 itemId;
        uint32 quantity;
        uint256 unitPrice; // 주문 시점 가격
    }

    struct Order {
        address buyer;
        address store;
        uint256 amount; // 메뉴 가격으로 계산한 주문 금액
        uint64 placedAt;
        uint64 acceptDeadline; // 이 시각까지 매장이 접수해야 해요
        OrderStatus status;
        uint256 paidBgp; // 결제에 쓴 BGP
        uint256 paidPoints; // 결제에 쓴 포인트
        uint256 rewardPoints; // 이 주문으로 적립된 포인트 (0이면 미적립)
    }

    uint16 public constant MAX_REWARD_BPS = 2_000; // 적립률 상한 20%
    uint64 public constant ACCEPT_WINDOW = 30 minutes; // 매장 접수 제한 시간
    uint256 public constant MAX_MENU_ITEMS = 50;
    uint256 public constant MAX_ORDER_LINES = 20;
    uint256 public constant MAX_QUANTITY = 100; // 한 메뉴 최대 수량

    IERC20 public immutable tkrw;

    mapping(address => Store) public stores;
    address[] public storeList;
    mapping(address => MenuItem[]) private _menus;

    mapping(uint256 => Order) private _orders;
    mapping(uint256 => OrderLine[]) private _orderLines;
    uint256 public orderCount; // 주문 ID는 1부터 시작

    mapping(address => uint256) public pointBalanceOf;
    /// @dev 학생 보유 포인트 + 접수 대기 주문에 잡아둔 포인트
    uint256 public totalPoints;

    // ---------------------------------------------------------------------
    // 이벤트 / 에러
    // ---------------------------------------------------------------------

    event StoreAdded(address indexed store, string name, uint16 rewardBps);
    event MenuItemAdded(address indexed store, uint256 indexed itemId, string name, uint256 price);
    event MenuItemUpdated(address indexed store, uint256 indexed itemId, uint256 price, bool available);
    event Deposited(address indexed student, uint256 amount);
    event Redeemed(address indexed student, uint256 amount);
    event OrderPlaced(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 amount, uint256 bgpUsed, uint256 pointsUsed);
    event OrderAccepted(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 amount);
    event OrderRejected(uint256 indexed orderId, address indexed buyer, address indexed store);
    event OrderCancelled(uint256 indexed orderId, address indexed buyer, address indexed store, address by);
    event PointsAwarded(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 points);
    event OrderRefunded(uint256 indexed orderId, address indexed buyer, address indexed store, uint256 bgpRestored, uint256 pointsRestored);

    error ZeroAddress();
    error ZeroAmount();
    error EmptyName();
    error AlreadyRegistered(address store);
    error InvalidRewardRate(uint16 rewardBps);
    error NotRegisteredStore(address account);
    error MenuFull(address store);
    error InvalidMenuItem(uint256 itemId);
    error MenuItemUnavailable(uint256 itemId);
    error EmptyOrder();
    error TooManyLines(uint256 lines);
    error LengthMismatch();
    error InvalidQuantity(uint256 itemId, uint256 quantity);
    error NotOrderStore(uint256 orderId, address caller);
    error NotOrderBuyer(uint256 orderId, address caller);
    error InvalidOrderStatus(uint256 orderId, OrderStatus status);
    error AcceptWindowClosed(uint256 orderId, uint64 deadline);
    error PointsExceedAmount(uint256 points, uint256 amount);
    error InsufficientPoints(uint256 requested, uint256 available);
    error AlreadyRewarded(uint256 orderId);
    error NoReward(uint256 orderId);
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
        if (bytes(name).length == 0) revert EmptyName();
        if (stores[store].registered) revert AlreadyRegistered(store);
        if (rewardBps > MAX_REWARD_BPS) revert InvalidRewardRate(rewardBps);

        stores[store] = Store({registered: true, rewardBps: rewardBps, name: name});
        storeList.push(store);
        emit StoreAdded(store, name, rewardBps);
    }

    // ---------------------------------------------------------------------
    // 매장: 메뉴
    // ---------------------------------------------------------------------

    modifier onlyStore() {
        if (!stores[msg.sender].registered) revert NotRegisteredStore(msg.sender);
        _;
    }

    /// @notice 메뉴 추가. 메뉴 번호(itemId)는 0부터 차례로 붙어요.
    function addMenuItem(string calldata name, uint256 price) external onlyStore returns (uint256 itemId) {
        if (bytes(name).length == 0) revert EmptyName();
        if (price == 0) revert ZeroAmount();
        MenuItem[] storage menu = _menus[msg.sender];
        if (menu.length >= MAX_MENU_ITEMS) revert MenuFull(msg.sender);

        itemId = menu.length;
        menu.push(MenuItem({name: name, price: price, available: true}));
        emit MenuItemAdded(msg.sender, itemId, name, price);
    }

    /// @notice 가격 변경 / 판매 중지·재개. 이미 들어온 주문 금액은 바뀌지 않아요.
    function updateMenuItem(uint256 itemId, uint256 price, bool available) external onlyStore {
        MenuItem[] storage menu = _menus[msg.sender];
        if (itemId >= menu.length) revert InvalidMenuItem(itemId);
        if (price == 0) revert ZeroAmount();

        menu[itemId].price = price;
        menu[itemId].available = available;
        emit MenuItemUpdated(msg.sender, itemId, price, available);
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

    /// @notice 미사용 BGP를 소각하고 같은 수량의 tKRW를 돌려받아요. 포인트는 반환 대상이 아니에요.
    function redeem(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        tkrw.safeTransfer(msg.sender, amount);
        emit Redeemed(msg.sender, amount);
    }

    /// @notice 메뉴를 골라 주문하고 바로 결제해요.
    ///         금액은 컨트랙트가 메뉴 가격으로 계산하고, 결제한 BGP와 포인트는
    ///         매장이 접수할 때까지 금고에 잡아둬요. (BGP 승인 불필요)
    /// @param itemIds 메뉴 번호 목록
    /// @param quantities 각 메뉴 수량
    /// @param pointsToUse 사용할 포인트 (0 ~ min(주문 금액, 보유 포인트)), 나머지는 BGP
    function placeOrder(
        address store,
        uint256[] calldata itemIds,
        uint256[] calldata quantities,
        uint256 pointsToUse
    ) external nonReentrant returns (uint256 orderId) {
        if (!stores[store].registered) revert NotRegisteredStore(store);
        if (itemIds.length == 0) revert EmptyOrder();
        if (itemIds.length > MAX_ORDER_LINES) revert TooManyLines(itemIds.length);
        if (itemIds.length != quantities.length) revert LengthMismatch();

        orderId = ++orderCount;
        MenuItem[] storage menu = _menus[store];
        OrderLine[] storage lines = _orderLines[orderId];
        uint256 amount;
        for (uint256 i = 0; i < itemIds.length; i++) {
            uint256 itemId = itemIds[i];
            if (itemId >= menu.length) revert InvalidMenuItem(itemId);
            MenuItem storage item = menu[itemId];
            if (!item.available) revert MenuItemUnavailable(itemId);
            uint256 qty = quantities[i];
            if (qty == 0 || qty > MAX_QUANTITY) revert InvalidQuantity(itemId, qty);
            amount += item.price * qty;
            lines.push(OrderLine({itemId: uint32(itemId), quantity: uint32(qty), unitPrice: item.price}));
        }

        if (pointsToUse > amount) revert PointsExceedAmount(pointsToUse, amount);
        uint256 available = pointBalanceOf[msg.sender];
        if (pointsToUse > available) revert InsufficientPoints(pointsToUse, available);
        uint256 bgpToUse = amount - pointsToUse;

        _orders[orderId] = Order({
            buyer: msg.sender,
            store: store,
            amount: amount,
            placedAt: uint64(block.timestamp),
            acceptDeadline: uint64(block.timestamp) + ACCEPT_WINDOW,
            status: OrderStatus.Placed,
            paidBgp: bgpToUse,
            paidPoints: pointsToUse,
            rewardPoints: 0
        });

        // 포인트는 학생 잔액에서 빼서 주문에 잡아둬요 (totalPoints는 그대로)
        pointBalanceOf[msg.sender] = available - pointsToUse;
        // BGP는 금고(컨트랙트)로 옮겨 잡아둬요. 잔액이 부족하면 전체 revert
        if (bgpToUse > 0) _transfer(msg.sender, address(this), bgpToUse);

        emit OrderPlaced(orderId, msg.sender, store, amount, bgpToUse, pointsToUse);
    }

    /// @notice 접수 전 주문 취소. 학생은 언제든, 다른 사람은 접수 시간이 지난 뒤에만 할 수 있어요.
    ///         잡아둔 BGP와 포인트를 학생에게 그대로 돌려줘요.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Placed) revert InvalidOrderStatus(orderId, o.status);
        if (msg.sender != o.buyer && block.timestamp <= o.acceptDeadline) revert NotOrderBuyer(orderId, msg.sender);

        o.status = OrderStatus.Cancelled;
        _release(o);
        emit OrderCancelled(orderId, o.buyer, o.store, msg.sender);
    }

    // ---------------------------------------------------------------------
    // 매장: 주문 처리
    // ---------------------------------------------------------------------

    /// @notice 주문 접수. 잡아둔 BGP를 소각하고, 금고에서 주문 금액 전액을 매장에 지급해요.
    ///         포인트 차감 / BGP 소각 / 매장 지급이 한 거래로 처리되고, 하나라도 실패하면 전부 되돌아가요.
    function acceptOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Placed) revert InvalidOrderStatus(orderId, o.status);
        if (block.timestamp > o.acceptDeadline) revert AcceptWindowClosed(orderId, o.acceptDeadline);

        o.status = OrderStatus.Accepted;
        totalPoints -= o.paidPoints;
        if (o.paidBgp > 0) _burn(address(this), o.paidBgp);

        tkrw.safeTransfer(o.store, o.amount);
        emit OrderAccepted(orderId, o.buyer, o.store, o.amount);
    }

    /// @notice 주문 거절. 잡아둔 BGP와 포인트를 학생에게 그대로 돌려줘요.
    function rejectOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Placed) revert InvalidOrderStatus(orderId, o.status);

        o.status = OrderStatus.Rejected;
        _release(o);
        emit OrderRejected(orderId, o.buyer, o.store);
    }

    /// @notice 접수한 주문에 대해 BGP 결제 금액 기준으로 포인트를 한 번 적립해요.
    ///         매장이 같은 양의 tKRW를 금고에 넣어야 해요. 사전에 tkrw.approve(this, reward) 필요.
    function awardPoints(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Accepted) revert InvalidOrderStatus(orderId, o.status);
        if (o.rewardPoints != 0) revert AlreadyRewarded(orderId);

        uint256 reward = rewardFor(orderId);
        if (reward == 0) revert NoReward(orderId);

        // 금고 입금이 먼저 성공해야 적립돼요 (실패 시 전체 revert)
        tkrw.safeTransferFrom(msg.sender, address(this), reward);

        o.rewardPoints = reward;
        pointBalanceOf[o.buyer] += reward;
        totalPoints += reward;
        emit PointsAwarded(orderId, o.buyer, msg.sender, reward);
    }

    /// @notice 접수한 주문 전액 환불. 매장이 주문 금액만큼 tKRW를 반환하면
    ///         학생에게 사용한 BGP와 포인트를 각각 그대로 복구해요.
    ///         새 포인트가 적립된 주문은 환불하지 않아요. 사전에 tkrw.approve(this, amount) 필요.
    function refund(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (msg.sender != o.store) revert NotOrderStore(orderId, msg.sender);
        if (o.status != OrderStatus.Accepted) revert InvalidOrderStatus(orderId, o.status);
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

    /// @dev 잡아둔 BGP / 포인트를 학생에게 돌려줘요. (금고 tKRW와 totalPoints는 그대로)
    function _release(Order storage o) private {
        if (o.paidBgp > 0) _transfer(address(this), o.buyer, o.paidBgp);
        if (o.paidPoints > 0) pointBalanceOf[o.buyer] += o.paidPoints;
    }

    // ---------------------------------------------------------------------
    // 조회
    // ---------------------------------------------------------------------

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function getOrderLines(uint256 orderId) external view returns (OrderLine[] memory) {
        return _orderLines[orderId];
    }

    function getMenu(address store) external view returns (MenuItem[] memory) {
        return _menus[store];
    }

    function getStores() external view returns (address[] memory) {
        return storeList;
    }

    /// @notice 주문의 예상 적립 포인트 = BGP 결제 금액 × 매장 적립률
    function rewardFor(uint256 orderId) public view returns (uint256) {
        Order storage o = _orders[orderId];
        return (o.paidBgp * stores[o.store].rewardBps) / 10_000;
    }

    /// @notice 금고에 있어야 할 tKRW = BGP 총공급량 + 전체 포인트
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
