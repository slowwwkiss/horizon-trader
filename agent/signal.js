// signal.js — adaptive multi-factor signal model (pure functions, unit-testable).
//
// Honest note: the "AI" in Horizon Trader is a statistical adaptive model, not
// an LLM. It scores the market from four factors, adapts its factor weights
// online from realised trade outcomes, and classifies the market regime.
// No API key or external service is needed.
//
// Prices are plain JS numbers (quote per base, e.g. mUSDC per mHSK).
// History entries: { ts, price, volume } — volume in base-token units per tick.

export const DEFAULT_WEIGHTS = {
  momentum: 0.4,
  meanReversion: 0.35,
  volume: 0.15,
  volatility: 0.1, // used as a dampener weight, not a directional factor
};

export const DEFAULT_CONFIG = {
  momentumWindow: 10, // ticks of lookback for momentum
  volWindow: 20, // ticks of lookback for volatility
  buyThreshold: 0.25, // score above this -> buy
  sellThreshold: -0.25, // score below this -> sell (only when holding)
  baseSizeBps: 1000, // 10% of vault value per trade at full conviction
  maxSizeBps: 2000, // hard cap (matches the vault's maxTradeSizeBps)
  crashMomentum: -0.15, // momentum below this + high vol -> crash regime
  highVol: 0.08, // 8% realised vol over the window counts as high
};

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function std(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/// Compute the four factors from price history, TWAP and spot.
/// Returns { momentum, meanReversion, volume, volatility, dampener }.
export function computeFactors(history, twap, spot, config = DEFAULT_CONFIG) {
  const prices = history.map((h) => h.price);
  const n = prices.length;
  if (n === 0 || spot <= 0) {
    return { momentum: 0, meanReversion: 0, volume: 0, volatility: 0, dampener: 1 };
  }

  // Momentum: return over the lookback window, normalised by a "typical"
  // move (10%) so a 10%+ move is a full-strength signal, clamped to [-1, 1].
  const lookback = Math.min(config.momentumWindow, n - 1);
  const old = lookback > 0 ? prices[n - 1 - lookback] : spot;
  const momentum = old > 0 ? clamp(((spot - old) / old) / 0.1, -1, 1) : 0;

  // Mean reversion: spot below TWAP -> positive (expect a bounce up),
  // normalised the same way.
  const meanReversion = twap > 0 ? clamp(((twap - spot) / twap) / 0.1, -1, 1) : 0;

  // Volume: elevated recent volume CONFIRMS the move it accompanies.
  // Only ever a positive confirmation (0 when quiet): a volume collapse
  // after a spike is not a bearish signal, it is just no information.
  // Compares the last-3-tick average volume with the whole-history average.
  const vols = history.map((h) => h.volume || 0);
  const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(vols.length, 1);
  const recent3 = vols.slice(-3);
  const recentAvg = recent3.reduce((a, b) => a + b, 0) / Math.max(recent3.length, 1);
  const volume =
    avgVol > 0 && recentAvg > avgVol
      ? clamp((recentAvg - avgVol) / avgVol, 0, 1) * Math.sign(momentum || 1)
      : 0;

  // Volatility: std of log returns over the window; high vol dampens size.
  // Needs at least 10 points — with fewer, the std of a couple of returns
  // is meaningless and one big jump would wrongly dampen its own signal.
  const rets = [];
  const vStart = Math.max(1, n - config.volWindow);
  for (let i = vStart; i < n; i++) {
    if (prices[i - 1] > 0) rets.push(Math.log(prices[i] / prices[i - 1]));
  }
  const volatility = n >= 10 ? std(rets) : 0;
  const dampener = 1 - clamp(volatility / (config.highVol * 2.5), 0, 0.8);

  // Drawdown from the recent peak: a sustained crash has low return
  // dispersion (every tick down ~the same), so std alone misses it.
  const peak = Math.max(...prices.slice(Math.max(0, n - config.volWindow)));
  const drawdown = peak > 0 ? (peak - spot) / peak : 0;

  return { momentum, meanReversion, volume, volatility, dampener, drawdown };
}

/// Classify the market regime from the factors.
export function detectRegime(factors, config = DEFAULT_CONFIG) {
  const { momentum, meanReversion, volatility, drawdown = 0 } = factors;
  if (momentum < config.crashMomentum && (volatility > config.highVol || drawdown > 0.15)) return "crash";
  if (Math.abs(momentum) > 0.08) return "trending";
  if (Math.abs(meanReversion) > 0.05 && Math.abs(momentum) < 0.08) return "ranging";
  return "calm";
}

/// Weighted score in [-1, 1]. Crash regime forces a negative score (stand down).
/// Weights are regime-adjusted: in a trend, momentum dominates and mean
/// reversion is down-weighted (price can stay away from TWAP for a long time);
/// in a range, the reverse.
export function computeScore(factors, weights, config = DEFAULT_CONFIG) {
  const regime = detectRegime(factors, config);
  let wMom = weights.momentum;
  let wRev = weights.meanReversion;
  if (regime === "trending") wRev *= 0.3;
  else if (regime === "ranging") wMom *= 0.3;
  const raw =
    wMom * factors.momentum +
    wRev * factors.meanReversion +
    weights.volume * factors.volume;
  const score = regime === "crash" ? -Math.abs(raw) - 0.2 : raw;
  return { score: clamp(score, -1, 1) * factors.dampener, regime, raw };
}

/// Decide an action from a score, the current position and the config.
export function decide(score, regime, positionBase, config = DEFAULT_CONFIG) {
  if (regime === "crash") {
    return {
      action: positionBase > 0 ? "sell" : "hold",
      sizeBps: positionBase > 0 ? 10000 : 0, // full exit (capped by the vault's max trade size in the agent loop)
      reason: "crash regime — exit to safety",
    };
  }
  if (score > config.buyThreshold) {
    const sizeBps = Math.min(
      Math.round(config.baseSizeBps * Math.abs(score) * 2),
      config.maxSizeBps,
    );
    return { action: "buy", sizeBps, reason: `score ${score.toFixed(2)} > buy threshold` };
  }
  if (score < config.sellThreshold && positionBase > 0) {
    const sizeBps = Math.min(
      Math.round(config.baseSizeBps * Math.abs(score) * 2),
      config.maxSizeBps,
    );
    return { action: "sell", sizeBps, reason: `score ${score.toFixed(2)} < sell threshold` };
  }
  return { action: "hold", sizeBps: 0, reason: `score ${score.toFixed(2)} inside deadband` };
}

/// Online-learning model: factor weights adapt from realised trade outcomes.
/// After a closed trade, factors that agreed with the trade direction get
/// reinforced when the trade profited and weakened when it lost.
export class AdaptiveModel {
  constructor(weights = DEFAULT_WEIGHTS, learningRate = 0.1) {
    this.weights = { ...weights };
    this.learningRate = learningRate;
    this.trades = 0;
  }

  score(history, twap, spot, config = DEFAULT_CONFIG) {
    const factors = computeFactors(history, twap, spot, config);
    const { score, regime, raw } = computeScore(factors, this.weights, config);
    return { ...factors, score, regime, raw, weights: { ...this.weights } };
  }

  /// Learn from one closed trade.
  /// @param {number} direction +1 for a buy, -1 for a sell.
  /// @param {number} pnlPct realised PnL of the trade, e.g. 0.05 = +5%.
  /// @param {object} factors the factors that were present at entry.
  learn(direction, pnlPct, factors) {
    const lr = this.learningRate;
    const sign = Math.sign(pnlPct) || 0;
    for (const key of ["momentum", "meanReversion", "volume"]) {
      const agreed = Math.sign(factors[key] || 0) === direction;
      const delta = lr * sign * Math.abs(factors[key] || 0) * (agreed ? 1 : -1);
      this.weights[key] = clamp(this.weights[key] + delta, 0.05, 0.7);
    }
    // Renormalise the directional weights to sum to 1 (volatility weight is
    // the dampener weight and is kept fixed).
    const sum =
      this.weights.momentum + this.weights.meanReversion + this.weights.volume;
    for (const key of ["momentum", "meanReversion", "volume"]) {
      this.weights[key] /= sum;
    }
    this.trades += 1;
    return { ...this.weights };
  }
}
