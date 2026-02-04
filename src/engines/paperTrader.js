
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { logPaperTradeToDb } from "../db.js";

const STATE_FILE = "./src/state/paperState.json";

export class PaperTrader {
  constructor() {
    this.state = this.loadState();
  }

  loadState() {
    const defaultState = {
      balance: CONFIG.paper.initialBalance,
      position: null, // { side: 'UP'|'DOWN', amount: 10, entryPrice: 0.50, shares: 20, marketSlug: '...' }
      dailyLoss: 0,
      lastStopLossTime: 0,
      recentResults: [], // ['WIN', 'LOSS', ...]
      lastDailyReset: Date.now(),
      lastDailyReset: Date.now(),
      lastExitTime: 0, // Track when we last closed a position
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
    if (!this.state.position) return;
    if (this.state.position.marketSlug !== market.slug) return;

    // 1. TIME GUARD (Late Game)
    // If < 2 mins left, we HOLD everything to expiry.
    // - TP: Don't sell winning bags at discount.
    // - SL: Don't panic sell at bottom. Volume likely thin.
    if (timeLeftMin !== undefined && timeLeftMin < 2) {
        return; 
    }

    const { side, entryPrice } = this.state.position;
    const price = side === "UP" ? prices.up : prices.down;
    
    // SAFETY: If price is missing (null/undefined), do nothing.
    if (price === null || price === undefined) return;

    // Normalize logic
    const isCents = price > 1.5; 
    const normPrice = isCents ? price / 100 : price;
    
    // Calculate ROI
    // ROI = (Current - Entry) / Entry
    if (!entryPrice) return;
    const roi = (normPrice - entryPrice) / entryPrice;
    const roiPct = roi * 100;

    const tpRoi = CONFIG.paper.takeProfitRoiPct; // e.g. 20
    const slRoi = CONFIG.paper.stopLossRoiPct;   // e.g. 25
    
    // A. TAKE PROFIT (ROI)
    if (roiPct >= tpRoi) {
       // Hybrid Guard: 
       // If signal is VERY STRONG (> 0.75), hold for max profit ($0.95/$1.00).
       // If signal is just "Winning" (0.50 - 0.75), secure the profit now (volatility protection).
       if (normPrice > 0.75) {
           return; 
       }

       // Optional: Ensure we cover fees?
       // Fee is ~4% round trip. If TP is 20%, we are fine.
       await this.closePosition(price, `TAKE_PROFIT_ROI (+${roiPct.toFixed(1)}%)`);
       return;
    }

    // B. STOP LOSS
    // Check Grace Period
    const entryTime = this.state.position.entryTime || 0;
    const secondsSinceEntry = (Date.now() - entryTime) / 1000;
    const gracePeriod = CONFIG.paper.stopLossGracePeriodSeconds || 0;

    if (roiPct <= -slRoi) {
       // Favor Guard: If price > 0.50, don't stop loss.
       if (normPrice > 0.50) {
           return; 
       }

       if (secondsSinceEntry < gracePeriod) {
           // console.log(`[Paper] Stop Loss HIT but ignored (Grace Period: ${secondsSinceEntry.toFixed(0)}s < ${gracePeriod}s)`);
           return;
       }
       await this.closePosition(price, `STOP_LOSS (${roiPct.toFixed(1)}%)`);
       return;
    }
    
    // C. Legacy High Price Target (0.95)
    // If price shoots to 0.95 instantly, logic A caches it (ROI is huge). 
    // So distinct check not strictly needed unless Entry was 0.80 (ROI < 20%).
    if (normPrice >= CONFIG.paper.takeProfitPrice) {
        await this.closePosition(price, "TAKE_PROFIT_HIGH");
        return;
    }
  }

  async checkResolution(market, prices, { isExpired, strikePrice, spotPrice } = {}) {
    if (!this.state.position) return;
    
    // Safety: If market changed, maybe force close?
    // But better to handle expiration explicitly.
    // If the tracked market is different from current, and we haven't settled, 
    // we might be orphaned. Ideally we catch it on the tick OF expiration.

    if (this.state.position.marketSlug !== market.slug) {
        // We switched markets. The old one is gone from 'market' obj.
        // We can't really settle accurately unless we stored the old strike.
        // For now, let's rely on 'isExpired' flag passed just before the switch ideally.
        return; 
    }

    // A. TIME EXPIRY SETTLEMENT
    if (isExpired && strikePrice !== null && spotPrice !== null) {
      const side = this.state.position.side;
      let win = false;
      
      // Polymarket Rules: 
      // UP = Spot >= Strike
      // DOWN = Spot < Strike
      if (side === "UP") win = spotPrice >= strikePrice;
      else if (side === "DOWN") win = spotPrice < strikePrice;
      
      await this.closePosition(win ? 1 : 0, `EXPIRY (Spot: ${spotPrice}, Strike: ${strikePrice})`);
      return;
    }

    // B. EARLY SETTLEMENT REMOVED
    // User requested to wait until time expiry (0) even if price hits 0 or 100.
    // This allows for potential recovery from near-zero prices.
  }

  getUnrealizedPnL(prices) {
    if (!this.state.position) return null;
    const { side, shares, entryPrice, amount, marketSlug } = this.state.position;
    
    // Current Price
    let currentPrice = side === "UP" ? prices.up : prices.down;
    if (currentPrice === null || currentPrice === undefined) return 0;
    
    // Normalize current price to match entryPrice scale (DOLLARS)
    // If entryPrice was stored as normalized (0.57), and currentPrice is 57, we divide.
    // In handleEntrySignal we did: `const normalizedPrice = entryPrice > 1 ? entryPrice / 100 : entryPrice;`
    // So entryPrice is ALWAYS 0-1.
    
    const normalizedCurr = currentPrice > 1.05 ? currentPrice / 100 : currentPrice;
    
    const currentValue = shares * normalizedCurr;
    return currentValue - amount;
  }

  async closePosition(exitPrice, reason) {
    if (!this.state.position) return;
    const { side, shares, amount, marketSlug } = this.state.position;
    
    const normalizedExit = exitPrice > 1.05 ? exitPrice / 100 : exitPrice;
    let proceeds = shares * normalizedExit;
    
    // Apply Exit Fee (except for Expiry Settlement which is usually free/rebated? 
    // Actually standard rule: taker fee applies to "matched" orders. EXPIRY is settlement, usually 0 fee.
    // So if reason === 'EXPIRY' or 'SETTLE' (100/0), maybe no fee?
    // User asked to simulate fees. Standard is fee on trade. Settlement is redemption.
    // Redemption is free.
    // So ONLY apply fee if we are SELLING (Flip, TP).

    let fee = 0;
    if (reason !== "EXPIRY" && reason !== "SETTLE") {
        fee = proceeds * (CONFIG.paper.feePct / 100);
        proceeds -= fee;
    }

    const pnl = proceeds - amount;
    
    this.state.balance += proceeds;
    
    // Track Metrics
    if (pnl < 0) {
        this.state.dailyLoss = (this.state.dailyLoss || 0) + Math.abs(pnl);
        this.state.recentResults = [...(this.state.recentResults || []), "LOSS"].slice(-10);
        if (reason.includes("STOP_LOSS")) {
            this.state.lastStopLossTime = Date.now();
        }
        this.state.consecutiveLosses = (this.state.consecutiveLosses || 0) + 1;
    } else {
        // If profit, maybe reduce daily loss? Usually "Daily Loss Limit" is "Net Loss" or "Gross Loss"?
        // Standard is Net PnL for the day. If I win $10 then lost $10, am I stopped?
        // User said: "Daily Loss Limit = 10.0 ... Stop trading after $10 loss". Usually means Net PnL < -10.
        // But let's track Net Daily PnL.
        // Actually, user said "daily_pnl < -DAILY_LOSS_LIMIT". So it IS Net PnL.
        // So I should subtract PnL from a "Daily PnL" counter.
        // Let's refactor: I defined `dailyLoss` as a positive number representing loss.
        // So: dailyLoss -= pnl. (If pnl is positive, loss decreases. If pnl negative, loss increases).
        this.state.dailyLoss = (this.state.dailyLoss || 0) - pnl;
        this.state.recentResults = [...(this.state.recentResults || []), "WIN"].slice(-10);
        this.state.consecutiveLosses = 0; // Reset streak
    }

    await this.logTrade(reason, side, exitPrice, amount, shares, pnl, marketSlug, fee);
    this.state.position = null;
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

    // 2b. Cooldown after Any Exit
    if (this.state.lastExitTime) {
        const msSinceExit = Date.now() - this.state.lastExitTime;
        const secondsSinceExit = msSinceExit / 1000;
        const cooldownSec = CONFIG.paper.entryCooldownSeconds || 60;
        
        if (secondsSinceExit < cooldownSec) {
            // console.log(`[Paper] Exit Cooldown active (${secondsSinceExit.toFixed(0)}s < ${cooldownSec}s)`);
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
    if (currentPos) {
      if (currentPos.side !== side && currentPos.marketSlug === marketSlug) {
        // Favor Guard: If we are holding a winning position (> 0.50), don't flip.
        const heldPrice = currentPos.side === "UP" ? priceUp : priceDown;
        const normHeldPrice = heldPrice > 1 ? heldPrice / 100 : heldPrice;
        
        if (normHeldPrice > 0.50) {
            console.log(`[Paper] Flip Blocked: Holding ${currentPos.side} at ${normHeldPrice.toFixed(2)} (> 0.50). Ignoring ${side} signal.`);
            return;
        }

        // REVERSE: Close current, Open new
        console.log(`[Paper] FLIPPING POSITION: ${currentPos.side} -> ${side}`);
        
        // 1. Sell Current
        await this.closePosition((currentPos.side === "UP" ? priceUp : priceDown), "FLIP_CLOSE"); 

        // 2. Open New
        // Proceed to open logic below
      } else {
        // Same side? Hold.
        // Optional: pyamid (add more) if Strong? For now, simple HOLD.
        return; 
      }
    }

    // OPEN NEW POSITION
    if (!this.state.position && this.state.balance >= tradeAmount) {
       const shares = tradeAmount / normalizedPrice;
       
       // Apply Entry Fee
       const fee = tradeAmount * (CONFIG.paper.feePct / 100);
       const totalCost = tradeAmount + fee;

       this.state.balance -= totalCost;
       this.state.position = {
         marketSlug,
         side,
         entryPrice: normalizedPrice,
         amount: totalCost, // Cost basis includes fee for PnL
         shares,
         entryTime: Date.now() // Capture Entry Time for Grace Period
       };
       
       await this.logTrade("OPEN", side, entryPrice, tradeAmount, shares, null, marketSlug, fee);
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

    // 2. Cooldown after Stop Loss
    if (this.state.lastStopLossTime) {
      const msSince = Date.now() - this.state.lastStopLossTime;
      const minsSince = msSince / 60000;
      if (minsSince < CONFIG.paper.cooldownMinutes) {
        const remaining = Math.ceil(CONFIG.paper.cooldownMinutes - minsSince);
        return `Cooldown (${remaining}m)`;
      }
    }

    // 2b. Cooldown after Any Exit (User Request)
    if (this.state.lastExitTime) {
      const msSinceExit = Date.now() - this.state.lastExitTime;
      const secondsSinceExit = msSinceExit / 1000;
      const cooldownSec = CONFIG.paper.entryCooldownSeconds || 60;
      
      if (secondsSinceExit < cooldownSec) {
        const remaining = Math.ceil(cooldownSec - secondsSinceExit);
        return `Exit Cooldown (${remaining}s)`;
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
