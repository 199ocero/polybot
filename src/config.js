export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://data-api.binance.vision",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down",
    heavyFetchIntervalMs: 5_000 // New: Throttle heavy data (OrderBooks) to 5s
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  paper: {
    initialBalance: Number(process.env.PAPER_BALANCE) || 100,
    feePct: 2.0,
    takeProfitPrice: 0.95, // Legacy/Panic target (High)
    takeProfitRoiPct: 30, // Widen from ~20 to 30% (User req)

    stopLossRoiPct: 20,   // Tightened to 20% (was 35%) per analysis recommendation
    timeGuardMinutes: 3,
    kellyFraction: 0.25, // Quarter Kelly
    minBet: 5,
    maxBet: 10,
    cooldownMinutes: 2, // New: 2m cooldown after stop loss
    entryCooldownSeconds: 15, // Reduced to 15s (Micro-debounce)
    maxConcurrentPositions: 2, // The Power of 2: Balanced approach
    penaltyBoxCooldownSeconds: 300, // 5 Minutes for Hard Losses
    dailyLossLimit: 100.0, // Increased to 100 (was 10)daily loss
    maxConsecutiveLosses: Number(process.env.PAPER_MAX_CONSECUTIVE_LOSSES) || 5, // New: Stop after N losses
    minEntryPrice: 0.40, // New: Min price (Drift hunting $0.40-$0.60)
    maxEntryPrice: 0.60, // New: Max price
    stopLossGracePeriodSeconds: 15, // New: 15s grace period (was 60s) for Stop Loss
    entryDeadlineMinutes: 4 // End Guard (Don't enter in last 4 mins)
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || ""
  }
};
