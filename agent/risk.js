// risk.js — pre-trade risk checks mirroring the on-chain TradingVault limits.
// Pure functions, unit-testable. All money values are plain JS numbers
// (quote-token units, e.g. mUSDC) unless noted.

export const BPS = 10000;

/// Mirror of TradingVault.dailyLossBreached().
export function dailyLossBreached(vault) {
  return vault.vaultValue * BPS < vault.dayStartValue * (BPS - vault.maxDailyLossBps);
}

/// Stop-loss: TWAP fell to entry * (1 - stopLossBps) or below.
/// Mirrors TradingVault.forceStopLoss, which triggers on the on-chain TWAP —
/// spot is too noisy for a stop that sells the whole position.
export function stopLossTriggered({ positionBase, entryPrice, twapPrice, stopLossBps }) {
  if (positionBase <= 0 || entryPrice <= 0 || twapPrice <= 0) return false;
  return twapPrice <= entryPrice * (1 - stopLossBps / BPS);
}

/// Constant-product price impact for a swap (0.3% fee), in bps.
export function estimateSlippage(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0 || reserveIn <= 0 || reserveOut <= 0) return { out: 0, impactBps: 0 };
  const amountInWithFee = amountIn * 997;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000 + amountInWithFee;
  const out = numerator / denominator;
  const spotOut = (amountIn * reserveOut) / reserveIn;
  const impactBps = spotOut > 0 ? Math.round(((spotOut - out) / spotOut) * BPS) : 0;
  return { out, impactBps };
}

/// Full pre-trade gate. Returns { allowed, reasons[] }.
export function checkTrade({ vault, signal, now, config }) {
  const reasons = [];
  if (vault.paused) reasons.push("vault paused");
  if (vault.circuitBroken) reasons.push("circuit breaker tripped");
  if (dailyLossBreached(vault)) reasons.push("daily loss breached");
  if (vault.lastTradeAt > 0 && now < vault.lastTradeAt + vault.minTradeInterval) {
    reasons.push(`cooldown: ${vault.lastTradeAt + vault.minTradeInterval - now}s left`);
  }
  if (signal.action === "buy") {
    const sizeValue = (vault.vaultValue * signal.sizeBps) / BPS;
    if (sizeValue > (vault.vaultValue * vault.maxTradeSizeBps) / BPS) {
      reasons.push("trade exceeds max trade size");
    }
  }
  if (signal.action === "sell" && signal.sizeBps > 0) {
    const sellValue = (signal.sizeBps / BPS) * vault.positionValue;
    if (sellValue > vault.positionValue) reasons.push("sell exceeds position");
  }
  if (config && config.maxSlippageBps != null && signal.slippageBps != null) {
    if (signal.slippageBps > config.maxSlippageBps) {
      reasons.push(`slippage ${signal.slippageBps}bps > max ${config.maxSlippageBps}bps`);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}
