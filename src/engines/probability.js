import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    delta,
    gap,
    priceToBeat // New input
  } = inputs;

  let up = 1;
  let down = 1;

  if (price !== null && vwap !== null) {
    if (price > vwap) up += 2;
    if (price < vwap) down += 2;
  }

  // ITM (In The Money) Bonus
  // If we are already winning the bet, we should be more confident unless momentum is strictly against us
  if (price !== null && priceToBeat !== null) {
      if (price > priceToBeat) {
          up += 2; // ITM Long
          // If ITM + Gap Support, Boost
          if (gap !== null && gap > 10) up += 2;
      }
      if (price < priceToBeat) {
          down += 2; // ITM Short
          // If ITM + Gap Support, Boost
          if (gap !== null && gap < -10) down += 2;
      }
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += 2;
    if (vwapSlope < 0) down += 2;
  }

  if (rsi !== null) {
    // Standard Momentum
    if (rsiSlope !== null) {
        if (rsi > 55 && rsiSlope > 0) up += 2;
        if (rsi < 45 && rsiSlope < 0) down += 2;
    }

    // Mean Reversion / Anti-Chase Logic
    if (rsi < 30) {
        down -= 2; // Penalize shorting into oversold
        up += 1;   // Slight boost to mean reversion
    }
    if (rsi > 70) {
        up -= 2;   // Penalize longing into overbought
        down += 1; // Slight boost to mean reversion
    }
  }

  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 2;
    if (expandingRed) down += 2;

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  if (heikenColor) {
    // Trend Strength Logic
    let trendScore = 1;
    if (heikenCount >= 5) trendScore = 2; // Strong trend
    if (heikenCount >= 8) trendScore = 3; // Extreme trend

    if (heikenColor === "green" && heikenCount >= 2) up += trendScore;
    if (heikenColor === "red" && heikenCount >= 2) down += trendScore;
  }

  if (delta !== null && delta !== undefined) {
    if (delta > 0) up += 2;
    if (delta < 0) down += 2;
  }

  // BINANCE GAP LOGIC (Magnet)
  if (gap !== null && gap !== undefined) {
      if (gap > 60) up += 4; // Huge Magnet UP
      else if (gap > 30) up += 2; // Strong Magnet UP
      else if (gap > 10) up += 1; // Weak Magnet UP
      
      if (gap < -60) down += 4; // Huge Magnet DOWN
      else if (gap < -30) down += 2; // Strong Magnet DOWN
      else if (gap < -10) down += 1; // Weak Magnet DOWN
  }

  if (failedVwapReclaim === true) down += 3;

  // CONFLICT CHECKS
  // If RSI is oversold (< 25) AND Candles are Green -> Kill the Down Score
  if (rsi !== null && rsi < 25 && heikenColor === "green") {
    down = Math.max(0, down - 3);
  }
   // If RSI is overbought (> 75) AND Candles are Red -> Kill the Up Score
  if (rsi !== null && rsi > 75 && heikenColor === "red") {
    up = Math.max(0, up - 3);
  }

  // FADE PROTECTION: Don't fight a strong trend unless GAP is huge
  if (heikenCount >= 6) {
      const isLargeGapUp = gap !== null && gap > 50;
      const isLargeGapDown = gap !== null && gap < -50;

      if (heikenColor === "red" && !isLargeGapUp) {
          up = Math.max(0, up - 2); // Penalize fading a strong red trend without gap support
      }
      if (heikenColor === "green" && !isLargeGapDown) {
          down = Math.max(0, down - 2); // Penalize fading a strong green trend without gap support
      }
  }

  const total = up + down;
  const rawUp = total === 0 ? 0.5 : up / total;
  
  return { upScore: up, downScore: down, rawUp };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
