// Unit tests for signal.js and risk.js — run with: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFactors, detectRegime, computeScore, decide, AdaptiveModel, DEFAULT_CONFIG,
} from "../signal.js";
import { dailyLossBreached, stopLossTriggered, estimateSlippage, checkTrade } from "../risk.js";

function risingHistory(n = 30, start = 2.0, step = 0.01) {
  const h = [];
  for (let i = 0; i < n; i++) h.push({ ts: i, price: start + step * i, volume: 10 });
  return h;
}

test("momentum is positive on a rising market", () => {
  const h = risingHistory();
  const f = computeFactors(h, 2.0, 2.29);
  assert.ok(f.momentum > 0.03, `momentum ${f.momentum}`); // +10 ticks x 0.01 on ~2.2 base
  assert.ok(f.meanReversion < 0, "spot above twap -> negative mean reversion");
});

test("mean reversion is positive when spot is below TWAP", () => {
  const h = risingHistory();
  const f = computeFactors(h, 2.0, 1.6);
  assert.ok(f.meanReversion > 0.1, `meanReversion ${f.meanReversion}`);
});

test("volume confirms a move but quiet ticks are neutral, never bearish", () => {
  const base = risingHistory(30, 2.0, 0.01);
  const f = computeFactors(base, 2.0, 2.29);
  assert.equal(f.volume, 0, "flat volume is neutral");
  const spiked = base.map((h, i) => ({ ...h, volume: i >= 27 ? 50 : 10 }));
  const f2 = computeFactors(spiked, 2.0, 2.29);
  assert.ok(f2.volume > 0, `elevated volume with rising momentum should confirm, got ${f2.volume}`);
  const quiet = base.map((h, i) => ({ ...h, volume: i >= 27 ? 0 : 10 }));
  const f3 = computeFactors(quiet, 2.0, 2.29);
  assert.equal(f3.volume, 0, "volume collapse after a spike must not read as bearish");
});

test("volatility dampener needs enough history", () => {
  const short = risingHistory(5, 2.0, 0.1); // big jumps, tiny history
  const f = computeFactors(short, 2.0, 2.4);
  assert.equal(f.dampener, 1, "fewer than 10 points -> no dampening");
});
test("crash regime detected on a sharp drop with high volatility", () => {
  const h = [];
  let p = 2.0;
  for (let i = 0; i < 30; i++) {
    p = i < 20 ? p + 0.01 : p * 0.94; // steady rise, then 6% drops per tick
    h.push({ ts: i, price: p, volume: 10 });
  }
  const f = computeFactors(h, 2.0, h[h.length - 1].price);
  const regime = detectRegime(f);
  assert.equal(regime, "crash");
  const { score } = computeScore(f, { momentum: 0.4, meanReversion: 0.35, volume: 0.15, volatility: 0.1 });
  assert.ok(score < 0, `crash score should be negative, got ${score}`);
});

test("decide buys above threshold, holds in deadband, sells below threshold when holding", () => {
  assert.equal(decide(0.5, "trending", 0).action, "buy");
  assert.equal(decide(0.1, "calm", 0).action, "hold");
  assert.equal(decide(-0.5, "trending", 10).action, "sell");
  assert.equal(decide(-0.5, "trending", 0).action, "hold"); // nothing to sell
  assert.equal(decide(0.5, "crash", 10).action, "sell"); // crash exits position
  assert.equal(decide(0.5, "crash", 10).sizeBps, 10000); // full exit, not a trim
  assert.equal(decide(0.5, "crash", 0).action, "hold");
});

test("adaptive model reinforces factors that called a profitable trade", () => {
  const m = new AdaptiveModel();
  const before = { ...m.weights };
  const factors = { momentum: 0.6, meanReversion: 0.2, volume: 0.1, volatility: 0.02, dampener: 1 };
  m.learn(1, 0.05, factors); // bought, profited 5%
  assert.ok(m.weights.momentum > before.momentum, "momentum weight should rise after a good buy call");
  m.learn(1, -0.05, factors); // same call, lost 5%
  assert.ok(m.weights.momentum < before.momentum + 0.2, "weight should fall back after a losing call");
  const sum = m.weights.momentum + m.weights.meanReversion + m.weights.volume;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
});

test("dailyLossBreached mirrors the vault math", () => {
  const v = { vaultValue: 900, dayStartValue: 1000, maxDailyLossBps: 1000 };
  assert.equal(dailyLossBreached(v), false); // exactly -10% is NOT breached (strict <)
  assert.equal(dailyLossBreached({ ...v, vaultValue: 899.9 }), true);
  assert.equal(dailyLossBreached({ ...v, vaultValue: 950 }), false);
});

test("stop-loss triggers only when TWAP is at/below entry minus the buffer", () => {
  const base = { positionBase: 10, entryPrice: 2.0, stopLossBps: 500 };
  assert.equal(stopLossTriggered({ ...base, twapPrice: 1.95 }), false); // -2.5%
  assert.equal(stopLossTriggered({ ...base, twapPrice: 1.89 }), true); // -5.5%
  assert.equal(stopLossTriggered({ ...base, twapPrice: 1.90 }), true); // exactly -5% triggers (<=)
  assert.equal(stopLossTriggered({ ...base, positionBase: 0, twapPrice: 1.0 }), false);
});

test("slippage estimate grows with trade size", () => {
  const small = estimateSlippage(1, 1000, 2000);
  const big = estimateSlippage(500, 1000, 2000);
  assert.ok(big.impactBps > small.impactBps, `${big.impactBps} should exceed ${small.impactBps}`);
  assert.ok(small.out > 0 && big.out > 0);
});

test("checkTrade blocks paused vaults, breakers and cooldowns", () => {
  const vault = {
    paused: false, circuitBroken: false, vaultValue: 1000, dayStartValue: 1000,
    maxDailyLossBps: 1000, lastTradeAt: 0, minTradeInterval: 60,
    maxTradeSizeBps: 2000, positionBase: 0, positionValue: 0,
  };
  const signal = { action: "buy", sizeBps: 1000 };
  assert.equal(checkTrade({ vault, signal, now: 1000, config: {} }).allowed, true);
  assert.equal(checkTrade({ vault: { ...vault, paused: true }, signal, now: 1000, config: {} }).allowed, false);
  assert.equal(checkTrade({ vault: { ...vault, circuitBroken: true }, signal, now: 1000, config: {} }).allowed, false);
  assert.equal(checkTrade({ vault: { ...vault, lastTradeAt: 990 }, signal, now: 1000, config: {} }).allowed, false);
  assert.equal(checkTrade({ vault: { ...vault, vaultValue: 800 }, signal, now: 1000, config: {} }).allowed, false);
});
