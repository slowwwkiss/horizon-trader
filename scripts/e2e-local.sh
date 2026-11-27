#!/usr/bin/env bash
# e2e-local.sh — full local end-to-end run on Anvil:
#   1. start Anvil
#   2. deploy + seed (deploy-local.mjs)
#   3. run the agent (30 ticks x 5s) while market-moves.mjs pumps, crashes,
#      then recovers the price
#   4. assert the agent traded and its safety systems fired
# Exits non-zero if any assertion fails. All local, no real chain, no real keys.
set -u
ANVIL_PID=""
AGENT_PID=""
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:/home/hatch/.foundry/bin"
cd "$ROOT"

pkill -x anvil 2>/dev/null; sleep 1
cleanup() {
  { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null; }
  { [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null; }
  { [ -n "$ANVIL_PID" ] && wait "$ANVIL_PID" 2>/dev/null; }
}
trap cleanup EXIT

echo "== starting anvil =="
anvil --port 8545 --silent > /tmp/hsk-anvil.log 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 30); do
  if curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q result; then
    break
  fi
  sleep 1
done
echo "anvil up (pid $ANVIL_PID)"

echo "== deploy + seed =="
node scripts/deploy-local.mjs || { echo "DEPLOY FAILED"; exit 1; }

echo "== agent (30 ticks) + market moves =="
TICK_MS=5000 MAX_TICKS=30 node agent/agent.js > /tmp/hsk-agent.log 2>&1 &
AGENT_PID=$!
sleep 3
node scripts/market-moves.mjs || { echo "MARKET MOVES FAILED"; exit 1; }
wait "$AGENT_PID"
AGENT_EXIT=$?
echo "agent exited $AGENT_EXIT"

echo "== assertions =="
cat /tmp/hsk-agent.log
fail=0
check() { # check <label> <grep-pattern>
  if grep -q "$2" /tmp/hsk-agent.log; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi
}
check "agent connected" "agent wallet 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
check "agent bought the pump" "BUY"
check "stop-loss or breaker fired on crash" "STOP-LOSS triggered\|tripping circuit breaker"
check "agent made at least one trade" "executeTrade\|BUY\|SELL"

# On-chain final state via cast.
VAULT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('deployments.json')).vault)")
echo "vault $VAULT"
cast call "$VAULT" "vaultValue() (uint256)" --rpc-url http://127.0.0.1:8545
cast call "$VAULT" "positionBase() (uint256)" --rpc-url http://127.0.0.1:8545
cast call "$VAULT" "circuitBroken() (bool)" --rpc-url http://127.0.0.1:8545

if [ "$fail" -ne 0 ]; then echo "E2E FAILED"; exit 1; fi
echo "E2E PASSED"
