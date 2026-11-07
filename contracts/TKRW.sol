// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title tKRW - 시연용 테스트 원화 토큰
/// @notice 실제 원화가 아닌 테스트용 ERC-20이에요. 누구나 faucet()으로 받을 수 있어요.
///         "재원 없는 발행 금지" 규칙은 BGP / 포인트에 대한 것이고, tKRW는 시연 재원 역할만 해요.
contract TKRW is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 50_000;

    constructor() ERC20("Test KRW", "tKRW") {}

    /// @dev 1 tKRW = 1원으로 보이도록 소수점 없이 사용해요.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
