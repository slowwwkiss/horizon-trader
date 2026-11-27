// server.js — HTTP dashboard + conversational interface for Horizon Trader.
// Serves ../ui/ and exposes:
//   GET  /api/state  -> agent snapshot (positions, PnL, signal, history)
//   POST /api/chat   { message } -> command replies in plain language
// Commands: status | positions | pnl | pause | resume | set size <bps> |
//           set risk <bps> | set stoploss <bps> | weights | history

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { HorizonAgent } from "./agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "ui");
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

export function handleChat(agent, message) {
  const msg = (message || "").trim().toLowerCase();
  const snap = agent.getState();
  const v = snap.vault;
  const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toFixed(d));

  if (!msg || msg === "status" || msg === "help") {
    return [
      `Status: ${v ? `vault ${fmt(v.vaultValue)} mUSDC, position ${fmt(v.positionBase)} mHSK @ entry ${fmt(v.entryPrice)}` : "waiting for first tick"}`,
      `Spot ${fmt(snap.spot, 4)} mUSDC/mHSK, TWAP ${fmt(snap.twap, 4)}, regime ${snap.signal?.regime || "—"}, score ${fmt(snap.signal?.score)}`,
      `PnL today ${fmt((snap.pnlPct || 0) * 100)}%, trades ${snap.trades.length}, ticks ${snap.tick}`,
      `Try: positions, pnl, pause, resume, set size 1500, set risk 500, weights`,
    ].join("\n");
  }
  if (msg === "positions" || msg === "position") {
    if (!v) return "No vault data yet, the agent is still on its first tick.";
    return `Position: ${fmt(v.positionBase)} mHSK, entry ${fmt(v.entryPrice)} mUSDC, current value ${fmt(v.positionValue)} mUSDC. Vault total ${fmt(v.vaultValue)} mUSDC, day start ${fmt(v.dayStartValue)} mUSDC.`;
  }
  if (msg === "pnl") {
    if (!v) return "No vault data yet.";
    const day = ((snap.pnlPct || 0) * 100).toFixed(2);
    const last = snap.trades[snap.trades.length - 1];
    return `PnL today: ${day}% (vault ${fmt(v.vaultValue)} vs day start ${fmt(v.dayStartValue)} mUSDC). ${snap.trades.length} trades so far${last ? `, last ${last.action} ${last.sizeBps}bps @ ${fmt(last.spot, 4)}` : ""}.`;
  }
  if (msg === "pause" || msg === "resume") {
    return "Pause and resume are on-chain admin actions — use the vault owner account (cast send) to pause. The agent itself never pauses the vault, it only stops trading when the risk gate says so.";
  }
  const mSize = msg.match(/^set size (\d+)$/);
  if (mSize) {
    const bps = Number(mSize[1]);
    if (bps < 100 || bps > 2000) return "Size must be 100–2000 bps (1–20% of vault per trade).";
    agent.config.baseSizeBps = bps;
    return `Base trade size set to ${bps} bps (${(bps / 100).toFixed(1)}% of vault value at full conviction).`;
  }
  const mRisk = msg.match(/^set risk (\d+)$/);
  if (mRisk) {
    const bps = Number(mRisk[1]);
    if (bps < 100 || bps > 2000) return "Daily loss limit must be 100–2000 bps. This only changes the agent's own view — the on-chain maxDailyLossBps stays as deployed.";
    agent.config.maxDailyLossBps = bps;
    return `Agent daily-loss view set to ${bps} bps. Note: the vault contract still enforces its own limit on-chain.`;
  }
  const mSl = msg.match(/^set stoploss (\d+)$/);
  if (mSl) {
    const bps = Number(mSl[1]);
    if (bps < 100 || bps > 2000) return "Stop-loss must be 100–2000 bps.";
    agent.config.stopLossBps = bps;
    return `Agent stop-loss view set to ${bps} bps. Note: the vault contract still enforces its own stop-loss on-chain.`;
  }
  if (msg === "weights") {
    const w = snap.weights || {};
    return `Model weights — momentum ${fmt(w.momentum)}, mean reversion ${fmt(w.meanReversion)}, volume ${fmt(w.volume)}. They adapt after every closed trade: factors that called the direction right gain weight when the trade profits.`;
  }
  if (msg === "history" || msg === "trades") {
    if (!snap.trades.length) return "No trades yet.";
    return snap.trades.slice(-5).map((t) => `#${t.tick} ${t.action} ${t.sizeBps}bps @ ${fmt(t.spot, 4)}${t.note ? ` (${t.note})` : ""}`).join("\n");
  }
  return "I understand: status, positions, pnl, weights, history, set size <bps>, set risk <bps>, set stoploss <bps>.";
}

async function main() {
  const agent = new HorizonAgent();
  await agent.init();
  agent.startedAt = Date.now();
  // Run the loop in the background; the server stays responsive.
  (async () => {
    while (!agent.stopped) {
      const snap = await agent.tick();
      agent._lastState = snap.vault
        ? { spot: snap.spot, twap: snap.twap, vault: snap.vault }
        : agent._lastState;
      await new Promise((r) => setTimeout(r, agent.tickMs));
    }
  })();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(agent.getState()));
        return;
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let message = "";
          try { message = JSON.parse(body).message || ""; } catch { /* ignore */ }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: handleChat(agent, message) }));
        });
        return;
      }
      let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const path = join(UI_DIR, file);
      if (!existsSync(path) || !path.startsWith(UI_DIR)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
      res.end(readFileSync(path));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e?.message || e));
    }
  });

  server.listen(PORT, () => {
    console.log(`dashboard at http://localhost:${PORT}`);
  });
  process.on("SIGINT", () => { agent.stop(); server.close(); process.exit(0); });
  process.on("SIGTERM", () => { agent.stop(); server.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("server fatal:", e);
    process.exit(1);
  });
}
