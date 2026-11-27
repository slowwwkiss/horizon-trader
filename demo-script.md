# Demo video script — Horizon Trader (HSK Chain Horizon Hackathon, Track 1)

Target length: ~3 minutes. Record the screen while the e2e runs; narrate in English
with Indonesian subtitles if needed. No real funds, no live chain — everything is
local Anvil, say so on screen.

## 0:00–0:20 — The problem (show DoraHacks page + README)
"Trading agents usually trust an off-chain bot with the keys and the risk rules.
Horizon Trader puts the money and every risk rule on-chain, and lets the agent do
only what the vault allows."

## 0:20–0:50 — The contracts (show `forge test` passing 13/13)
- AMM: constant-product, 0.3% fee, TWAP cumulative prices.
- Oracle: TWAP with spot fallback.
- Vault: only-agent, max trade 20%, stop-loss 5%, daily-loss breaker 10%, 60s
  cooldown, pausable.
- Mention the two bugs found while building: the circuit-breaker flag that a
  revert rolled back, and the forge `vm.warp` stale-timestamp quirk.

## 0:50–1:30 — The agent (show `agent/signal.js` + terminal)
- Adaptive model: momentum, mean reversion, volume, volatility; regime detection
  (trending / ranging / crash / calm); weights learn online from realised trades.
- Risk module mirrors the vault limits before any trade is sent.
- Start the e2e: `bash scripts/e2e-local.sh`.

## 1:30–2:30 — The live run (show terminal + dashboard at localhost:8080)
- Scripted market: pump +32% → the agent buys (score, regime "trending" on screen).
- Crash −53% → stop-loss fires, position sold, vault protected.
- Recovery → agent holds, no revenge trading.
- Point at the dashboard: vault value, position, PnL today, trade history.

## 2:30–3:00 — The chat (show the dashboard chat box)
- Ask `status`, `positions`, `pnl`, `weights`, then `set size 1500`.
- Close: "Built for HSK Chain testnet next — same contracts, same agent, just a
  different RPC URL. Track 1, AI Agent Trading."

## Recording checklist
- [ ] Fresh terminal, `bash scripts/e2e-local.sh` from `~/workspace/hsk-horizon/`
- [ ] Dashboard open at http://localhost:8080 (start `node agent/server.js` in a
      second terminal after the deploy step prints `deployments.json written`)
- [ ] If the dashboard shows no backend, use `?demo=1` — but prefer the live run
- [ ] Keep the Anvil + agent logs visible; the e2e prints PASS/FAIL per assertion
