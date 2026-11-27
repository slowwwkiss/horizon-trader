// agent.js — Horizon Trader agent loop.
//
// Reads the AMM + oracle + vault on-chain, scores the market with the adaptive
// model (signal.js), gates every trade through risk.js, and executes through
// TradingVault.executeTrade. Also acts as keeper: trips the circuit breaker
// and force-stops losses when the on-chain conditions are met.
//
// LOCAL ONLY by default: it talks to Anvil on http://127.0.0.1:8545 with the
// well-known Anvil test key (account 0). For HSK testnet, set RPC_URL and
// AGENT_KEY yourself — never paste a real key into this repo.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { AdaptiveModel, decide, DEFAULT_CONFIG } from "./signal.js";
import { checkTrade, dailyLossBreached, stopLossTriggered, estimateSlippage, BPS } from "./risk.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const ANVIL_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function loadAbi(contractFile, contractName) {
  const p = join(ROOT, "out", contractFile, `${contractName}.json`);
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

export function loadDeployments(path) {
  const p = path || join(ROOT, "deployments.json");
  if (!existsSync(p)) throw new Error(`deployments file not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export class HorizonAgent {
  constructor(opts = {}) {
    this.rpcUrl = opts.rpcUrl || process.env.RPC_URL || "http://127.0.0.1:8545";
    this.deployments = opts.deployments || loadDeployments(opts.deploymentsPath);
    this.tickMs = opts.tickMs || Number(process.env.TICK_MS || 5000);
    this.maxTicks = opts.maxTicks || Number(process.env.MAX_TICKS || 0);
    this.config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
    this.model = new AdaptiveModel();
    this.history = [];
    this.trades = [];
    this.ticks = 0;
    this.errors = [];
    this.startedAt = null;
    this.stopped = false;
    this.lastSignal = null;
    this.lastDecision = null;
    this.lastTx = null;
    this.lastBlock = 0;
    this.entryFactors = null;
    this.entryValue = 0;
  }

  async init() {
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const pk = process.env.AGENT_KEY || ANVIL_KEY;
    this.wallet = new ethers.Wallet(pk, this.provider);
    const d = this.deployments;
    this.pair = new ethers.Contract(
      d.pair, loadAbi("HorizonAMM.sol", "HorizonAMMPair"), this.provider,
    );
    this.oracle = new ethers.Contract(
      d.oracle, loadAbi("PriceOracle.sol", "PriceOracle"), this.provider,
    );
    this.vault = new ethers.Contract(
      d.vault, loadAbi("TradingVault.sol", "TradingVault"), this.wallet,
    );
    this.base = new ethers.Contract(
      d.base, loadAbi("MockERC20.sol", "MockERC20"), this.provider,
    );
    this.quote = new ethers.Contract(
      d.quote, loadAbi("MockERC20.sol", "MockERC20"), this.provider,
    );
    this.baseAddr = d.base;
    this.quoteAddr = d.quote;
    this.token0 = await this.pair.token0();
    this.agentAddress = await this.wallet.getAddress();
    console.log(`agent wallet ${this.agentAddress} on ${this.rpcUrl}`);
    console.log(`pair ${d.pair} oracle ${d.oracle} vault ${d.vault}`);
  }

  async readState() {
    const [r0, r1] = await this.pair.getReserves();
    const reserveBase = this.token0 === this.baseAddr ? r0 : r1;
    const reserveQuote = this.token0 === this.baseAddr ? r1 : r0;
    const one = ethers.parseEther("1");
    let spot = 0;
    let twap = 0;
    try {
      spot = Number(ethers.formatEther(await this.oracle.spotConsult(this.baseAddr, one)));
    } catch (e) { /* oracle not ready yet */ }
    try {
      twap = Number(ethers.formatEther(await this.oracle.consult(this.baseAddr, one, 600)));
    } catch (e) { twap = spot; }
    const v = await this.vault;
    const [
      vaultValue, positionBase, entryPrice, paused, circuitBroken,
      dayStartValue, lastTradeAt, maxTradeSizeBps, maxDailyLossBps, minTradeInterval,
      stopLossBps,
    ] = await Promise.all([
      v.vaultValue(), v.positionBase(), v.entryPrice(), v.paused(), v.circuitBroken(),
      v.dayStartValue(), v.lastTradeAt(), v.maxTradeSizeBps(), v.maxDailyLossBps(), v.minTradeInterval(),
      v.stopLossBps(),
    ]);
    return {
      reserveBase: Number(ethers.formatEther(reserveBase)),
      reserveQuote: Number(ethers.formatEther(reserveQuote)),
      spot, twap,
      vault: {
        vaultValue: Number(ethers.formatEther(vaultValue)),
        positionBase: Number(ethers.formatEther(positionBase)),
        entryPrice: Number(ethers.formatEther(entryPrice)),
        positionValue: Number(ethers.formatEther(positionBase)) * spot,
        paused, circuitBroken,
        dayStartValue: Number(ethers.formatEther(dayStartValue)),
        lastTradeAt: Number(lastTradeAt),
        maxTradeSizeBps: Number(maxTradeSizeBps),
        maxDailyLossBps: Number(maxDailyLossBps),
        minTradeInterval: Number(minTradeInterval),
        stopLossBps: Number(stopLossBps),
      },
    };
  }

  async tickVolume() {
    // Sum base-token volume from Swap events since the last tick.
    try {
      const latest = await this.provider.getBlockNumber();
      const from = this.lastBlock ? this.lastBlock + 1 : Math.max(0, latest - 50);
      const events = await this.pair.queryFilter(this.pair.filters.Swap, from, latest);
      this.lastBlock = latest;
      let vol = 0;
      for (const e of events) {
        const [amount0In, amount1In] = [e.args.amount0In, e.args.amount1In];
        const baseIn = this.token0 === this.baseAddr ? amount0In : amount1In;
        vol += Number(ethers.formatEther(baseIn));
      }
      return vol;
    } catch {
      return 0;
    }
  }

  async tick() {
    this.ticks += 1;
    const now = Math.floor(Date.now() / 1000);
    try {
      const state = await this.readState();
      const vol = await this.tickVolume();
      if (state.spot > 0) {
        this.history.push({ ts: now, price: state.spot, volume: vol });
        if (this.history.length > 200) this.history.shift();
      }
      const { vault } = state;

      // Keeper duties first: stop-loss and circuit breaker.
      if (stopLossTriggered({ ...vault, twapPrice: state.twap })) {
        console.log(`[tick ${this.ticks}] STOP-LOSS triggered: twap ${state.twap.toFixed(4)} <= entry ${vault.entryPrice.toFixed(4)} x 0.95 — force-selling full position`);
        await this.sellAll(vault, state);
        this.lastSignal = { action: "stop-loss", spot: state.spot, twap: state.twap };
        return this.snapshot(state);
      }
      if (dailyLossBreached(vault) && !vault.circuitBroken) {
        console.log(`[tick ${this.ticks}] daily loss breached — tripping circuit breaker`);
        const tx = await this.sendTx((o) => this.vault.tripCircuitBreaker(o));
        this.lastTx = tx.hash;
      }

      // Normal signal path.
      const scored = this.model.score(this.history, state.twap, state.spot, this.config);
      const decision = decide(scored.score, scored.regime, vault.positionBase, this.config);
      this.lastSignal = { ...scored, spot: state.spot, twap: state.twap, ts: now };
      this.lastDecision = decision;

      if (decision.action === "hold") {
        if (this.ticks % 6 === 0) {
          console.log(`[tick ${this.ticks}] hold — score ${scored.score.toFixed(2)} regime ${scored.regime} spot ${state.spot.toFixed(4)} vault ${vault.vaultValue.toFixed(1)}`);
        }
        return this.snapshot(state);
      }

      // Slippage estimate for the planned trade.
      const sizeValue = (vault.vaultValue * decision.sizeBps) / BPS;
      let slippageBps = 0;
      let amountIn = 0n;
      if (decision.action === "buy") {
        amountIn = ethers.parseEther(sizeValue.toFixed(6));
        const { impactBps } = estimateSlippage(sizeValue, state.reserveQuote, state.reserveBase);
        slippageBps = impactBps;
      } else {
        let sellBase = (vault.positionBase * decision.sizeBps) / BPS;
        const maxSellValue = (vault.vaultValue * vault.maxTradeSizeBps) / BPS;
        if (sellBase * state.spot > maxSellValue) {
          sellBase = maxSellValue / state.spot; // cap at max trade size (value)
        }
        amountIn = ethers.parseEther(sellBase.toFixed(6));
        const { impactBps } = estimateSlippage(sellBase, state.reserveBase, state.reserveQuote);
        slippageBps = impactBps;
      }
      const gate = checkTrade({
        vault, signal: { ...decision, slippageBps }, now, config: { maxSlippageBps: 500 },
      });
      if (!gate.allowed) {
        console.log(`[tick ${this.ticks}] trade blocked: ${gate.reasons.join("; ")}`);
        return this.snapshot(state);
      }

      const minOut = 1n; // vault enforces slippage via amountOut >= minOut; 1 wei floor + pre-check above
      console.log(`[tick ${this.ticks}] ${decision.action.toUpperCase()} ${decision.sizeBps}bps — ${decision.reason} (score ${scored.score.toFixed(2)}, regime ${scored.regime})`);
      const tx = await this.sendTx((o) =>
        this.vault.executeTrade(decision.action === "buy", amountIn, minOut, o));
      const receipt = await tx.wait();
      this.lastTx = tx.hash;
      if (decision.action === "buy") {
        this.entryFactors = { ...scored };
        this.entryValue = vault.vaultValue;
      } else if (this.entryFactors) {
        const pnlPct = (vault.vaultValue - this.entryValue) / Math.max(this.entryValue, 1);
        this.model.learn(-1, pnlPct, this.entryFactors);
        this.entryFactors = null;
      }
      this.trades.push({
        tick: this.ticks, action: decision.action, sizeBps: decision.sizeBps,
        spot: state.spot, tx: tx.hash, block: receipt.blockNumber, ts: now,
      });
      return this.snapshot(state);
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      this.errors.push({ tick: this.ticks, error: msg, ts: now });
      if (this.errors.length > 20) this.errors.shift();
      console.log(`[tick ${this.ticks}] ERROR ${msg}`);
      return this.snapshot(null);
    }
  }

  async sellAll(vault, state) {
    if (vault.positionBase <= 0) return;
    // forceStopLoss sells the whole position and bypasses the trade cooldown
    // and max-size check — exactly what an emergency exit needs.
    const tx = await this.sendTx((o) => this.vault.forceStopLoss(o));
    await tx.wait();
    this.lastTx = tx.hash;
    if (this.entryFactors) {
      const pnlPct = (vault.vaultValue - this.entryValue) / Math.max(this.entryValue, 1);
      this.model.learn(-1, pnlPct, this.entryFactors);
      this.entryFactors = null;
    }
    this.trades.push({
      tick: this.ticks, action: "sell", sizeBps: 10000, spot: state.spot,
      tx: tx.hash, ts: Math.floor(Date.now() / 1000), note: "stop-loss",
    });
  }

  /// Send a vault tx with an explicit fresh nonce (Anvil's pending-count
  /// lags by one right after mining; ethers' default assignment can reuse a
  /// nonce). Retries once after a short delay on nonce errors.
  async sendTx(fn) {
    const nonce = await this.provider.getTransactionCount(this.agentAddress, "latest");
    try {
      const tx = await fn({ nonce });
      await tx.wait();
      return tx;
    } catch (err) {
      if (err?.code === "NONCE_EXPIRED" || /nonce/i.test(err?.shortMessage || "")) {
        await new Promise((r) => setTimeout(r, 1000));
        const nonce2 = await this.provider.getTransactionCount(this.agentAddress, "latest");
        const tx = await fn({ nonce: nonce2 });
        await tx.wait();
        return tx;
      }
      throw err;
    }
  }

  snapshot(state) {
    const vault = state?.vault;
    return {
      tick: this.ticks,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      spot: state?.spot ?? null,
      twap: state?.twap ?? null,
      vault: vault ?? null,
      pnlPct: vault && vault.dayStartValue > 0
        ? (vault.vaultValue - vault.dayStartValue) / vault.dayStartValue
        : 0,
      signal: this.lastSignal,
      decision: this.lastDecision,
      trades: this.trades.slice(-20),
      errors: this.errors.slice(-5),
      weights: { ...this.model.weights },
      config: { ...this.config },
      history: this.history.slice(-100),
      lastTx: this.lastTx,
    };
  }

  getState() {
    return this.snapshot(this._lastState || null);
  }

  async run() {
    await this.init();
    this.startedAt = Date.now();
    console.log(`agent running, tick every ${this.tickMs}ms (MAX_TICKS=${this.maxTicks || "∞"})`);
    while (!this.stopped) {
      const snap = await this.tick();
      this._lastState = snap.vault ? { spot: snap.spot, twap: snap.twap, vault: snap.vault } : this._lastState;
      if (this.maxTicks && this.ticks >= this.maxTicks) break;
      await new Promise((r) => setTimeout(r, this.tickMs));
    }
    console.log(`agent stopped after ${this.ticks} ticks, ${this.trades.length} trades`);
  }

  stop() {
    this.stopped = true;
  }
}

// CLI entrypoint: `node agent.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const agent = new HorizonAgent();
  process.on("SIGINT", () => agent.stop());
  process.on("SIGTERM", () => agent.stop());
  agent.run().catch((e) => {
    console.error("agent fatal:", e);
    process.exit(1);
  });
}
