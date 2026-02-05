import sqlite3 from "sqlite3";
import path from "node:path";

const DB_PATH = path.resolve("./logs/trading_data.db");

// --- SCENARIOS TO TEST ---
const SCENARIOS = [
    { name: "Baseline",   minEntryPrice: 0.30, stopLossRoiPct: 35, takeProfitRoiPct: 30, stopLossGracePeriodSeconds: 15 },
    { name: "HighProfit", minEntryPrice: 0.30, stopLossRoiPct: 35, takeProfitRoiPct: 35, stopLossGracePeriodSeconds: 15 },
    { name: "HighEntry",  minEntryPrice: 0.35, stopLossRoiPct: 35, takeProfitRoiPct: 30, stopLossGracePeriodSeconds: 15 },
    { name: "WinRateMax", minEntryPrice: 0.30, stopLossRoiPct: 40, takeProfitRoiPct: 20, stopLossGracePeriodSeconds: 15 }, // Tried 40/20 based on grid
    { name: "Balanced",   minEntryPrice: 0.35, stopLossRoiPct: 35, takeProfitRoiPct: 35, stopLossGracePeriodSeconds: 15 }
];

const FIXED_CONFIG = {
    initialBalance: 1000,
    maxEntryPrice: 0.80,
    takeProfitPrice: 0.95,
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

function runSimulation(signals, config) {
    let balance = FIXED_CONFIG.initialBalance;
    let position = null; 
    let consecutiveLosses = 0;
    
    let wins = 0;
    let losses = 0;
    let totalTrades = 0;

    for (let i = 0; i < signals.length; i++) {
        const row = signals[i];
        const ts = new Date(row.timestamp).getTime();
        
        // 1. Check Position
        if (position) {
            const strikeChanged = row.price_to_beat !== null && position.marketStrike !== null && row.price_to_beat !== position.marketStrike;
            
            if (strikeChanged) {
                // Settle
                const spot = row.current_price;
                const win = position.side === "UP" ? spot >= position.marketStrike : spot < position.marketStrike;
                const payout = win ? 1.0 : 0.0;
                
                const proceeds = position.shares * payout;
                let pnl = proceeds - position.amount; 
                
                if (pnl > 0) { wins++; consecutiveLosses = 0; }
                else { losses++; consecutiveLosses++; }
                balance += pnl;
                position = null;
                continue;
            }

            const optPrice = position.side === "UP" ? row.mkt_up : row.mkt_down;
             
             if (optPrice !== null && optPrice > 0) {
                 const normPrice = optPrice > 1.05 ? optPrice / 100 : optPrice;
                 const roi = (normPrice - position.entryPrice) / position.entryPrice;
                 const roiPct = roi * 100;
                 const secondsSinceEntry = (ts - position.entryTime) / 1000;
                 
                 // STOP LOSS
                 if (roiPct <= -config.stopLossRoiPct) {
                     if (secondsSinceEntry >= config.stopLossGracePeriodSeconds) {
                         if (normPrice <= 0.50) {
                            const proceeds = position.shares * normPrice;
                            const fee = proceeds * (FIXED_CONFIG.feePct / 100);
                            const pnl = proceeds - fee - position.amount;
                            
                            if (pnl > 0) { wins++; consecutiveLosses = 0; }
                            else { losses++; consecutiveLosses++; }
                            balance += pnl;
                            position = null;
                            continue;
                         }
                     }
                 }
                 
                 // TAKE PROFIT
                 if (roiPct >= config.takeProfitRoiPct) {
                     if (normPrice <= 0.75) {
                        const proceeds = position.shares * normPrice;
                        const fee = proceeds * (FIXED_CONFIG.feePct / 100);
                        const pnl = proceeds - fee - position.amount;
                        
                        if (pnl > 0) { wins++; consecutiveLosses = 0; }
                        else { losses++; consecutiveLosses++; }
                        balance += pnl;
                        position = null;
                        continue;
                     }
                 }
             }
        }

        // 2. Check Entry
        if (!position) {
            const parts = (row.recommendation || "").split(":");
            if (parts.length >= 2) {
                const side = parts[0]; 
                const price = side === "UP" ? row.mkt_up : row.mkt_down;
                if (price !== null) {
                    const normPrice = price > 1.05 ? price / 100 : price;
                    
                    if (normPrice >= config.minEntryPrice && normPrice <= FIXED_CONFIG.maxEntryPrice) {
                        if (consecutiveLosses < FIXED_CONFIG.maxConsecutiveLosses) {
                            totalTrades++;
                            const amount = 10;
                            const shares = amount / normPrice;
                            const fee = amount * (FIXED_CONFIG.feePct / 100);
                            
                            position = {
                                side,
                                entryPrice: normPrice,
                                shares,
                                amount: amount + fee,
                                entryTime: ts,
                                marketStrike: row.price_to_beat
                            };
                        }
                    }
                }
            }
        }
    }

    const netPnL = balance - FIXED_CONFIG.initialBalance;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    
    return {
        winRate,
        netPnL,
        totalTrades,
        wins,
        losses
    };
}

async function runOptimization() {
    console.log("Loading signals...");
    const signals = await getAllSignals();
    
    console.log("\n--- SCENARIO ANALYSIS ---");
    const results = [];
    
    for (const scenario of SCENARIOS) {
        const res = runSimulation(signals, scenario);
        results.push({ ...scenario, ...res });
    }
    
    console.table(results.map(r => ({
        Name: r.name,
        MinEnt: r.minEntryPrice,
        SL: r.stopLossRoiPct + "%",
        TP: r.takeProfitRoiPct + "%",
        WinRate: r.winRate.toFixed(1) + "%",
        Trades: r.totalTrades,
        PnL: "$" + r.netPnL.toFixed(2),
        "W/L": `${r.wins}/${r.losses}`
    })));
}

runOptimization();
