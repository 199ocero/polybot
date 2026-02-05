export function computeEma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;

  const k = 2 / (period + 1);
  let ema = values[0]; // Start with first value as initial EMA (or use SMA for better seed if needed)

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }

  return ema;
}

export function computeEmaSeries(values, period) {
  const series = [];
  if (!Array.isArray(values) || values.length < period) return series;

  const k = 2 / (period + 1);
  let ema = values[0];
  series.push(ema);

  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    series.push(ema);
  }

  return series;
}
