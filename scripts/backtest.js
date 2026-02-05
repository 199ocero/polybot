import sqlite3 from "sqlite3";
import path from "node:path";

const DB_PATH = path.resolve("./logs/trading_data.db");

// --- CONFIG TO TEST ---
const CONFIG = {
    initialBalance: 1000,
    minEntryPrice: 0.40,   // Updated
    maxEntryPrice: 0.60,   // Updated
    stopLossRoiPct: 20,    // Updated to 20%
    takeProfitRoiPct: 80,  // Early exit if > 80%
    takeProfitPrice: 0.92, // Early exit if > 0.92
    stopLossGracePeriodSeconds: 15,
    feePct: 2.0,
    maxConsecutiveLosses: 5
};

const db = new sqlite3.Database(DB_PATH);

function getAllSignals() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM signals ORDER BY timestamp ASC", (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

// EMA Helper for backtest
function computeEma(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

async function runBacktest() {
    console.log("Loading signals...");
    const signals = await getAllSignals();
    console.log(`Loaded ${signals.length} signals.`);

    let balance = CONFIG.initialBalance;
    let positions = []; // Array of { side, entryPrice, shares, amount, entryTime, marketStrike, hitBreakevenTrigger }
    let trades = [];
    let consecutiveLosses = 0;
    let priceHistory = [];
    let lastExitTime = 0;
    let lastEntryTime = 0; // New for Phase 5

    for (let i = 0; i < signals.length; i++) {
        const row = signals[i];
        const ts = new Date(row.timestamp).getTime();
        const spot = row.binance_price || row.current_price;
        
        priceHistory.push(spot);
        if (priceHistory.length > 500) priceHistory.shift();

        // 1. CHECK MARKET CONTINUITY / EXPIRY
        if (positions.length > 0) {
            const strikeChanged = row.price_to_beat !== null && positions[0].marketStrike !== null && row.price_to_beat !== positions[0].marketStrike;
            
            if (strikeChanged) {
                const activeOnes = [...positions];
                for (const pos of activeOnes) {
                    const win = pos.side === "UP" ? spot >= pos.marketStrike : spot < pos.marketStrike;
                    const payout = win ? 1.0 : 0.0;
                    closePosition(pos, payout, "EXPIRY_SETTLEMENT", ts, row);
                    // lastExitTime NOT set for expiry
                }
                positions = []; 
            }
        }

        // 2. UPDATE POSITIONS STATUS (SL / TP / HALF-TIME / BREAKEVEN)
        if (positions.length > 0) {
             const activeOnes = [...positions];
             for (const pos of activeOnes) {
                 const optPrice = pos.side === "UP" ? row.mkt_up : row.mkt_down;
                 
                 if (optPrice !== null && optPrice > 0) {
                     const normPrice = optPrice > 1.05 ? optPrice / 100 : optPrice;
                     const roi = (normPrice - pos.entryPrice) / pos.entryPrice;
                     const roiPct = roi * 100;
                     const secondsSinceEntry = (ts - pos.entryTime) / 1000;
                     const timeLeft = row.time_left_min;
                     
                     // BREAKEVEN TRIGGER (+30% ROI)
                     if (roiPct >= 30 && !pos.hitBreakevenTrigger) {
                         pos.hitBreakevenTrigger = true;
                     }

                     // STOP LOSS (-20%)
                     if (roiPct <= -CONFIG.stopLossRoiPct && secondsSinceEntry >= CONFIG.stopLossGracePeriodSeconds) {
                         if (pos.hitBreakevenTrigger && roiPct < 0) {
                             closePosition(pos, pos.entryPrice, `STOP_LOSS_BREAKEVEN (Locked)`, ts, row);
                             positions = positions.filter(p => p !== pos);
                             continue;
                         }
                         closePosition(pos, normPrice, `STOP_LOSS (${roiPct.toFixed(1)}%)`, ts, row);
                         positions = positions.filter(p => p !== pos);
                         continue;
                     }
 
                     // BREAKEVEN PROTECTION
                     if (pos.hitBreakevenTrigger && roiPct <= 0) {
                         closePosition(pos, pos.entryPrice, `STOP_LOSS_BREAKEVEN (Protection)`, ts, row);
                         positions = positions.filter(p => p !== pos);
                         continue;
                     }
                     
                     // HALF-TIME RULE
                     if (timeLeft !== null && timeLeft <= 7.5 && roiPct < 0) {
                         closePosition(pos, normPrice, `HALF_TIME_EXIT (${roiPct.toFixed(1)}%)`, ts, row);
                         positions = positions.filter(p => p !== pos);
                         continue;
                     }
 
                     // TAKE PROFIT
                     if (normPrice >= CONFIG.takeProfitPrice || roiPct >= CONFIG.takeProfitRoiPct) {
                         closePosition(pos, normPrice, `TAKE_PROFIT_EARLY (${roiPct.toFixed(1)}%)`, ts, row);
                         positions = positions.filter(p => p !== pos);
                         continue;
                     }
                 }
             }
        }

        // 3. CHECK ENTRY (Balanced Stacking - Power of 2)
        const maxPos = CONFIG.maxConcurrentPositions || 2;
        if (positions.length < maxPos) {
            // Entry Debounce (Micro-debounce) - After PLACING an order
            const msSinceEntry = ts - lastEntryTime;
            const debounceMs = (CONFIG.entryCooldownSeconds || 15) * 1000;
            if (msSinceEntry < debounceMs) continue;

            const parts = (row.recommendation || "").split(":");
            if (parts.length >= 2) {
                const side = parts[0]; 
                
                // EMA MOMENTUM FILTER
                const ema5 = computeEma(priceHistory, 200); 
                let emaTrend = "NEUTRAL";
                if (ema5) emaTrend = spot > ema5 ? "UP" : "DOWN";

                const trendCheck = (side === "UP" && emaTrend === "UP") || (side === "DOWN" && emaTrend === "DOWN");

                if (trendCheck) {
                    const price = side === "UP" ? row.mkt_up : row.mkt_down;
                    if (price !== null) {
                        const normPrice = price > 1.05 ? price / 100 : price;
                        
                        if (normPrice >= CONFIG.minEntryPrice && normPrice <= CONFIG.maxEntryPrice) {
                            // ENTER (Unrestricted for backtest)
                            positions.push({
                                side,
                                entryPrice: normPrice,
                                shares: 10 / normPrice,
                                amount: 10 * (1 + CONFIG.feePct/100),
                                entryTime: ts,
                                marketStrike: row.price_to_beat,
                                hitBreakevenTrigger: false
                            });
                            lastEntryTime = ts;
                        }
                    }
                }
            }
        }
    }

    // Helper to close
    function closePosition(pos, exitPrice, reason, time, row) {
        const proceeds = pos.shares * exitPrice;
        let pnl = proceeds - pos.amount;
        
        // Fee on Exit? (Only if not Expiry)
        if (reason !== "EXPIRY_SETTLEMENT") {
             const fee = proceeds * (CONFIG.feePct / 100);
             pnl -= fee;
        }

        balance += pnl;
        
        const isWin = pnl > 0;
        if (isWin) consecutiveLosses = 0;
        else consecutiveLosses++;
        
        trades.push({
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(time).toISOString(),
            side: pos.side,
            entryPrice: pos.entryPrice,
            exitPrice: exitPrice,
            pnl: pnl,
            reason: reason,
            strike: pos.marketStrike,
            spotAtExit: row.current_price
        });
        
        // console.log(`[${new Date(time).toISOString()}] CLOSE ${pos.side} @ ${exitPrice.toFixed(2)} (${reason}) PnL: ${pnl.toFixed(2)} Bal: ${balance.toFixed(2)}`);
        
        // Reverted Penalty Box (Phase 7): Set lastExitTime normally
        lastExitTime = time;
    }

    // Report
    console.log("\n--- BACKTEST RESULTS (IMPROVED STRATEGY) ---");
    console.log(`Config: Min/MaxEntry=[${CONFIG.minEntryPrice}-${CONFIG.maxEntryPrice}], SL=${CONFIG.stopLossRoiPct}%`);
    console.log("----------------------------------------------------------------");
    console.log("Entry Time           | Side | Entry | Exit  | PnL     | Reason");
    console.log("----------------------------------------------------------------");
    trades.forEach(t => {
        console.log(`${t.entryTime.slice(11, 19)} | ${t.side.padEnd(4)} | ${t.entryPrice.toFixed(2)}  | ${t.exitPrice.toFixed(2)}  | ${t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(2).padEnd(6)} | ${t.reason}`);
    });
    console.log("----------------------------------------------------------------");
    
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.length - wins;
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
    
    console.log(`Total Trades: ${trades.length}`);
    console.log(`Wins: ${wins} (${winRate.toFixed(1)}%)`);
    console.log(`Losses: ${losses}`);
    console.log(`Final Balance: $${balance.toFixed(2)} (Start: $1000)`);
    console.log(`Net PnL: $${(balance - 1000).toFixed(2)}`);
}

runBacktest();
