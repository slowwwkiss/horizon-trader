// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HorizonAMMPair} from "./HorizonAMM.sol";
import {PriceOracle} from "./PriceOracle.sol";

interface IERC20Lite {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

/// @title TradingVault — on-chain risk enforcement for the HorizonTrader agent.
/// @notice Holds the agent's funds and enforces, on-chain (not just in the bot):
///         max trade size, daily-loss circuit breaker, stop-loss (keeper-callable),
///         trade cooldown, slippage guard, pause. The off-chain agent decides
///         WHAT to trade; the vault decides what is ALLOWED to trade.
/// @dev Long-only on the base asset (mHSK) quoted in mUSDC.
contract TradingVault {
    uint256 public constant BPS = 10000;

    address public owner;
    address public agent;
    address public immutable base; // e.g. mHSK
    address public immutable quote; // e.g. mUSDC
    HorizonAMMPair public immutable pair;
    PriceOracle public oracle;

    // Risk limits (bps unless noted)
    uint256 public maxTradeSizeBps = 2000; // 20% of vault value per trade
    uint256 public stopLossBps = 500; // 5% below entry
    uint256 public maxDailyLossBps = 1000; // 10% per day -> circuit breaker
    uint256 public slippageBps = 100; // 1%
    uint256 public minTradeInterval = 60; // seconds between trades
    uint256 public twapWindow = 600; // seconds for stop-loss TWAP

    bool public paused;
    bool public circuitBroken;
    uint256 public lastTradeAt;
    uint256 public dayStartValue;
    uint256 public currentDay; // block.timestamp / 1 days

    // Position (long-only base)
    uint256 public positionBase;
    uint256 public entryPrice; // quote per base, 1e18
    int256 public realizedPnl; // in quote
    uint256 public totalDepositedQuote;
    uint256 public totalTrades;

    event TradeExecuted(address indexed agent, bool buy, uint256 amountIn, uint256 amountOut, uint256 price);
    event StopLossTriggered(uint256 twapPrice, uint256 amountOut, int256 realizedPnl);
    event CircuitBreakerTripped(uint256 vaultValue, uint256 dayStartValue);
    event Deposit(address indexed from, uint256 baseAmount, uint256 quoteAmount);
    event Withdraw(address indexed to, uint256 baseAmount, uint256 quoteAmount);
    event LimitsUpdated(uint256 maxTradeSizeBps, uint256 stopLossBps, uint256 maxDailyLossBps, uint256 slippageBps);
    event AgentUpdated(address indexed agent);
    event Paused(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "ONLY_AGENT");
        _;
    }

    constructor(address _base, address _quote, address _pair, address _oracle, address _agent) {
        owner = msg.sender;
        base = _base;
        quote = _quote;
        pair = HorizonAMMPair(_pair);
        oracle = PriceOracle(_oracle);
        agent = _agent;
        currentDay = block.timestamp / 1 days;
    }

    // ---- Admin ----
    function setAgent(address _agent) external onlyOwner {
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    function setLimits(uint256 _maxTradeSizeBps, uint256 _stopLossBps, uint256 _maxDailyLossBps, uint256 _slippageBps)
        external
        onlyOwner
    {
        require(_maxTradeSizeBps <= BPS && _stopLossBps < BPS && _maxDailyLossBps < BPS, "BAD_LIMITS");
        maxTradeSizeBps = _maxTradeSizeBps;
        stopLossBps = _stopLossBps;
        maxDailyLossBps = _maxDailyLossBps;
        slippageBps = _slippageBps;
        emit LimitsUpdated(_maxTradeSizeBps, _stopLossBps, _maxDailyLossBps, _slippageBps);
    }

    function setMinTradeInterval(uint256 _seconds) external onlyOwner {
        minTradeInterval = _seconds;
    }

    function setTwapWindow(uint256 _seconds) external onlyOwner {
        twapWindow = _seconds;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = PriceOracle(_oracle);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    // ---- Funding ----
    function deposit(uint256 baseAmount, uint256 quoteAmount) external onlyOwner {
        if (baseAmount > 0) {
            require(IERC20Lite(base).transferFrom(msg.sender, address(this), baseAmount), "DEPOSIT_BASE");
        }
        if (quoteAmount > 0) {
            require(IERC20Lite(quote).transferFrom(msg.sender, address(this), quoteAmount), "DEPOSIT_QUOTE");
            totalDepositedQuote += quoteAmount;
        }
        if (dayStartValue == 0) dayStartValue = vaultValue();
        emit Deposit(msg.sender, baseAmount, quoteAmount);
    }

    function withdraw(uint256 baseAmount, uint256 quoteAmount) external onlyOwner {
        if (baseAmount > 0) require(IERC20Lite(base).transfer(msg.sender, baseAmount), "WITHDRAW_BASE");
        if (quoteAmount > 0) require(IERC20Lite(quote).transfer(msg.sender, quoteAmount), "WITHDRAW_QUOTE");
        emit Withdraw(msg.sender, baseAmount, quoteAmount);
    }

    // ---- Views ----
    function baseBalance() public view returns (uint256) {
        return IERC20Lite(base).balanceOf(address(this));
    }

    function quoteBalance() public view returns (uint256) {
        return IERC20Lite(quote).balanceOf(address(this));
    }

    /// @notice Spot price of base in quote, 1e18.
    function basePrice() public view returns (uint256) {
        return oracle.spotConsult(base, 1e18);
    }

    /// @notice TWAP price of base in quote, 1e18.
    function twapPrice() public view returns (uint256) {
        return oracle.consult(base, 1e18, twapWindow);
    }

    function vaultValue() public view returns (uint256) {
        return quoteBalance() + (baseBalance() * basePrice()) / 1e18;
    }

    function getPosition()
        external
        view
        returns (uint256 _positionBase, uint256 _entryPrice, int256 _unrealizedPnl)
    {
        _positionBase = positionBase;
        _entryPrice = entryPrice;
        if (positionBase > 0) {
            uint256 current = basePrice();
            _unrealizedPnl =
                (int256(positionBase * current) - int256(positionBase * entryPrice)) /
                int256(1e18);
        }
    }

    /// @notice True when the vault has lost more than maxDailyLossBps since the day started.
    function dailyLossBreached() public view returns (bool) {
        if (dayStartValue == 0) return false;
        return vaultValue() * BPS < dayStartValue * (BPS - maxDailyLossBps);
    }

    // ---- Trading ----
    function _rollDayIfNeeded() internal {
        uint256 day = block.timestamp / 1 days;
        if (day != currentDay) {
            currentDay = day;
            dayStartValue = vaultValue();
            circuitBroken = false;
        }
    }

    function _checkTradeAllowed(uint256 amountInValue) internal {
        _rollDayIfNeeded();
        require(!paused, "PAUSED");
        require(!circuitBroken, "CIRCUIT_BROKEN");
        require(lastTradeAt == 0 || block.timestamp >= lastTradeAt + minTradeInterval, "COOLDOWN");
        // NOTE: do NOT set circuitBroken here — a revert rolls back the whole
        // tx, so the flag would never persist. Latching is done by
        // tripCircuitBreaker() in a separate, non-reverting call.
        if (dailyLossBreached()) {
            revert("CIRCUIT_BREAKER");
        }
        require(amountInValue <= (vaultValue() * maxTradeSizeBps) / BPS, "TRADE_TOO_BIG");
    }

    /// @notice Latch the circuit breaker once the daily loss is breached.
    /// Permissionless (safety function): anyone — agent, keeper, or owner —
    /// may call it. Trading stays blocked until the next day rolls over.
    function tripCircuitBreaker() external {
        _rollDayIfNeeded();
        require(dailyLossBreached(), "NOT_BREACHED");
        circuitBroken = true;
        emit CircuitBreakerTripped(vaultValue(), dayStartValue);
    }

    /// @notice Agent trade. buy=true: spend quote to buy base. buy=false: sell base for quote.
    /// @param amountIn Amount of the input token (quote when buying, base when selling).
    /// @param minAmountOut Slippage guard (reverts if the AMM gives less).
    function executeTrade(bool buy, uint256 amountIn, uint256 minAmountOut) external onlyAgent {
        address tokenIn = buy ? quote : base;
        address tokenOut = buy ? base : quote;
        uint256 amountInValue = buy ? amountIn : (amountIn * basePrice()) / 1e18;
        _checkTradeAllowed(amountInValue);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        address token0 = pair.token0();
        (uint256 reserveIn, uint256 reserveOut) = tokenIn == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
        uint256 amountOut = pair.getAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut >= minAmountOut, "SLIPPAGE");

        if (!buy) require(amountIn <= positionBase, "EXCEEDS_POSITION");

        uint256 price = (amountIn * 1e18) / amountOut; // quote per base (buy) — for sell, invert below
        if (!buy) price = (amountOut * 1e18) / amountIn;

        require(IERC20Lite(tokenIn).transfer(address(pair), amountIn), "TRANSFER_IN");
        (uint256 amount0Out, uint256 amount1Out) = tokenOut == token0
            ? (amountOut, uint256(0))
            : (uint256(0), amountOut);
        pair.swap(amount0Out, amount1Out, address(this));

        if (buy) {
            uint256 newPosition = positionBase + amountOut;
            entryPrice = positionBase == 0
                ? price
                : (positionBase * entryPrice + amountOut * price) / newPosition;
            positionBase = newPosition;
        } else {
            int256 cost = int256((amountIn * entryPrice) / 1e18);
            realizedPnl += int256(amountOut) - cost;
            positionBase -= amountIn;
            if (positionBase == 0) entryPrice = 0;
        }

        lastTradeAt = block.timestamp;
        totalTrades += 1;
        emit TradeExecuted(msg.sender, buy, amountIn, amountOut, price);
    }

    /// @notice Keeper-callable stop-loss: sells the whole position when TWAP <= entry * (1 - stopLoss).
    /// @dev Anyone can call it — the vault protects the owner even if the agent is offline.
    function forceStopLoss() external {
        require(positionBase > 0, "NO_POSITION");
        uint256 twap = twapPrice();
        require(twap <= (entryPrice * (BPS - stopLossBps)) / BPS, "STOP_NOT_HIT");
        _rollDayIfNeeded();
        require(!paused, "PAUSED");

        uint256 amountIn = positionBase;
        address token0 = pair.token0();
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 reserveIn, uint256 reserveOut) = base == token0
            ? (uint256(r0), uint256(r1))
            : (uint256(r1), uint256(r0));
        uint256 amountOut = pair.getAmountOut(amountIn, reserveIn, reserveOut);
        uint256 minOut = (amountOut * (BPS - slippageBps)) / BPS;

        uint256 quoteBefore = IERC20Lite(quote).balanceOf(address(this));

        int256 cost = int256((amountIn * entryPrice) / 1e18);
        realizedPnl += int256(amountOut) - cost;
        positionBase = 0;
        entryPrice = 0;

        require(IERC20Lite(base).transfer(address(pair), amountIn), "TRANSFER_IN");
        (uint256 amount0Out, uint256 amount1Out) = quote == token0
            ? (amountOut, uint256(0))
            : (uint256(0), amountOut);
        pair.swap(amount0Out, amount1Out, address(this));
        require(IERC20Lite(quote).balanceOf(address(this)) - quoteBefore >= minOut, "SLIPPAGE");

        lastTradeAt = block.timestamp;
        totalTrades += 1;
        emit StopLossTriggered(twap, amountOut, realizedPnl);
    }
}
