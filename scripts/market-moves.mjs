// market-moves.mjs — scripted "market mover" for the e2e demo.
// Uses Anvil account 1 (a different wallet from the agent) to move the price:
//   1. pump: buy mHSK with 300 mUSDC  -> price rises, agent should BUY the trend
//   2. crash: dump 400 mHSK           -> price crashes, stop-loss / breaker fire
//   3. recover: buy mHSK with 200 mUSDC -> price recovers
// Each move is spaced so the agent (5s ticks) sees it. Prints the spot after
// every move. LOCAL ONLY — Anvil test key.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
// Anvil account 1 — well-known test key, local only.
const MOVER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ONE = ethers.parseEther("1");

function abi(file, name) {
  return JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8")).abi;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const deployments = JSON.parse(readFileSync(join(ROOT, "deployments.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const mover = new ethers.Wallet(MOVER_KEY, provider);
  const mHSK = new ethers.Contract(deployments.base, abi("MockERC20.sol", "MockERC20"), mover);
  const mUSDC = new ethers.Contract(deployments.quote, abi("MockERC20.sol", "MockERC20"), mover);
  const pair = new ethers.Contract(deployments.pair, abi("HorizonAMM.sol", "HorizonAMMPair"), mover);
  const oracle = new ethers.Contract(deployments.oracle, abi("PriceOracle.sol", "PriceOracle"), mover);
  const token0 = await pair.token0();
  const baseIs0 = token0 === deployments.base;
  // Explicit nonce tracking (same Anvil pending-count lag as in deploy).
  let nonce = await provider.getTransactionCount(await mover.getAddress(), "latest");
  const nextNonce = () => nonce++;
  const send = async (promise) => { const tx = await promise; await tx.wait(); return tx; };

  const spot = async () => Number(ethers.formatEther(await oracle.spotConsult(deployments.base, ONE)));

  // Mover was pre-funded by deploy-local.mjs (mint is onlyOwner).

  const swapExactIn = async (tokenIn, amountIn) => {
    const [r0, r1] = await pair.getReserves();
    const [reserveIn, reserveOut] = tokenIn === token0
      ? [r0, r1] : [r1, r0];
    const amountInWithFee = amountIn * 997n;
    const out = (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
    await send((tokenIn === deployments.base ? mHSK : mUSDC).transfer(deployments.pair, amountIn, { nonce: nextNonce() }));
    if (tokenIn === token0) await send(pair.swap(0n, out, await mover.getAddress(), { nonce: nextNonce() }));
    else await send(pair.swap(out, 0n, await mover.getAddress(), { nonce: nextNonce() }));
    await send(oracle.update({ nonce: nextNonce() })); // record the new price level for TWAP
    return out;
  };

  console.log(`start spot ${await spot()} mUSDC/mHSK`);
  await sleep(8000);

  console.log("MOVE 1 — pump: buy mHSK with 300 mUSDC");
  await swapExactIn(deployments.quote, 300n * ONE);
  console.log(`spot now ${(await spot()).toFixed(4)}`);
  await sleep(25000);

  console.log("MOVE 2 — crash: dump 400 mHSK");
  await swapExactIn(deployments.base, 400n * ONE);
  console.log(`spot now ${(await spot()).toFixed(4)}`);
  await sleep(25000);

  console.log("MOVE 3 — recover: buy mHSK with 200 mUSDC");
  await swapExactIn(deployments.quote, 200n * ONE);
  console.log(`spot now ${(await spot()).toFixed(4)}`);
  console.log("market moves done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
