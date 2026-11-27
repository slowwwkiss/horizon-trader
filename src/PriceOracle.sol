// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HorizonAMMPair} from "./HorizonAMM.sol";

/// @title PriceOracle — TWAP reader over HorizonAMM cumulative prices.
/// @notice Anyone can push observations. consult() falls back to spot price
///         when there is not enough TWAP history yet (e.g. right after deploy).
contract PriceOracle {
    struct Observation {
        uint32 timestamp;
        uint256 price0Cumulative;
        uint256 price1Cumulative;
    }

    Observation[] public observations;
    address public immutable pair;

    event ObservationRecorded(uint32 timestamp, uint256 price0Cumulative, uint256 price1Cumulative);

    constructor(address _pair) {
        pair = _pair;
    }

    function observationsLength() external view returns (uint256) {
        return observations.length;
    }

    /// @notice Current cumulative prices, including time elapsed since the pair's last update.
    function currentCumulative()
        public
        view
        returns (uint256 price0Cumulative, uint256 price1Cumulative, uint32 blockTimestamp)
    {
        blockTimestamp = uint32(block.timestamp % 2 ** 32);
        price0Cumulative = HorizonAMMPair(pair).price0CumulativeLast();
        price1Cumulative = HorizonAMMPair(pair).price1CumulativeLast();
        (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) = HorizonAMMPair(pair)
            .getReserves();
        if (blockTimestampLast != blockTimestamp) {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (reserve0 != 0 && reserve1 != 0) {
                // UQ112x112(price) * timeElapsed
                price0Cumulative += (uint256(reserve1) << 112) / reserve0 * timeElapsed;
                price1Cumulative += (uint256(reserve0) << 112) / reserve1 * timeElapsed;
            }
        }
    }

    function update() external {
        (uint256 p0, uint256 p1, uint32 ts) = currentCumulative();
        observations.push(Observation(ts, p0, p1));
        emit ObservationRecorded(ts, p0, p1);
    }

    /// @notice TWAP price of token0 in terms of token1 over `windowSeconds`, scaled by 1e18.
    function twapPrice0(uint256 windowSeconds) public view returns (uint256) {
        uint256 len = observations.length;
        if (len == 0) return HorizonAMMPair(pair).spotPrice0();
        (uint256 cumNow0,, uint32 tsNow) = currentCumulative();
        // Oldest observation at least `windowSeconds` old; fallback to the oldest we have.
        Observation memory oldest = observations[0];
        for (uint256 i = len; i > 0; i--) {
            Observation memory obs = observations[i - 1];
            if (tsNow - obs.timestamp >= windowSeconds) {
                oldest = obs;
                break;
            }
            if (i - 1 == 0) oldest = obs;
        }
        uint256 timeElapsed = tsNow - oldest.timestamp;
        if (timeElapsed == 0) return HorizonAMMPair(pair).spotPrice0();
        uint256 avgUQ = (cumNow0 - oldest.price0Cumulative) / timeElapsed;
        return (avgUQ * 1e18) >> 112;
    }

    /// @notice TWAP price of token1 in terms of token0 over `windowSeconds`, scaled by 1e18.
    function twapPrice1(uint256 windowSeconds) public view returns (uint256) {
        uint256 len = observations.length;
        if (len == 0) return HorizonAMMPair(pair).spotPrice1();
        (, uint256 cumNow1, uint32 tsNow) = currentCumulative();
        Observation memory oldest = observations[0];
        for (uint256 i = len; i > 0; i--) {
            Observation memory obs = observations[i - 1];
            if (tsNow - obs.timestamp >= windowSeconds) {
                oldest = obs;
                break;
            }
            if (i - 1 == 0) oldest = obs;
        }
        uint256 timeElapsed = tsNow - oldest.timestamp;
        if (timeElapsed == 0) return HorizonAMMPair(pair).spotPrice1();
        uint256 avgUQ = (cumNow1 - oldest.price1Cumulative) / timeElapsed;
        return (avgUQ * 1e18) >> 112;
    }

    /// @notice TWAP quote-out for `amountIn` of `tokenIn` (Uniswap OracleLibrary-style).
    function consult(address tokenIn, uint256 amountIn, uint256 windowSeconds)
        external
        view
        returns (uint256 amountOut)
    {
        address token0 = HorizonAMMPair(pair).token0();
        if (tokenIn == token0) {
            amountOut = (amountIn * twapPrice0(windowSeconds)) / 1e18;
        } else {
            amountOut = (amountIn * twapPrice1(windowSeconds)) / 1e18;
        }
    }

    /// @notice Spot quote-out for `amountIn` of `tokenIn` (reserves, no TWAP).
    function spotConsult(address tokenIn, uint256 amountIn) external view returns (uint256) {
        address token0 = HorizonAMMPair(pair).token0();
        if (tokenIn == token0) {
            return (amountIn * HorizonAMMPair(pair).spotPrice0()) / 1e18;
        } else {
            return (amountIn * HorizonAMMPair(pair).spotPrice1()) / 1e18;
        }
    }
}
