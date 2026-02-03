
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../config.js";
import { appendCsvRow } from "../utils.js";

const STATE_FILE = "./src/state/paperState.json";
const LOG_FILE = "./logs/paper_trades.csv";

export class PaperTrader {
  constructor() {
    this.state = this.loadState();
    this.ensureHeader();
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      }
    } catch (err) {
      console.error("Failed to load paper state:", err);
    }

    return {
      balance: CONFIG.paper.initialBalance,
      position: null // { side: 'UP'|'DOWN', amount: 10, entryPrice: 0.50, shares: 20, marketSlug: '...' }
    };
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save paper state:", err);
    }
  }

  ensureHeader() {
    if (!fs.existsSync(LOG_FILE)) {
      const header = ["Timestamp", "Action", "Side", "Price", "Amount", "Shares", "PnL", "Balance", "Market"];
      appendCsvRow(LOG_FILE, header, []);
    }
  }

  logTrade(action, side, price, amount, shares, pnl, marketSlug, fee = 0) {
    const row = [
      new Date().toISOString(),
      action,
      side,
      price,
      amount.toFixed(2),
      shares.toFixed(2),
      pnl !== null ? pnl.toFixed(2) : "",
      this.state.balance.toFixed(2),
      marketSlug,
      fee.toFixed(4)
    ];
    // Re-read header to ensure we pass it correctly (helper requires it)
    const header = ["Timestamp", "Action", "Side", "Price", "Amount", "Shares", "PnL", "Balance", "Market", "Fee"];
    appendCsvRow(LOG_FILE, header, row);
  }

  // Called every tick
  update({ signal, rec, prices, market, tokens }) {
    if (!market || !rec) return;

    // 1. Check Resolution (Settlement)
    // Pass extra context for expiry check
    this.checkResolution(market, prices, { 
      isExpired: rec.isExpired || false, 
      strikePrice: rec.strikePrice || null, 
      spotPrice: rec.spotPrice || null 
    });

    // 2. Check Take Profit
    // We can do this before or after Entry. Usually good to check managing current pos first.
    // 2. Check Exits (TP / SL)
    this.checkExitConditions(market, prices, { timeLeftMin: rec.timeLeftMin });

    // 3. Execute Signals
    const marketSlug = market.slug;
    const priceUp = prices.up;
    const priceDown = prices.down;

    if (rec.action === "ENTER") {
      this.handleEntrySignal(rec, rec.side, rec.strength, marketSlug, priceUp, priceDown);
    }
  }

  checkExitConditions(market, prices, { timeLeftMin } = {}) {
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
       // Optional: Ensure we cover fees?
       // Fee is ~4% round trip. If TP is 20%, we are fine.
       this.closePosition(price, `TAKE_PROFIT_ROI (+${roiPct.toFixed(1)}%)`);
       return;
    }

    // B. STOP LOSS
    if (roiPct <= -slRoi) {
       this.closePosition(price, `STOP_LOSS (${roiPct.toFixed(1)}%)`);
       return;
    }
    
    // C. Legacy High Price Target (0.95)
    // If price shoots to 0.95 instantly, logic A caches it (ROI is huge). 
    // So distinct check not strictly needed unless Entry was 0.80 (ROI < 20%).
    if (normPrice >= CONFIG.paper.takeProfitPrice) {
        this.closePosition(price, "TAKE_PROFIT_HIGH");
        return;
    }
  }

  checkResolution(market, prices, { isExpired, strikePrice, spotPrice } = {}) {
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
      
      this.closePosition(win ? 1 : 0, "EXPIRY");
      return;
    }

    // B. EARLY SETTLEMENT (0 or 100)
    // Auto-settle if price hits 100 (WIN) or 0 (LOSS)
    // We use 0.98 and 0.02 to be safe/realistic about liquidity capture or just purely abstract settlement
    const side = this.state.position.side;
    const price = side === "UP" ? prices.up : prices.down;
    
    const isCents = price > 1.5; // heuristic
    const winThresh = isCents ? 98 : 0.98;
    const lossThresh = isCents ? 2 : 0.02;
    const winVal = isCents ? 100 : 1;
    const lossVal = 0;

    let settlePrice = null;
    if (price >= winThresh) settlePrice = winVal;
    else if (price <= lossThresh) settlePrice = lossVal;

    if (settlePrice !== null) {
      this.closePosition(settlePrice, "SETTLE");
    }
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

  closePosition(exitPrice, reason) {
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
    this.logTrade(reason, side, exitPrice, amount, shares, pnl, marketSlug, fee);
    this.state.position = null;
    this.saveState();
    console.log(`[Paper] Closed ${side} at ${exitPrice} (${reason}). PnL: $${pnl.toFixed(2)} (Fee: $${fee.toFixed(2)})`);
  }

  handleEntrySignal(rec, side, strength, marketSlug, priceUp, priceDown) {
    const currentPos = this.state.position;
    
    // Price safety
    const entryPrice = side === "UP" ? priceUp : priceDown;
    if (!entryPrice || entryPrice <= 0 || entryPrice >= 1) return;
    const normalizedPrice = entryPrice > 1 ? entryPrice / 100 : entryPrice;
    
    // Default Trade Amount (Manual Override fallback)
    let tradeAmount = 10; 

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
            if (size > CONFIG.paper.maxBet) size = CONFIG.paper.maxBet;
            
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
    } 

    // FLIP FLOP LOGIC (Reversal)
    if (currentPos) {
      if (currentPos.side !== side && currentPos.marketSlug === marketSlug) {
        // REVERSE: Close current, Open new
        console.log(`[Paper] FLIPPING POSITION: ${currentPos.side} -> ${side}`);
        
        // 1. Sell Current
        this.closePosition((currentPos.side === "UP" ? priceUp : priceDown), "FLIP_CLOSE"); 

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
         shares
       };
       
       this.logTrade("OPEN", side, entryPrice, tradeAmount, shares, null, marketSlug, fee);
       this.saveState();
       console.log(`[Paper] Entered ${side} at ${entryPrice} (Amt: $${tradeAmount} + Fee: $${fee.toFixed(2)})`);
    } else if (this.state.balance < tradeAmount) {
      console.log("[Paper] Insufficient balance for trade.");
    }
  }
}
