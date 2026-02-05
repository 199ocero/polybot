
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { logPaperTradeToDb } from "../db.js";
import { sendDiscordNotification } from "../net/discord.js";

const STATE_FILE = "./src/state/paperState.json";

export class PaperTrader {
  constructor() {
    this.state = this.loadState();
  }

  loadState() {
    const defaultState = {
      balance: CONFIG.paper.initialBalance,
      positions: [], // Array of { side, amount, entryPrice, shares, marketSlug, entryTime, hitBreakevenTrigger }
      dailyLoss: 0,
      lastStopLossTime: 0,
      recentResults: [], // ['WIN', 'LOSS', ...]
      lastDailyReset: Date.now(),
      lastDailyReset: Date.now(),
      lastExitTime: 0,
      lastEntryTime: 0, // Track when we last opened a position
      consecutiveLosses: 0 // New: Track streak
    };

    try {
      if (fs.existsSync(STATE_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        return { ...defaultState, ...loaded };
      }
    } catch (err) {
      console.error("Failed to load paper state:", err);
    }

    return defaultState;
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save paper state:", err);
    }
  }



  async logTrade(action, side, price, amount, shares, pnl, marketSlug, fee = 0) {
    await logPaperTradeToDb({
      action,
      side,
      price,
      amount,
      shares,
      pnl,
      balance: this.state.balance,
      market_slug: marketSlug,
      fee
    });
  }

  // Called every tick
  async update({ signal, rec, prices, market, tokens, trend }) {
    if (!market || !rec) return;

    // 0. Reset Daily Loss if new day
    this.resetDailyLossIfNeeded();
    // Pass extra context for expiry check
    await this.checkResolution(market, prices, { 
      isExpired: rec.isExpired || false, 
      strikePrice: rec.strikePrice || null, 
      spotPrice: rec.spotPrice || null 
    });

    // 2. Check Take Profit
    // We can do this before or after Entry. Usually good to check managing current pos first.
    // 2. Check Exits (TP / SL)
    await this.checkExitConditions(market, prices, { timeLeftMin: rec.timeLeftMin });

    // 3. Execute Signals
    const marketSlug = market.slug;
    const priceUp = prices.up;
    const priceDown = prices.down;

    if (rec.action === "ENTER") {
      await this.handleEntrySignal(rec, rec.side, rec.strength, marketSlug, priceUp, priceDown, trend);
    }
  }

  resetDailyLossIfNeeded() {
    const last = new Date(this.state.lastDailyReset || 0);
    const now = new Date();
    // Reset if day changed (UTC)
    if (last.getUTCDate() !== now.getUTCDate()) {
      console.log(`[Paper] New day detected. Resetting Daily Loss (Prev: $${this.state.dailyLoss.toFixed(2)})`);
      this.state.dailyLoss = 0;
      this.state.lastDailyReset = now.getTime();
      this.saveState();
    }
  }

  async checkExitConditions(market, prices, { timeLeftMin } = {}) {
    if (!this.state.positions || this.state.positions.length === 0) return;

    // Use a copy to iterate because we might remove items
    const activePositions = [...this.state.positions];
    
    for (const pos of activePositions) {
        if (pos.marketSlug !== market.slug) continue;

        const { side, entryPrice, entryTime } = pos;
        const price = side === "UP" ? prices.up : prices.down;
        
        if (price === null || price === undefined) continue;

        const normPrice = price > 1.05 ? price / 100 : price;
        const roi = (normPrice - entryPrice) / entryPrice;
        const roiPct = roi * 100;

        // 0. BREAKEVEN TRIGGER
        if (roiPct >= 30 && !pos.hitBreakevenTrigger) {
            pos.hitBreakevenTrigger = true;
            this.saveState();
            console.log(`[Paper] Breakeven Triggered (+${roiPct.toFixed(1)}%). Stop Loss moved to Entry: ${entryPrice.toFixed(2)}`);
        }

        const slRoi = CONFIG.paper.stopLossRoiPct;
        const entryAgeSeconds = (Date.now() - entryTime) / 1000;
        const gracePeriod = CONFIG.paper.stopLossGracePeriodSeconds || 0;

        // 1. HARD STOP LOSS
        if (roiPct <= -slRoi) {
           if (entryAgeSeconds < gracePeriod) continue;

           if (pos.hitBreakevenTrigger && roiPct < 0) {
               await this.closePosition(pos, entryPrice, `STOP_LOSS_BREAKEVEN (Locked Entry)`);
               continue;
           }

           await this.closePosition(pos, price, `STOP_LOSS (${roiPct.toFixed(1)}%)`);
           continue;
        }

        // Breakeven protection
        if (pos.hitBreakevenTrigger && roiPct <= 0) {
            await this.closePosition(pos, entryPrice, `STOP_LOSS_BREAKEVEN (Protection)`);
            continue;
        }

        // 2. HALF-TIME RULE
        if (timeLeftMin !== undefined && timeLeftMin <= 7.5 && roiPct < 0) {
            await this.closePosition(pos, price, `HALF_TIME_EXIT (${roiPct.toFixed(1)}%)`);
            continue;
        }

        // 3. EARLY EXIT
        if (normPrice >= 0.92) {
            await this.closePosition(pos, price, `TAKE_PROFIT_92 (Lock Win)`);
            continue;
        }
        if (roiPct >= 80) {
            await this.closePosition(pos, price, `TAKE_PROFIT_ROI_80 (+${roiPct.toFixed(1)}%)`);
            continue;
        }
    }
  }

  async checkResolution(market, prices, { isExpired, strikePrice, spotPrice } = {}) {
    if (!this.state.positions || this.state.positions.length === 0) return;

    if (isExpired && strikePrice !== null && spotPrice !== null) {
      const activePositions = [...this.state.positions];
      for (const pos of activePositions) {
        if (pos.marketSlug !== market.slug) continue;
        const side = pos.side;
        let win = false;
        if (side === "UP") win = spotPrice >= strikePrice;
        else if (side === "DOWN") win = spotPrice < strikePrice;
        
        await this.closePosition(pos, win ? 1 : 0, `EXPIRY (Spot: ${spotPrice}, Strike: ${strikePrice})`);
      }
    }
  }

  getUnrealizedPnL(prices) {
    if (!this.state.positions || this.state.positions.length === 0) return 0;
    
    let totalPnl = 0;
    for (const pos of this.state.positions) {
        let currentPrice = pos.side === "UP" ? prices.up : prices.down;
        if (currentPrice === null || currentPrice === undefined) continue;
        
        const normalizedCurr = currentPrice > 1.05 ? currentPrice / 100 : currentPrice;
        const currentValue = pos.shares * normalizedCurr;
        totalPnl += (currentValue - pos.amount);
    }
    return totalPnl;
  }

  async closePosition(pos, exitPrice, reason) {
    const { side, shares, amount, marketSlug } = pos;
    
    const normalizedExit = exitPrice > 1.05 ? exitPrice / 100 : exitPrice;
    let proceeds = shares * normalizedExit;
    
    let fee = 0;
    if (reason !== "EXPIRY" && reason !== "SETTLE") {
        fee = proceeds * (CONFIG.paper.feePct / 100);
        proceeds -= fee;
    }

    const pnl = proceeds - amount;
    this.state.balance += proceeds;
    
    if (pnl < 0) {
        this.state.dailyLoss = (this.state.dailyLoss || 0) + Math.abs(pnl);
        this.state.recentResults = [...(this.state.recentResults || []), "LOSS"].slice(-10);
        if (reason.includes("STOP_LOSS")) {
            this.state.lastStopLossTime = Date.now();
        }
        this.state.consecutiveLosses = (this.state.consecutiveLosses || 0) + 1;
    } else {
        this.state.dailyLoss = (this.state.dailyLoss || 0) - pnl;
        this.state.recentResults = [...(this.state.recentResults || []), "WIN"].slice(-10);
        this.state.consecutiveLosses = 0;
    }

    await this.logTrade(reason, side, exitPrice, amount, shares, pnl, marketSlug, fee);

    sendDiscordNotification({
      type: pnl >= 0 ? "WIN" : "LOSS",
      side,
      price: exitPrice,
      shares,
      pnl,
      balance: this.state.balance,
      marketSlug,
      reason,
      amount: proceeds,
      fee
    });

    // Remove from array
    this.state.positions = this.state.positions.filter(p => p !== pos);
    
    // For Penalty Box: Reverted as it backfired (Phase 7). 
    // We now rely on Max Concurrent = 2 to limit damage.
    this.state.lastExitTime = Date.now();

    this.saveState();
    console.log(`[Paper] Closed ${side} at ${exitPrice} (${reason}). PnL: $${pnl.toFixed(2)} (Fee: $${fee.toFixed(2)}) DailyNetLoss: $${this.state.dailyLoss.toFixed(2)}`);
  }

  async handleEntrySignal(rec, side, strength, marketSlug, priceUp, priceDown, trend) {
    const currentPos = this.state.position;
    
    // Price safety
    const entryPrice = side === "UP" ? priceUp : priceDown;
    if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) return;
    const normalizedPrice = entryPrice > 1 ? entryPrice / 100 : entryPrice;
    
    // Default Trade Amount (Manual Override fallback)
    let tradeAmount = CONFIG.paper.maxBet; 

    // --- FILTERS & CHECKS ---
    
    // 0. Price Guard (Lottery Ticket Prevention)
    if (normalizedPrice < CONFIG.paper.minEntryPrice || normalizedPrice > CONFIG.paper.maxEntryPrice) {
        console.log(`[Paper] Blocked Entry: Price ${normalizedPrice.toFixed(2)} out of range (${CONFIG.paper.minEntryPrice}-${CONFIG.paper.maxEntryPrice})`);
        return;
    }

    // 0b. Consecutive Loss Circuit Breaker
    if ((this.state.consecutiveLosses || 0) >= CONFIG.paper.maxConsecutiveLosses) {
        console.log(`[Paper] Blocked Entry: Max consecutive losses reached (${this.state.consecutiveLosses}). Manual reset required.`);
        return; 
    }

    // 0c. Duplicate Position Guard
    if (this.state.position && this.state.position.marketSlug === marketSlug) {
         // console.log(`[Paper] Blocked Entry: Already have a position in ${marketSlug}.`);
         return;
    }
    
    // Log Probability for debugging
    if (rec) {
       console.log(`[Probability] Model: ${rec.probability?.toFixed(2)} Market: ${normalizedPrice.toFixed(2)} Edge: ${rec.edge?.toFixed(2)} Strength: ${strength}`);
    }

    // 1. Daily Loss Limit
    // User said: "below -10". So if dailyLoss > 10, we stop.
    if ((this.state.dailyLoss || 0) >= CONFIG.paper.dailyLossLimit) {
        // Only log once per minute to avoid spam? Or just return silent?
        // console.log("[Paper] Daily Loss Limit Hit. No new trades.");
        return;
    }

    // 2. Cooldown after Stop Loss
    if (this.state.lastStopLossTime) {
        const msSince = Date.now() - this.state.lastStopLossTime;
        const minsSince = msSince / 60000;
        if (minsSince < CONFIG.paper.cooldownMinutes) {
            // console.log(`[Paper] Cooldown active (${minsSince.toFixed(1)}m / ${CONFIG.paper.cooldownMinutes}m).`);
            return;
        }
    }

    // 2b. Entry Debounce (15 Seconds)
    if (this.state.lastEntryTime) {
        const msSinceEntry = Date.now() - this.state.lastEntryTime;
        const entryDebounceMs = (CONFIG.paper.entryCooldownSeconds || 15) * 1000;
        if (msSinceEntry < entryDebounceMs) {
            // console.log(`[Paper] Entry Debounce active (${(msSinceEntry/1000).toFixed(0)}s < ${CONFIG.paper.entryCooldownSeconds}s)`);
            return;
        }
    }

    // 3. Trend Filter
    // If trend is FALLING (DOWN), don't Long (UP).
    // If trend is RISING (UP), don't Short (DOWN).
    if (trend === "FALLING" && side === "UP") {
        // console.log("[Paper] Trend Block: Market Falling, ignoring UP signal.");
        return;
    }
    if (trend === "RISING" && side === "DOWN") {
        // console.log("[Paper] Trend Block: Market Rising, ignoring DOWN signal.");
        return;
    }

    // 4. Dynamic Position Sizing based on Win Rate
    const results = this.state.recentResults || [];
    const wins = results.filter(r => r === "WIN").length;
    const total = results.length;
    const winRate = total > 0 ? wins / total : 0.5; // Default to 0.5 if no history
    
    // If win rate < 40%, size down to $5.
    // Else (>= 40% or no data), stay at $10 (maxBet).
    // Note: Kelly logic below might override this.
    // The user asked to "Scale position size... reduce size during losing streaks".
    // I will set the base `tradeAmount` here, and let Kelly clamp it if Kelly is enabled/smaller?
    // Actually, existing code uses Kelly to calculate `tradeAmount`.
    // I should apply the scaling factor to the Kelly result or the base.
    
    // Let's set a 'Base Unit':
    let baseUnit = CONFIG.paper.maxBet; // 10
    // Removed dynamic sizing based on winRate < 0.4 to standardize sizing.

    tradeAmount = baseUnit; // Initialize with base unit 

    // KELLY CRITERION CALCULATION
    if (rec && rec.probability) {
        const p = rec.probability; // Probability of Win (e.g. 0.65)
        const q = 1 - p;           // Probability of Loss (e.g. 0.35)
        
        // Net Odds (b): Profit per dollar risked.
        // If Price is 0.40, we risk 0.40 to win 0.60 (Net profit).
        // b = 0.60 / 0.40 = 1.5
        const b = (1 - normalizedPrice) / normalizedPrice;
        
        // Fraction (f) = p - q/b
        let f = p - (q / b);
        
        // Scale by Kelly Fraction (Quarter Kelly etc)
        f = f * CONFIG.paper.kellyFraction;
        
        if (f > 0) {
            const bankroll = this.state.balance;
            let size = bankroll * f;
            
            // Safety Caps
            if (size < CONFIG.paper.minBet) size = CONFIG.paper.minBet;
            if (size > baseUnit) size = baseUnit; // Cap at our dynamic base unit (5 or 10)
            
            // Don't bet more than we have
            if (size > bankroll) size = bankroll;
            
            tradeAmount = size;
            // console.log(`[Kelly] p=${p.toFixed(2)} price=${normalizedPrice.toFixed(2)} b=${b.toFixed(2)} f=${f.toFixed(2)} => Bet: $${tradeAmount.toFixed(2)}`);
        } else {
            // Kelly says negative edge? 
            // If model signals positive edge but Kelly says no, it implies price is too expensive for the edge.
            // We can skip or bet min. Let's bet Min to respect the "Signal" but cautious.
            tradeAmount = CONFIG.paper.minBet;
        }
    } else {
        // No Kelly (Probability missing)? Use base unit.
        tradeAmount = baseUnit;
    } 

    // FLIP FLOP LOGIC (Reversal)
    const marketPositions = this.state.positions.filter(p => p.marketSlug === marketSlug);
    if (marketPositions.length > 0) {
      if (marketPositions[0].side !== side) {
        console.log(`[Paper] FLIPPING POSITIONS: ${marketPositions[0].side} -> ${side}`);
        for (const pos of marketPositions) {
            await this.closePosition(pos, (side === "UP" ? priceUp : priceDown), "FLIP_CLOSE");
        }
      }
    }

    // OPEN NEW POSITION (Balanced Stacking - Power of 2)
    const maxPos = CONFIG.paper.maxConcurrentPositions || 2;
    if (this.state.positions.length < maxPos && this.state.balance >= tradeAmount) {
       const shares = tradeAmount / normalizedPrice;
       const fee = tradeAmount * (CONFIG.paper.feePct / 100);
       const totalCost = tradeAmount + fee;

       this.state.balance -= totalCost;
       this.state.positions.push({
         marketSlug,
         side,
         entryPrice: normalizedPrice,
         amount: totalCost,
         shares,
         entryTime: Date.now(),
         hitBreakevenTrigger: false
       });
       
       this.state.lastEntryTime = Date.now(); // Track entry for debounce
       
       await this.logTrade("OPEN", side, entryPrice, tradeAmount, shares, null, marketSlug, fee);
       
       // Discord Notification
       sendDiscordNotification({
         type: "OPEN",
         side,
         price: entryPrice,
         shares,
         amount: tradeAmount, // Cost
         balance: this.state.balance,
         marketSlug,
         fee
       });

       this.saveState();
       console.log(`[Paper] Entered ${side} at ${entryPrice} (Amt: $${tradeAmount} + Fee: $${fee.toFixed(2)})`);
    } else if (this.state.balance < tradeAmount) {
      console.log("[Paper] Insufficient balance for trade.");
    }
  }
  getBlockingReason(side, trend) {
    // 1. Daily Loss Limit
    if ((this.state.dailyLoss || 0) >= CONFIG.paper.dailyLossLimit) {
      return "Daily Loss Limit";
    }

    // 2. Penalty Box / Cooldown Logic: Reverted in Phase 7 to prioritize recovery trades.
    // We strictly use the 15s entry debounce (below) and max 2 positions.

    // 2b. Entry Debounce (15 Seconds)
    if (this.state.lastEntryTime) {
        const msSinceEntry = Date.now() - this.state.lastEntryTime;
        const entryDebounceMs = (CONFIG.paper.entryCooldownSeconds || 15) * 1000;
        if (msSinceEntry < entryDebounceMs) {
            const remaining = Math.ceil((entryDebounceMs - msSinceEntry) / 1000);
            return `Entry Debounce (${remaining}s)`;
        }
    }

    // 3. Trend Filter
    if (trend === "FALLING" && side === "UP") {
      return "Trend (Falling vs Up)";
    }
    if (trend === "RISING" && side === "DOWN") {
      return "Trend (Rising vs Down)";
    }

    // 4. Insufficient Balance (Estimate based on Min Bet)
    // We don't know the exact price here easily without passing it, but we can check raw balance vs minBet
    if (this.state.balance < CONFIG.paper.minBet) {
       return "Insufficient Balance";
    }

    return null; // Not blocked
  }
}
