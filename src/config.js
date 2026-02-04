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
    takeProfitRoiPct: 30, 
    stopLossRoiPct: 25,   // Tightened to 25% (was 15% but user requested widen to 25-30%)
    timeGuardMinutes: 3,
    kellyFraction: 0.25, // Quarter Kelly
    minBet: 5,
    maxBet: 10,
    cooldownMinutes: 2, // New: 2m cooldown after stop loss
    entryCooldownSeconds: 60, // Cooldown after exit before re-entering
    dailyLossLimit: 10.0, // New: Max daily loss
    maxConsecutiveLosses: 3, // New: Stop after 3 losses
    minEntryPrice: 0.20, // New: Min price to enter
    maxEntryPrice: 0.80, // New: Max price to enter
    stopLossGracePeriodSeconds: 60, // New: 60s grace period for Stop Loss
    entryDeadlineMinutes: 4 // End Guard (Don't enter in last 4 mins)
  }
};
