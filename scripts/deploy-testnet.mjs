// deploy-testnet.mjs — deploy the full Horizon stack to HSK Chain testnet and seed it.
// Adapted from deploy-local.mjs. TESTNET ONLY.
// Uses the fresh testnet-only deployer key in testnet/deployer.key (never a mainnet key).
// Writes ../deployments-testnet.json for the agent.
// Usage: node scripts/deploy-testnet.mjs   (RPC_URL defaults to https://testnet.hsk.xyz)

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "https://testnet.hsk.xyz";
const KEY = readFileSync(join(ROOT, "testnet", "deployer.key"), "utf8").trim();

function abi(file, name) {
  return JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8")).abi;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const deployer = new ethers.Wallet(KEY, provider);
  console.log(`deployer ${await deployer.getAddress()} on ${RPC_URL}`);
  console.log(`balance ${(await provider.getBalance(await deployer.getAddress())).toString()} wei`);

  let nonce = await provider.getTransactionCount(await deployer.getAddress(), "latest");
  const nextNonce = () => nonce++;
  const send = async (promise) => { const tx = await promise; await tx.wait(); return tx; };

  const deploy = async (file, name, args = []) => {
    const factory = new ethers.ContractFactory(abi(file, name),
      JSON.parse(readFileSync(join(ROOT, "out", file, `${name}.json`), "utf8")).bytecode.object,
      deployer);
    const c = await factory.deploy(...args, { nonce: nextNonce() });
    await c.waitForDeployment();
    const addr = await c.getAddress();
    console.log(`  ${name} -> ${addr}`);
    return c;
  };

  const mHSK = await deploy("MockERC20.sol", "MockERC20", ["Mock HSK", "mHSK"]);
  const mUSDC = await deploy("MockERC20.sol", "MockERC20", ["Mock USDC", "mUSDC"]);
  const factory = await deploy("HorizonAMM.sol", "HorizonAMMFactory");
  const pairAddr = await factory.createPair.staticCall(await mHSK.getAddress(), await mUSDC.getAddress());
  await send(factory.createPair(await mHSK.getAddress(), await mUSDC.getAddress(), { nonce: nextNonce() }));
  console.log(`  pair -> ${pairAddr}`);
  const pair = new ethers.Contract(pairAddr, abi("HorizonAMM.sol", "HorizonAMMPair"), deployer);

  // Seed liquidity: 1000 mHSK + 2000 mUSDC => spot 2.0 mUSDC per mHSK.
  const ONE = ethers.parseEther("1");
  await send(mHSK.mint(await deployer.getAddress(), 100_000n * ONE, { nonce: nextNonce() }));
  await send(mUSDC.mint(await deployer.getAddress(), 100_000n * ONE, { nonce: nextNonce() }));
  await send(mHSK.transfer(pairAddr, 1000n * ONE, { nonce: nextNonce() }));
  await send(mUSDC.transfer(pairAddr, 2000n * ONE, { nonce: nextNonce() }));
  await send(pair.mint(await deployer.getAddress(), { nonce: nextNonce() }));
  console.log("  liquidity seeded: 1000 mHSK + 2000 mUSDC");

  const oracle = await deploy("PriceOracle.sol", "PriceOracle", [pairAddr]);
  await send(oracle.update({ nonce: nextNonce() }));
  console.log("  oracle primed (1 observation)");

  const vault = await deploy("TradingVault.sol", "TradingVault", [
    await mHSK.getAddress(), await mUSDC.getAddress(), pairAddr,
    await oracle.getAddress(), await deployer.getAddress(), // agent = deployer (testnet)
  ]);
  await send(mUSDC.transfer(await vault.getAddress(), 1000n * ONE, { nonce: nextNonce() }));
  console.log("  vault funded: 1000 mUSDC");

  const out = {
    chainId: Number((await provider.getNetwork()).chainId),
    rpcUrl: RPC_URL,
    base: await mHSK.getAddress(),
    quote: await mUSDC.getAddress(),
    factory: await factory.getAddress(),
    pair: pairAddr,
    oracle: await oracle.getAddress(),
    vault: await vault.getAddress(),
    deployer: await deployer.getAddress(),
  };
  writeFileSync(join(ROOT, "deployments-testnet.json"), JSON.stringify(out, null, 2));
  console.log("deployments-testnet.json written");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
