/**
 * Email alert service — powered by Resend
 *
 * Setup:
 * 1. Sign up at https://resend.com
 * 2. Go to API Keys → Create API Key (full access)
 * 3. Set RESEND_API_KEY in your environment
 * 4. Verify your sending domain (or use onboarding@resend.dev for testing)
 * 5. Set RESEND_FROM_EMAIL to your verified address
 *
 * Alerts are fire-and-forget — a send failure logs an error but never
 * throws, so it cannot break a price sync run.
 */

import { Resend } from "resend";

// Lazy-initialise so missing key doesn't crash the server on startup
let _resend: Resend | null = null;

function getResend(): Resend {
  if (!_resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESEND_API_KEY not configured. Set it in your environment. " +
          "Get a key at https://resend.com → API Keys."
      );
    }
    _resend = new Resend(apiKey);
  }
  return _resend;
}

const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL ?? "PriceSync <alerts@pricesync.app>";

export interface PriceAlertParams {
  to: string;
  productTitle: string;
  actionTaken: string;
  actionDetail: string;
  previousPrice: number;
  newPrice: number;
  changePercent: number;
}

/**
 * Send a price alert email. Never throws — logs errors instead.
 */
export async function sendPriceAlert(params: PriceAlertParams): Promise<void> {
  const {
    to,
    productTitle,
    actionTaken,
    actionDetail,
    previousPrice,
    newPrice,
    changePercent,
  } = params;

  const direction = changePercent >= 0 ? "rose" : "dropped";
  const sign = changePercent >= 0 ? "+" : "";
  const subject = `PriceSync Alert — ${productTitle}: price ${direction} ${sign}${changePercent.toFixed(1)}%`;

  const text = [
    `PriceSync Price Alert`,
    ``,
    `Product : ${productTitle}`,
    `Action  : ${actionTaken.replace(/_/g, " ")}`,
    `Detail  : ${actionDetail}`,
    ``,
    `Previous price : £${previousPrice.toFixed(2)}`,
    `New price      : £${newPrice.toFixed(2)}`,
    `Change         : ${sign}${changePercent.toFixed(1)}%`,
    ``,
    `---`,
    `This alert was sent automatically by PriceSync for Shopify.`,
    `To disable email alerts, open PriceSync in your Shopify admin → Settings.`,
  ].join("\n");

  try {
    const resend = getResend();
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      text,
    });
    console.log(`[Resend] Alert sent to ${to} for: ${productTitle}`);
  } catch (error) {
    // Log but never propagate — alert failure must not interrupt sync
    console.error(`[Resend] Failed to send alert to ${to} for "${productTitle}":`, error);
  }
}