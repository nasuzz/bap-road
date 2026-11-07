// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev 테스트 전용. failTransfers를 켜면 transfer()가 revert 대신 false를 반환해요.
///      "매장 지급 토큰 전송 실패" 시 BabgilPoint가 전체 거래를 되돌리는지 확인하는 데 써요.
contract FailingToken is ERC20 {
    bool public failTransfers;

    constructor() ERC20("Failing KRW", "fKRW") {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFailTransfers(bool v) external {
        failTransfers = v;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, value);
    }
}
