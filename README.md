# Horizon Trader — AI Agent Trading on HSK Chain

Entry for the **HSK Chain Horizon Hackathon** (DoraHacks, Seoul), **Track 1: AI Agent
Trading**. Total pool 12,000 USDT (6,000 per track; 1st 3,000 / 2nd 2,000 / 3rd 1,000).
Submission deadline **3 Dec 2026, 13:00 KST (11:00 WIB)**. Demo Day 5 Dec 2026 in Seoul
(online pitching allowed for teams outside Korea). Winners announced 6 Dec 2026.

> Status: built and verified locally (Anvil). **Not deployed to any live chain, not
> submitted to DoraHacks.** Submission is a separate, human decision.

## What it is

An autonomous trading agent that lives on HSK Chain (EVM-compatible OP Stack L2):

- **On-chain (Solidity, Foundry):** a constant-product AMM (`HorizonAMM`, 0.3% fee,
  TWAP cumulative prices), a TWAP oracle (`PriceOracle`, Uniswap OracleLibrary-style
  with spot fallback), and a `TradingVault` that holds funds and enforces every risk
  rule on-chain: only-agent execution, max trade size 20%, stop-loss 5%, max daily
  loss 10% (circuit breaker), 60s trade cooldown, 1% max slippage, pausable.
- **Off-chain agent (Node.js + ethers v6):** reads the AMM/oracle/vault every tick,
  scores the market with an **adaptive multi-factor model** (momentum, mean reversion,
  volume, volatility + regime detection: trending / ranging / crash / calm), gates
  every trade through a risk module that mirrors the vault's limits, and executes
  through the vault. After each closed trade the model **learns online**: factor
  weights shift toward the factors that called the direction right when the trade
  profited. It also acts as keeper: it trips the circuit breaker and force-sells on
  stop-loss.
- **Dashboard + chat (single HTML page + tiny Node server):** live positions, PnL,
  regime, price chart, trade history, and a conversational interface — ask `status`,
  `positions`, `pnl`, `weights`, or tune it with `set size 1500`.

The "AI" is honest: a statistical adaptive model, not an LLM. No API key, no paid
service, no KYC anywhere in the stack.

## Quick start (local, Anvil)

```bash
# 1. contracts
forge test            # 13/13 Solidity tests
forge build

# 2. agent unit tests
cd agent && npm install && npm test   # 11/11 JS tests

# 3. full end-to-end: Anvil + deploy + seed + agent + scripted market
#    (pump -> crash -> recovery) with assertions
bash scripts/e2e-local.sh

# 4. dashboard (needs a running Anvil + deployments.json from step 3)
node agent/server.js  # http://localhost:8080 (add ?demo=1 for simulated data)
```

The e2e run deploys everything to a fresh Anvil chain, seeds 1,000 mHSK + 2,000 mUSDC
liquidity (spot 2.0 mUSDC/mHSK), funds the vault with 1,000 mUSDC, then runs the
agent for 30 ticks while a scripted market mover pumps (+32%), crashes (−53%), and
recovers the price. Expected outcome: the agent buys the pump, stop-losses the crash,
and ends flat with the vault intact.

## Testnet deploy (HSK Chain testnet)

Docs: https://docs.hskchain.net — testnet RPC https://testnet.hsk.xyz, chain ID 133,
explorer https://testnet-explorer.hskchain.net, faucet https://faucet.hsk.xyz
(free testnet HSK, rate-limited).

```bash
export RPC_URL=https://testnet.hsk.xyz
# fund a fresh deployer wallet from the faucet first, then:
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --private-key $KEY
# point the agent at it:
RPC_URL=https://testnet.hsk.xyz AGENT_KEY=$KEY node agent/agent.js
```

Notes: never reuse a mainnet key; the deployer/agent keys in this repo are the
well-known Anvil test keys and must never hold real funds. The vault's `agent`
address is set at deployment; rotating it is an owner-only call.

## Project layout

```
src/                  HorizonAMM.sol  PriceOracle.sol  TradingVault.sol  MockERC20.sol
test/                 HorizonTrader.t.sol (13 tests)
agent/                agent.js (loop)  signal.js (model)  risk.js (gates)  server.js (dashboard API)
agent/test/           signal-risk.test.mjs (11 tests)
ui/                   index.html (dashboard + chat, ?demo=1 for simulated data)
scripts/              deploy-local.mjs  market-moves.mjs  e2e-local.sh
demo-script.md        narration + steps for the demo video
```

## Risk limits (on-chain, enforced by TradingVault)

| Rule | Value |
|---|---|
| Max trade size | 20% of vault value |
| Stop-loss | 5% below entry (keeper-callable `forceStopLoss`) |
| Max daily loss | 10% (circuit breaker, resets next day) |
| Trade cooldown | 60 s between trades |
| Max slippage | 1% (per-trade `minAmountOut`) |
| Pause | owner-only |

## Known quirks found while building

- **forge 1.10.1 `vm.warp`:** `block.timestamp` reads stale (1) when used inline
  inside `vm.warp(...)`. Read it into a local first (`_warp()` helper in the tests).
- **Anvil nonce lag:** `eth_getTransactionCount("pending")` lags by one right after
  a tx is mined, so back-to-back sends reuse a nonce. Deploy/mover scripts track
  nonces explicitly; the agent fetches a fresh `"latest"` nonce per send.
- **Circuit breaker latch:** setting `circuitBroken = true` and then `revert`ing in
  the same call rolls the flag back. Latching is a separate permissionless
  `tripCircuitBreaker()` call — the agent calls it when the daily loss is breached.

## License

MIT.
