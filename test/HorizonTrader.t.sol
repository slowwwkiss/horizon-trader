// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockERC20.sol";
import "../src/HorizonAMM.sol";
import "../src/PriceOracle.sol";
import "../src/TradingVault.sol";

/// @notice End-to-end tests for HorizonTrader (Track 1: AI Agent Trading).
/// @dev All scenarios run on a local EVM (forge). No live chain, no real funds.
contract HorizonTraderTest is Test {
    MockERC20 public mHSK;
    MockERC20 public mUSDC;
    HorizonAMMFactory public factory;
    HorizonAMMPair public pair;
    PriceOracle public oracle;
    TradingVault public vault;

    address public owner = address(this);
    address public agent = makeAddr("agent");
    address public keeper = makeAddr("keeper");

    uint256 constant ONE = 1e18;

    /// @notice Warp forward by `delta` seconds. NOTE: forge 1.10.1 evaluates
    /// `block.timestamp` STALE (1) when used inline inside vm.warp(...), so the
    /// timestamp must be read into a local first.
    function _warp(uint256 delta) internal {
        uint256 t = block.timestamp;
        vm.warp(t + delta);
    }

    function setUp() public {
        mHSK = new MockERC20("Mock HSK", "mHSK");
        mUSDC = new MockERC20("Mock USDC", "mUSDC");
        factory = new HorizonAMMFactory();
        address pairAddr = factory.createPair(address(mHSK), address(mUSDC));
        pair = HorizonAMMPair(pairAddr);
        oracle = new PriceOracle(pairAddr);
        vault = new TradingVault(address(mHSK), address(mUSDC), pairAddr, address(oracle), agent);

        // Seed AMM: 1000 mHSK + 2000 mUSDC -> spot price 1 mHSK = 2 mUSDC.
        mHSK.mint(owner, 100_000 * ONE);
        mUSDC.mint(owner, 100_000 * ONE);
        mHSK.transfer(address(pair), 1000 * ONE);
        mUSDC.transfer(address(pair), 2000 * ONE);
        pair.mint(owner);

        // Fund the vault: 500 mUSDC + 50 mHSK (value ~600 mUSDC at price 2).
        mHSK.approve(address(vault), type(uint256).max);
        mUSDC.approve(address(vault), type(uint256).max);
        vault.deposit(50 * ONE, 500 * ONE);

        // First TWAP observation.
        oracle.update();
    }

    function _baseIsToken0() internal view returns (bool) {
        return pair.token0() == address(mHSK);
    }

    // ---------- AMM ----------

    function testAMM_SpotPrice() public view {
        assertEq(pair.spotPrice0(), _baseIsToken0() ? 2 * ONE : ONE / 2, "spot0");
        assertEq(pair.spotPrice1(), _baseIsToken0() ? ONE / 2 : 2 * ONE, "spot1");
    }

    function testAMM_Swap() public {
        uint256 out = pair.getAmountOut(100 * ONE, 2000 * ONE, 1000 * ONE);
        assertGt(out, 0, "amountOut > 0");
        // 100 mUSDC in -> ~47.6 mHSK out (fee + slippage).
        assertApproxEqAbs(out, (476 * ONE) / 10, 1 * ONE, "swap output");

        // Execute the swap directly (owner sends mUSDC to the pair first).
        uint256 balBefore = mHSK.balanceOf(owner);
        address token0 = pair.token0();
        bool usdcIs0 = token0 == address(mUSDC);
        mUSDC.transfer(address(pair), 100 * ONE);
        if (usdcIs0) pair.swap(0, out, owner);
        else pair.swap(out, 0, owner);
        assertEq(mHSK.balanceOf(owner), balBefore + out, "received exact mHSK output");
    }

    function testAMM_TwapCumulativeGrows() public {
        uint256 before = pair.price0CumulativeLast();
        _warp(600);
        // Any interaction updates the cumulative price.
        mUSDC.transfer(address(pair), 1 * ONE);
        pair.sync();
        assertGt(pair.price0CumulativeLast(), before, "cumulative grows with time");
    }

    // ---------- Oracle ----------

    function testOracle_ConsultFallsBackToSpot() public view {
        // Only 1 observation (from setUp) -> consult returns ~spot.
        uint256 twap = oracle.consult(address(mHSK), ONE, 600);
        assertApproxEqAbs(twap, 2 * ONE, ONE / 20, "twap ~ spot");
    }

    function testOracle_TwapLagsSpotAfterCrash() public {
        // 600s pass at the old price so there is real TWAP history.
        _warp(600);
        oracle.update();

        // Crash the price ~30% by dumping 200 mHSK into the pool.
        mHSK.transfer(address(pair), 200 * ONE);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        uint256 out = pair.getAmountOut(200 * ONE, token0 == address(mHSK) ? uint256(r0) : uint256(r1), token0 == address(mHSK) ? uint256(r1) : uint256(r0));
        if (token0 == address(mHSK)) pair.swap(0, out, owner);
        else pair.swap(out, 0, owner);

        uint256 spotAfter = oracle.spotConsult(address(mHSK), ONE);
        assertLt(spotAfter, (15 * ONE) / 10, "spot crashed below 1.5");

        // TWAP over 600s still reflects the OLD price (lags spot).
        uint256 twapBefore = oracle.consult(address(mHSK), ONE, 600);
        assertApproxEqAbs(twapBefore, 2 * ONE, ONE / 10, "twap lags spot");

        // Record the post-crash observation, then 600s pass at the crashed price.
        oracle.update();
        _warp(600);
        oracle.update();
        uint256 twapAfter = oracle.consult(address(mHSK), ONE, 600);
        assertApproxEqAbs(twapAfter, spotAfter, ONE / 10, "twap catches up");
    }

    // ---------- Vault: happy path ----------

    function testVault_BuyAndSell() public {
        vm.prank(agent);
        vault.executeTrade(true, 100 * ONE, 40 * ONE); // buy ~49 mHSK with 100 mUSDC
        (uint256 pos, uint256 entry,) = vault.getPosition();
        assertGt(pos, 40 * ONE, "position opened");
        assertApproxEqAbs(entry, 2 * ONE, ONE / 5, "entry ~2");

        _warp(61); // cooldown
        vm.prank(agent);
        vault.executeTrade(false, pos / 2, 40 * ONE); // sell half
        (uint256 pos2,,) = vault.getPosition();
        assertApproxEqAbs(pos2, pos / 2, 1e15, "position halved");
        assertEq(vault.totalTrades(), 2, "two trades");
    }

    function testVault_OnlyAgent() public {
        vm.expectRevert("ONLY_AGENT");
        vault.executeTrade(true, 10 * ONE, 1);
    }

    function testVault_TradeTooBig() public {
        // Vault value ~600; max trade 20% = 120. 200 mUSDC is too big.
        vm.prank(agent);
        vm.expectRevert("TRADE_TOO_BIG");
        vault.executeTrade(true, 200 * ONE, 1);
    }

    function testVault_Cooldown() public {
        vm.prank(agent);
        vault.executeTrade(true, 50 * ONE, 20 * ONE);
        vm.prank(agent);
        vm.expectRevert("COOLDOWN");
        vault.executeTrade(true, 50 * ONE, 20 * ONE);
    }

    function testVault_Pause() public {
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert("PAUSED");
        vault.executeTrade(true, 10 * ONE, 1);
    }

    // ---------- Vault: stop-loss ----------

    function testVault_StopLoss() public {
        // Agent opens a long: 100 mUSDC -> ~49 mHSK @ ~2.0.
        vm.prank(agent);
        vault.executeTrade(true, 100 * ONE, 40 * ONE);
        (, uint256 entry,) = vault.getPosition();
        assertApproxEqAbs(entry, 2 * ONE, ONE / 5, "entry ~2");

        // 600s pass at the entry price so there is real TWAP history.
        _warp(600);
        oracle.update();

        // Crash the market ~30%: dump 200 mHSK into the pool.
        mHSK.transfer(address(pair), 200 * ONE);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        uint256 out = pair.getAmountOut(
            200 * ONE,
            token0 == address(mHSK) ? uint256(r0) : uint256(r1),
            token0 == address(mHSK) ? uint256(r1) : uint256(r0)
        );
        if (token0 == address(mHSK)) pair.swap(0, out, owner);
        else pair.swap(out, 0, owner);

        // Stop-loss must NOT trigger yet: TWAP still ~2.0 (lags spot).
        vm.expectRevert("STOP_NOT_HIT");
        vm.prank(keeper);
        vault.forceStopLoss();

        // Record the post-crash observation; 600s pass at the crashed price.
        // TWAP catches up below the stop level.
        oracle.update();
        _warp(600);
        oracle.update();
        uint256 twap = vault.twapPrice();
        assertLt(twap, (entry * 95) / 100, "twap below stop level");

        // Anyone (keeper) can now trigger the stop-loss exit.
        vm.prank(keeper);
        vault.forceStopLoss();
        (uint256 pos,,) = vault.getPosition();
        assertEq(pos, 0, "position closed by stop-loss");
        assertLt(vault.realizedPnl(), 0, "realized loss recorded");
    }

    // ---------- Vault: circuit breaker ----------

    function testVault_CircuitBreaker() public {
        vm.prank(agent);
        vault.executeTrade(true, 100 * ONE, 40 * ONE); // long ~49 mHSK

        // Crash ~50% (dump 400 mHSK) -> vault value falls >10% for the day.
        mHSK.transfer(address(pair), 400 * ONE);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        uint256 out = pair.getAmountOut(
            400 * ONE,
            token0 == address(mHSK) ? uint256(r0) : uint256(r1),
            token0 == address(mHSK) ? uint256(r1) : uint256(r0)
        );
        if (token0 == address(mHSK)) pair.swap(0, out, owner);
        else pair.swap(out, 0, owner);

        assertTrue(vault.dailyLossBreached(), "daily loss breached");
        vault.tripCircuitBreaker(); // latch the breaker in a non-reverting call
        assertTrue(vault.circuitBroken(), "breaker tripped");
        _warp(61);
        vm.prank(agent);
        vm.expectRevert("CIRCUIT_BROKEN");
        vault.executeTrade(true, 10 * ONE, 1);
    }

    function testVault_BreakerResetsNextDay() public {
        // Trip the breaker (same setup as above), then move to the next day.
        vm.prank(agent);
        vault.executeTrade(true, 100 * ONE, 40 * ONE);
        mHSK.transfer(address(pair), 400 * ONE);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        uint256 out = pair.getAmountOut(
            400 * ONE,
            token0 == address(mHSK) ? uint256(r0) : uint256(r1),
            token0 == address(mHSK) ? uint256(r1) : uint256(r0)
        );
        if (token0 == address(mHSK)) pair.swap(0, out, owner);
        else pair.swap(out, 0, owner);
        _warp(61);
        vm.prank(agent);
        vm.expectRevert("CIRCUIT_BREAKER");
        vault.executeTrade(true, 10 * ONE, 1);

        // Next day: a fresh trade is allowed again (day rolled, breaker reset).
        _warp(1 days);
        vm.prank(agent);
        vault.executeTrade(false, 10 * ONE, 1); // small sell to prove trading works
        assertFalse(vault.circuitBroken(), "breaker reset next day");
    }
}
