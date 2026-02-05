
import { CONFIG } from "../config.js";

/**
 * Sends a Discord notification via Webhook.
 * @param {Object} data - The trade data.
 * @param {string} data.type - "OPEN", "WIN", "LOSS"
 * @param {string} data.side - "UP" or "DOWN"
 * @param {number} data.price - The price executed at.
 * @param {number} data.shares - Number of shares.
 * @param {number} data.pnl - PnL amount (for closes).
 * @param {number} data.balance - Current paper balance.
 * @param {string} data.marketSlug - Market identifier.
 * @param {string} data.reason - Reason for action (e.g. "STOP_LOSS", "TAKE_PROFIT").
 * @param {number} data.amount - The dollar amount involved (Cost or Proceeds).
 * @param {number} data.fee - Fee paid.
 */
export async function sendDiscordNotification(data) {
  if (!CONFIG.discord.webhookUrl) return;

  try {
    const isWin = data.type === "WIN";
    const isLoss = data.type === "LOSS";
    const isOpen = data.type === "OPEN";

    // Colors: Green (Win), Red (Loss), Blue (Open)
    let color = 0x3498db; // Blue
    if (isWin) color = 0x2ecc71; // Green
    if (isLoss) color = 0xe74c3c; // Red

    const title = isOpen 
      ? `📢 TRADE OPENED: ${data.side}`
      : isWin 
        ? `✅ TRADE WON: ${data.side}`
        : `❌ TRADE LOST: ${data.side}`;

    const pnlText = data.pnl !== undefined 
      ? `${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}`
      : "N/A";

    const fields = [
      { name: "Market", value: data.marketSlug || "Unknown", inline: false },
      { name: "Side", value: data.side, inline: true },
      { name: "Price", value: `$${data.price.toFixed(3)}`, inline: true },
      { name: "Shares", value: data.shares.toFixed(2), inline: true },
    ];

    if (isOpen) {
      fields.push(
        { name: "Cost", value: `$${data.amount.toFixed(2)}`, inline: true },
        { name: "Fee", value: `$${(data.fee || 0).toFixed(2)}`, inline: true }
      );
    } else {
      fields.push(
        { name: "PnL", value: pnlText, inline: true },
        { name: "Reason", value: data.reason || "N/A", inline: true },
        { name: "Fee", value: `$${(data.fee || 0).toFixed(2)}`, inline: true }
      );
    }

    fields.push({ name: "💰 Account Balance", value: `$${data.balance.toFixed(2)}`, inline: false });

    const payload = {
      username: "PolyBot Trader",
      embeds: [
        {
          title: title,
          color: color,
          timestamp: new Date().toISOString(),
          fields: fields,
          footer: {
            text: "PolyBot Automated Trading"
          }
        }
      ]
    };

    await fetch(CONFIG.discord.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

  } catch (err) {
    console.error("[Discord] Failed to send notification:", err);
  }
}
