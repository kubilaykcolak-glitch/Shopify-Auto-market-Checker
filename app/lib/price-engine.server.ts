/**
 * Price Engine
 *
 * The core sync loop. For each tracked product it:
 * 1. Fetches current market price from the configured price source
 * 2. Evaluates all enabled automation rules in priority order
 * 3. Executes the first matching action (update price, disable, floor, notify)
 * 4. Logs every check and action to PriceLog
 * 5. Sends Slack / email alerts when rules trigger
 *
 * Rule evaluation order (most protective first):
 *   price_floor → price_drop → price_rise → notify
 */

import prisma from "../db.server";
import { getTCGPlayerPrice } from "./tcgplayer.server";
import { getEbayMarketPrice } from "./ebay.server";
import { getPriceChartingPrice } from "./pricecharting.server";
import { sendPriceAlert } from "./resend.server";
import type { AutomationRule, TrackedProduct, StoreSettings } from "@prisma/client";

// ── Price fetching ───────────────────────────────────────────────────────────

export async function fetchMarketPrice(product: TrackedProduct): Promise<number | null> {
  try {
    switch (product.priceSource) {
      case "tcgplayer":
        return await getTCGPlayerPrice(product.externalId, product.cardCondition);

      case "ebay": {
        // Use saved search query + category if available (set at link time)
        // Fall back to externalName + default category for products linked before this feature
        const query = product.ebaySearchQuery ?? product.externalName;
        const categoryId = product.ebayCategoryId ?? (product.isSealed ? "183455" : "183454");
        return await getEbayMarketPrice(query, categoryId, 30);
      }

      case "pricecharting":
        return await getPriceChartingPrice(product.externalId, product.cardCondition);

      default:
        throw new Error(`Unknown price source: ${product.priceSource}`);
    }
  } catch (error) {
    console.error(`[PriceEngine] Failed to fetch price for product ${product.id} (${product.shopifyProductTitle}):`, error);
    return null;
  }
}

// ── Shopify REST API calls ───────────────────────────────────────────────────

async function updateShopifyPrice(
  shop: string,
  accessToken: string,
  variantId: string,
  newPrice: number
): Promise<boolean> {
  // variantId may be a GID (gid://shopify/ProductVariant/123) or numeric string
  const numericId = variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, "");

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2024-01/variants/${numericId}.json`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          variant: { id: numericId, price: newPrice.toFixed(2) },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(`[PriceEngine] updateShopifyPrice failed (${response.status}): ${body}`);
    }
    return response.ok;
  } catch (error) {
    console.error("[PriceEngine] updateShopifyPrice network error:", error);
    return false;
  }
}

async function setShopifyInventory(
  shop: string,
  accessToken: string,
  variantId: string,
  quantity: number
): Promise<boolean> {
  const numericId = variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, "");

  try {
    // Step 1: get inventory_item_id for this variant
    const variantResp = await fetch(
      `https://${shop}/admin/api/2024-01/variants/${numericId}.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!variantResp.ok) return false;
    const variantData = await variantResp.json();
    const inventoryItemId = variantData.variant?.inventory_item_id;
    if (!inventoryItemId) return false;

    // Step 2: get the primary location
    const locResp = await fetch(
      `https://${shop}/admin/api/2024-01/locations.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!locResp.ok) return false;
    const locData = await locResp.json();
    const locationId = locData.locations?.[0]?.id;
    if (!locationId) return false;

    // Step 3: set inventory level
    const invResp = await fetch(
      `https://${shop}/admin/api/2024-01/inventory_levels/set.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          location_id: locationId,
          inventory_item_id: inventoryItemId,
          available: quantity,
        }),
      }
    );

    if (!invResp.ok) {
      const body = await invResp.text();
      console.error(`[PriceEngine] setShopifyInventory failed (${invResp.status}): ${body}`);
    }
    return invResp.ok;
  } catch (error) {
    console.error("[PriceEngine] setShopifyInventory network error:", error);
    return false;
  }
}

// ── Alert helper ─────────────────────────────────────────────────────────────

type AlertSettings = Pick<StoreSettings, "emailAlerts" | "alertEmail" | "slackWebhookUrl" | "discordWebhookUrl">;

async function sendAlerts(
  settings: AlertSettings,
  productTitle: string,
  actionTaken: string,
  actionDetail: string,
  newPrice: number,
  previousPrice: number,
  changePercent: number
): Promise<void> {
  // Slack webhook
  if (settings.slackWebhookUrl) {
    const sign = changePercent >= 0 ? "+" : "";
    try {
      await fetch(settings.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: [
            `🃏 *PriceSync Alert*`,
            `*Product:* ${productTitle}`,
            `*Action:* ${actionTaken.replace(/_/g, " ")}`,
            `*Detail:* ${actionDetail}`,
            `Prev: £${previousPrice.toFixed(2)} → New: £${newPrice.toFixed(2)} (${sign}${changePercent.toFixed(1)}%)`,
          ].join("\n"),
        }),
      });
    } catch (e) {
      console.error("[PriceEngine] Slack alert failed:", e);
    }
  }

  // Discord webhook
  if (settings.discordWebhookUrl) {
    const sign = changePercent >= 0 ? "+" : "";
    try {
      await fetch(settings.discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            `🃏 **PriceSync Alert**`,
            `**Product:** ${productTitle}`,
            `**Action:** ${actionTaken.replace(/_/g, " ")}`,
            `**Detail:** ${actionDetail}`,
            `Prev: £${previousPrice.toFixed(2)} → New: £${newPrice.toFixed(2)} (${sign}${changePercent.toFixed(1)}%)`,
          ].join("\n"),
        }),
      });
    } catch (e) {
      console.error("[PriceEngine] Discord alert failed:", e);
    }
  }

  // Email via Resend
  if (settings.emailAlerts && settings.alertEmail) {
    await sendPriceAlert({
      to: settings.alertEmail,
      productTitle,
      actionTaken,
      actionDetail,
      previousPrice,
      newPrice,
      changePercent,
    });
  }
}

// ── Rule evaluation ──────────────────────────────────────────────────────────

interface RuleResult {
  actionTaken: string;
  actionDetail: string;
}

async function evaluateRules(
  product: TrackedProduct,
  newPrice: number,
  previousPrice: number,
  rules: AutomationRule[],
  shop: string,
  accessToken: string,
  settings: AlertSettings
): Promise<RuleResult> {
  if (previousPrice <= 0) {
    return { actionTaken: "nothing", actionDetail: "No baseline price — skipping rule evaluation" };
  }

  const changePercent = ((newPrice - previousPrice) / previousPrice) * 100;
  const enabledRules = rules.filter((r) => r.isEnabled);

  // Rule priority order: floor → drop → rise → notify
  const ruleOrder = ["price_floor", "price_drop", "price_rise", "notify"];
  const sorted = [...enabledRules].sort(
    (a, b) => ruleOrder.indexOf(a.ruleType) - ruleOrder.indexOf(b.ruleType)
  );

  let actionTaken = "nothing";
  let actionDetail = `Price changed ${changePercent.toFixed(2)}% — no rules triggered`;

  for (const rule of sorted) {
    // ── Floor check ──────────────────────────────────────────────────────────
    if (rule.ruleType === "price_floor") {
      if (!product.costPrice) {
        console.warn(
          `[PriceEngine] Floor rule "${rule.name}" skipped for product ${product.id}: costPrice not set`
        );
        continue;
      }
      // Floor = cost price + configured margin %
      const marginPct = rule.actionValue ?? 10;
      const floorPrice = product.costPrice * (1 + marginPct / 100);

      if (newPrice < floorPrice) {
        if (rule.action === "disable_product") {
          // Set out of stock instead of forcing the floor price
          const disabled = await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 0);
          if (disabled) {
            await prisma.trackedProduct.update({
              where: { id: product.id },
              data: { disabledByRule: true },
            });
            const detail = `Set out of stock: market £${newPrice.toFixed(2)} below floor £${floorPrice.toFixed(2)} (cost £${product.costPrice.toFixed(2)} + ${marginPct}% margin)`;
            await sendAlerts(settings, product.shopifyProductTitle, "product_disabled", detail, newPrice, previousPrice, changePercent);
            return { actionTaken: "product_disabled", actionDetail: detail };
          }
        } else {
          // Default: apply floor price
          const applied = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, floorPrice);
          if (applied) {
            const detail = `Floor £${floorPrice.toFixed(2)} applied (cost £${product.costPrice.toFixed(2)} + ${marginPct}% margin; market was £${newPrice.toFixed(2)})`;
            await sendAlerts(settings, product.shopifyProductTitle, "floor_applied", detail, floorPrice, previousPrice, changePercent);
            return { actionTaken: "floor_applied", actionDetail: detail };
          }
        }
      }
      continue; // Floor rule checked — move to next regardless
    }

    // ── Price drop ───────────────────────────────────────────────────────────
    if (rule.ruleType === "price_drop" && changePercent <= -(rule.thresholdPct ?? 0)) {
      if (rule.action === "disable_product") {
        const disabled = await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 0);
        if (disabled) {
          await prisma.trackedProduct.update({
            where: { id: product.id },
            data: { disabledByRule: true },
          });
          const detail = `Disabled: price dropped ${Math.abs(changePercent).toFixed(1)}% (threshold: ${rule.thresholdPct}%)`;
          await sendAlerts(settings, product.shopifyProductTitle, "product_disabled", detail, newPrice, previousPrice, changePercent);
          return { actionTaken: "product_disabled", actionDetail: detail };
        }
      } else if (rule.action === "update_price") {
        const updated = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, newPrice);
        if (updated) {
          actionTaken = "price_updated";
          actionDetail = `Price lowered to £${newPrice.toFixed(2)} (market dropped ${Math.abs(changePercent).toFixed(1)}%)`;
        }
      }
      continue;
    }

    // ── Price rise ───────────────────────────────────────────────────────────
    if (rule.ruleType === "price_rise" && changePercent >= (rule.thresholdPct ?? 0)) {
      if (rule.action === "update_price") {
        const updated = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, newPrice);
        if (updated) {
          // If a drop rule had previously disabled this product, re-enable it
          if (product.disabledByRule) {
            await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 1);
            await prisma.trackedProduct.update({
              where: { id: product.id },
              data: { disabledByRule: false },
            });
          }
          actionTaken = "price_updated";
          actionDetail = `Price raised to £${newPrice.toFixed(2)} (market rose ${changePercent.toFixed(1)}%)`;
        }
      }
      continue;
    }

    // ── Notify only ──────────────────────────────────────────────────────────
    if (rule.ruleType === "notify" && Math.abs(changePercent) >= (rule.thresholdPct ?? 0)) {
      const detail = `Price moved ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}% (threshold: ±${rule.thresholdPct}%)`;
      await sendAlerts(settings, product.shopifyProductTitle, "notified", detail, newPrice, previousPrice, changePercent);
      if (actionTaken === "nothing") {
        actionTaken = "notified";
        actionDetail = detail;
      }
    }
  }

  return { actionTaken, actionDetail };
}

// ── Main sync function ───────────────────────────────────────────────────────

export async function checkAndSyncProduct(
  product: TrackedProduct,
  rules: AutomationRule[],
  shop: string,
  accessToken: string,
  settings: AlertSettings
): Promise<void> {
  const newPrice = await fetchMarketPrice(product);

  if (newPrice === null) {
    console.warn(`[PriceEngine] Could not fetch price for "${product.shopifyProductTitle}" — skipping`);
    return;
  }

  const previousPrice = product.lastKnownPrice ?? product.baselinePrice ?? 0;
  const changePercent =
    previousPrice > 0 ? ((newPrice - previousPrice) / previousPrice) * 100 : 0;

  const { actionTaken, actionDetail } = await evaluateRules(
    product,
    newPrice,
    previousPrice,
    rules,
    shop,
    accessToken,
    settings
  );

  // Persist updated price and timestamp
  await prisma.trackedProduct.update({
    where: { id: product.id },
    data: {
      lastKnownPrice: newPrice,
      lastCheckedAt: new Date(),
    },
  });

  // Log every check
  await prisma.priceLog.create({
    data: {
      storeId: product.storeId,
      trackedProductId: product.id,
      priceSource: product.priceSource,
      fetchedPrice: newPrice,
      previousPrice: previousPrice > 0 ? previousPrice : null,
      changePercent: previousPrice > 0 ? changePercent : null,
      actionTaken,
      actionDetail,
    },
  });

  const sign = changePercent >= 0 ? "+" : "";
  console.log(
    `[PriceEngine] ${product.shopifyProductTitle}: £${previousPrice.toFixed(2)} → £${newPrice.toFixed(2)} (${sign}${changePercent.toFixed(1)}%) → ${actionTaken}`
  );
}

// ── Store-level sync ─────────────────────────────────────────────────────────

export async function runSyncForStore(storeId: string): Promise<void> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    include: {
      products: { where: { isActive: true, isPaused: false } },
      rules: { orderBy: { createdAt: "asc" } },
      settings: true,
    },
  });

  if (!store) {
    console.error(`[PriceEngine] Store ${storeId} not found`);
    return;
  }

  const settings: AlertSettings = store.settings ?? {
    emailAlerts: false,
    alertEmail: null,
    slackWebhookUrl: null,
    discordWebhookUrl: null,
  };

  console.log(
    `[PriceEngine] Starting sync for ${store.shop} — ${store.products.length} active products`
  );

  // Process sequentially — be polite to rate limits
  for (const product of store.products) {
    await checkAndSyncProduct(product, store.rules, store.shop, store.accessToken, settings);
    await new Promise((r) => setTimeout(r, 500)); // 500ms between API calls
  }

  console.log(`[PriceEngine] Sync complete for ${store.shop}`);
}

export async function runSyncForAllStores(): Promise<void> {
  const stores = await prisma.store.findMany({
    select: { id: true, shop: true },
  });

  console.log(`[PriceEngine] Global sync starting — ${stores.length} store(s)`);

  for (const store of stores) {
    try {
      await runSyncForStore(store.id);
    } catch (error) {
      console.error(`[PriceEngine] Sync failed for ${store.shop}:`, error);
    }
  }
}