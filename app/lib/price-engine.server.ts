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

type InventoryResult = { ok: true } | { ok: false; error: string };

async function setShopifyInventory(
  shop: string,
  accessToken: string,
  variantId: string,
  quantity: number
): Promise<InventoryResult> {
  const numericId = variantId.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
  const headers = { "X-Shopify-Access-Token": accessToken };

  // Helper: extract a readable error from a Shopify error response body
  function parseShopifyError(body: string, status: number): string {
    try {
      const parsed = JSON.parse(body);
      const msgs: string[] =
        parsed?.errors
          ? (typeof parsed.errors === "string"
              ? [parsed.errors]
              : Object.values(parsed.errors as Record<string, string | string[]>).flat())
          : [];
      if (msgs.length > 0) return msgs.join("; ");
    } catch {
      // not JSON — use raw text
    }
    return body.trim() || `HTTP ${status}`;
  }

  try {
    // Step 1: get variant → inventory_item_id + tracking status
    const variantResp = await fetch(
      `https://${shop}/admin/api/2024-01/variants/${numericId}.json`,
      { headers }
    );
    if (!variantResp.ok) {
      const body = await variantResp.text();
      const err = `Could not fetch variant from Shopify (${variantResp.status}): ${parseShopifyError(body, variantResp.status)}`;
      console.error(`[PriceEngine] setShopifyInventory: ${err}`);
      return { ok: false, error: err };
    }
    const { variant } = await variantResp.json();
    const inventoryItemId: number | undefined = variant?.inventory_item_id;
    if (!inventoryItemId) {
      const err = `Variant ${numericId} has no inventory_item_id — this product type may not support inventory management (e.g. gift cards).`;
      console.error(`[PriceEngine] setShopifyInventory: ${err}`);
      return { ok: false, error: err };
    }

    // Step 2: enable Shopify inventory tracking if not already on
    if (variant.inventory_management !== "shopify") {
      console.log(`[PriceEngine] Variant ${numericId} inventory_management="${variant.inventory_management}" — attempting to enable Shopify tracking`);
      const enableResp = await fetch(
        `https://${shop}/admin/api/2024-01/variants/${numericId}.json`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ variant: { id: numericId, inventory_management: "shopify" } }),
        }
      );
      if (!enableResp.ok) {
        const body = await enableResp.text();
        const err = `Cannot enable inventory tracking on this variant (${enableResp.status}): ${parseShopifyError(body, enableResp.status)}. This product type may not support inventory management.`;
        console.error(`[PriceEngine] setShopifyInventory: ${err}`);
        return { ok: false, error: err };
      }
      console.log(`[PriceEngine] Inventory tracking enabled for variant ${numericId}`);
    }

    // Step 3: find the location where this inventory item is already stocked
    const levelsResp = await fetch(
      `https://${shop}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
      { headers }
    );
    let locationId: number | undefined;
    if (levelsResp.ok) {
      const levelsData = await levelsResp.json();
      const levels: Array<{ location_id: number; available: number }> = levelsData.inventory_levels ?? [];
      if (levels.length > 0) {
        levels.sort((a, b) => (b.available ?? 0) - (a.available ?? 0));
        locationId = levels[0].location_id;
        console.log(`[PriceEngine] Using location ${locationId} (${levels.length} level(s) for item ${inventoryItemId})`);
      }
    }

    // Step 4: no existing level — fall back to first location and connect
    if (!locationId) {
      const locResp = await fetch(`https://${shop}/admin/api/2024-01/locations.json`, { headers });
      if (!locResp.ok) {
        const body = await locResp.text();
        const err = `Could not fetch store locations (${locResp.status}): ${parseShopifyError(body, locResp.status)}`;
        console.error(`[PriceEngine] setShopifyInventory: ${err}`);
        return { ok: false, error: err };
      }
      const { locations } = await locResp.json();
      locationId = locations?.[0]?.id;
      if (!locationId) {
        const err = "No locations found for this store — inventory cannot be managed.";
        console.error(`[PriceEngine] setShopifyInventory: ${err}`);
        return { ok: false, error: err };
      }

      const connectResp = await fetch(
        `https://${shop}/admin/api/2024-01/inventory_levels/connect.json`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId }),
        }
      );
      if (!connectResp.ok) {
        const body = await connectResp.text();
        if (!body.toLowerCase().includes("already")) {
          const err = `Could not connect inventory item to location (${connectResp.status}): ${parseShopifyError(body, connectResp.status)}`;
          console.error(`[PriceEngine] setShopifyInventory: ${err}`);
          return { ok: false, error: err };
        }
      } else {
        console.log(`[PriceEngine] Connected item ${inventoryItemId} to location ${locationId}`);
      }
    }

    // Step 5: set the inventory level
    const setResp = await fetch(
      `https://${shop}/admin/api/2024-01/inventory_levels/set.json`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity }),
      }
    );

    if (!setResp.ok) {
      const body = await setResp.text();
      const err = `Shopify rejected the inventory update (${setResp.status}): ${parseShopifyError(body, setResp.status)}`;
      console.error(`[PriceEngine] setShopifyInventory: ${err}`);
      return { ok: false, error: err };
    }

    console.log(`[PriceEngine] ✓ Inventory set to ${quantity} for variant ${numericId} at location ${locationId}`);
    return { ok: true };
  } catch (error) {
    const err = `Network error while updating Shopify inventory: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[PriceEngine] setShopifyInventory: ${err}`);
    return { ok: false, error: err };
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
  /** The price actually written to Shopify (if different from market price) */
  appliedShopifyPrice?: number;
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

  console.log(
    `[PriceEngine] evaluateRules: "${product.shopifyProductTitle}" | change ${changePercent.toFixed(2)}% | ${enabledRules.length} enabled rule(s): [${enabledRules.map((r) => `${r.ruleType}/${r.action}`).join(", ")}]`
  );

  if (enabledRules.length === 0) {
    return { actionTaken: "nothing", actionDetail: `Market price is £${newPrice.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}% vs your store price of £${previousPrice.toFixed(2)}). No automation rules are configured, so no action was taken.` };
  }

  // Rule priority order: floor → drop → rise → notify
  const ruleOrder = ["price_floor", "price_drop", "price_rise", "notify"];
  const sorted = [...enabledRules].sort(
    (a, b) => ruleOrder.indexOf(a.ruleType) - ruleOrder.indexOf(b.ruleType)
  );

  let actionTaken = "nothing";
  let actionDetail = `Market price is £${newPrice.toFixed(2)} (${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}% vs store price £${previousPrice.toFixed(2)}). Rules were checked but none matched the current conditions.`;
  let appliedShopifyPrice: number | undefined;

  for (const rule of sorted) {
    // ── Floor check ──────────────────────────────────────────────────────────
    if (rule.ruleType === "price_floor") {
      if (!product.costPrice) {
        console.warn(
          `[PriceEngine] Floor rule "${rule.name}" skipped for product ${product.id}: costPrice not set`
        );
        continue;
      }
      const marginPct = rule.actionValue ?? 10;
      const floorPrice = product.costPrice * (1 + marginPct / 100);

      if (newPrice < floorPrice) {
        if (rule.action === "disable_product") {
          const invResult = await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 0);
          if (invResult.ok) {
            await prisma.trackedProduct.update({
              where: { id: product.id },
              data: { disabledByRule: true },
            });
            const detail = `Product set to out of stock by rule "${rule.name}". Market price £${newPrice.toFixed(2)} fell below the floor of £${floorPrice.toFixed(2)}, calculated from your cost price (£${product.costPrice.toFixed(2)}) plus ${marginPct}% minimum margin. Shopify inventory set to 0.`;
            await sendAlerts(settings, product.shopifyProductTitle, "product_disabled", detail, newPrice, previousPrice, changePercent);
            return { actionTaken: "product_disabled", actionDetail: detail };
          } else {
            console.error(`[PriceEngine] Floor rule "${rule.name}" matched but setShopifyInventory failed: ${invResult.error}`);
            actionDetail = `Rule "${rule.name}" triggered (floor breach): ${invResult.error}`;
          }
        } else {
          const applied = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, floorPrice);
          if (applied) {
            const detail = `Floor price protection triggered by rule "${rule.name}". Market price £${newPrice.toFixed(2)} fell below the minimum of £${floorPrice.toFixed(2)} (cost £${product.costPrice.toFixed(2)} + ${marginPct}% margin). Shopify price set to £${floorPrice.toFixed(2)} to protect your margin.`;
            await sendAlerts(settings, product.shopifyProductTitle, "floor_applied", detail, floorPrice, previousPrice, changePercent);
            // Don't return — allow subsequent rules (e.g. price_drop/disable) to also evaluate
            actionTaken = "floor_applied";
            actionDetail = detail;
            appliedShopifyPrice = floorPrice;
          } else {
            console.error(`[PriceEngine] Floor rule "${rule.name}" matched but updateShopifyPrice failed`);
            actionDetail = `Rule "${rule.name}" triggered: market £${newPrice.toFixed(2)} is below floor £${floorPrice.toFixed(2)}, but the Shopify price update failed. Check your Shopify access token has write_products permission.`;
          }
        }
      }
      continue;
    }

    // ── Price drop ───────────────────────────────────────────────────────────
    if (rule.ruleType === "price_drop" && changePercent <= -(rule.thresholdPct ?? 0)) {
      console.log(`[PriceEngine] Price drop rule "${rule.name}" matched (${changePercent.toFixed(2)}% <= -${rule.thresholdPct}%) — action: ${rule.action}`);
      if (rule.action === "disable_product") {
        const invResult = await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 0);
        if (invResult.ok) {
          await prisma.trackedProduct.update({
            where: { id: product.id },
            data: { disabledByRule: true },
          });
          const detail = `Product set to out of stock by rule "${rule.name}". Market price dropped ${Math.abs(changePercent).toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), which exceeded your ${rule.thresholdPct}% threshold. Shopify inventory set to 0.`;
          await sendAlerts(settings, product.shopifyProductTitle, "product_disabled", detail, newPrice, previousPrice, changePercent);
          return { actionTaken: "product_disabled", actionDetail: detail };
        } else {
          console.error(`[PriceEngine] Price drop rule "${rule.name}" matched but setShopifyInventory failed: ${invResult.error}`);
          actionTaken = "rule_failed";
          actionDetail = `Rule "${rule.name}" triggered: price dropped ${Math.abs(changePercent).toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), exceeding your ${rule.thresholdPct}% threshold — but the inventory update failed. Reason: ${invResult.error}`;
        }
      } else if (rule.action === "update_price") {
        const updated = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, newPrice);
        if (updated) {
          actionTaken = "price_updated";
          actionDetail = `Shopify price lowered to £${newPrice.toFixed(2)} to match the market. Price dropped ${Math.abs(changePercent).toFixed(1)}% from £${previousPrice.toFixed(2)}, triggered by rule "${rule.name}" (threshold: ${rule.thresholdPct}%).`;
        } else {
          console.error(`[PriceEngine] Price drop rule "${rule.name}" matched but updateShopifyPrice failed`);
          actionTaken = "rule_failed";
          actionDetail = `Rule "${rule.name}" triggered: price dropped ${Math.abs(changePercent).toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), but the Shopify price update failed. Check your Shopify access token has write_products permission.`;
        }
      } else if (rule.action === "notify_only") {
        // Alert only — no price change, no inventory change
        const detail = `Alert sent: market price dropped ${Math.abs(changePercent).toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), exceeding your ${rule.thresholdPct}% drop threshold for rule "${rule.name}". No price changes were made.`;
        await sendAlerts(settings, product.shopifyProductTitle, "notified", detail, newPrice, previousPrice, changePercent);
        if (actionTaken === "nothing") {
          actionTaken = "notified";
          actionDetail = detail;
        }
      }
      continue;
    }

    // ── Price rise ───────────────────────────────────────────────────────────
    if (rule.ruleType === "price_rise" && changePercent >= (rule.thresholdPct ?? 0)) {
      console.log(`[PriceEngine] Price rise rule "${rule.name}" matched (${changePercent.toFixed(2)}% >= ${rule.thresholdPct}%) — action: ${rule.action}`);
      if (rule.action === "update_price") {
        const updated = await updateShopifyPrice(shop, accessToken, product.shopifyVariantId, newPrice);
        if (updated) {
          if (product.disabledByRule) {
            const invResult = await setShopifyInventory(shop, accessToken, product.shopifyVariantId, 1);
            if (invResult.ok) {
              await prisma.trackedProduct.update({
                where: { id: product.id },
                data: { disabledByRule: false },
              });
              actionTaken = "price_updated";
              actionDetail = `Shopify price raised to £${newPrice.toFixed(2)} to match the market. Price rose ${changePercent.toFixed(1)}% from £${previousPrice.toFixed(2)}, triggered by rule "${rule.name}" (threshold: ${rule.thresholdPct}%). Product was previously out of stock — inventory has been restored to 1.`;
            } else {
              console.error(`[PriceEngine] Price rise rule "${rule.name}": price updated but inventory restore failed: ${invResult.error}`);
              actionTaken = "rule_failed";
              actionDetail = `Rule "${rule.name}" raised the Shopify price to £${newPrice.toFixed(2)}, but the inventory restore failed so the product remains out of stock. Reason: ${invResult.error}`;
            }
          } else {
            actionTaken = "price_updated";
            actionDetail = `Shopify price raised to £${newPrice.toFixed(2)} to match the market. Price rose ${changePercent.toFixed(1)}% from £${previousPrice.toFixed(2)}, triggered by rule "${rule.name}" (threshold: ${rule.thresholdPct}%).`;
          }
        } else {
          console.error(`[PriceEngine] Price rise rule "${rule.name}" matched but updateShopifyPrice failed`);
          actionTaken = "rule_failed";
          actionDetail = `Rule "${rule.name}" triggered: price rose ${changePercent.toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), but the Shopify price update failed. Check your Shopify access token has write_products permission.`;
        }
      } else if (rule.action === "notify_only") {
        // Alert only — no price change
        const detail = `Alert sent: market price rose ${changePercent.toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), exceeding your ${rule.thresholdPct}% rise threshold for rule "${rule.name}". No price changes were made.`;
        await sendAlerts(settings, product.shopifyProductTitle, "notified", detail, newPrice, previousPrice, changePercent);
        if (actionTaken === "nothing") {
          actionTaken = "notified";
          actionDetail = detail;
        }
      }
      continue;
    }

    // ── Notify only ──────────────────────────────────────────────────────────
    if (rule.ruleType === "notify" && Math.abs(changePercent) >= (rule.thresholdPct ?? 0)) {
      const detail = `Alert sent: market price moved ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}% (from £${previousPrice.toFixed(2)} to £${newPrice.toFixed(2)}), exceeding your ±${rule.thresholdPct}% alert threshold for rule "${rule.name}". No price changes were made.`;
      await sendAlerts(settings, product.shopifyProductTitle, "notified", detail, newPrice, previousPrice, changePercent);
      if (actionTaken === "nothing") {
        actionTaken = "notified";
        actionDetail = detail;
      }
    }
  }

  return { actionTaken, actionDetail, appliedShopifyPrice };
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

  // For the activity log: how has the raw market price moved since last fetch?
  const lastMarketPrice = product.lastKnownPrice ?? product.baselinePrice ?? 0;
  const marketChangePercent =
    lastMarketPrice > 0 ? ((newPrice - lastMarketPrice) / lastMarketPrice) * 100 : 0;

  // For rule evaluation: compare market price against what the store is actually selling for.
  // This ensures rules always fire when there's a gap between market and store price —
  // even if lastKnownPrice has already caught up (e.g. rule added after first sync).
  const ruleBasePrice =
    product.shopifyCurrentPrice > 0 ? product.shopifyCurrentPrice : lastMarketPrice;

  const { actionTaken, actionDetail, appliedShopifyPrice } = await evaluateRules(
    product,
    newPrice,
    ruleBasePrice,
    rules,
    shop,
    accessToken,
    settings
  );

  // Persist updated market price and timestamp.
  // Mirror the Shopify price in shopifyCurrentPrice whenever we write a new price
  // to Shopify, so the next sync compares against the actual current store price
  // rather than a stale value that would re-trigger the same rule.
  const newShopifyPrice =
    actionTaken === "price_updated"
      ? newPrice
      : actionTaken === "floor_applied" && appliedShopifyPrice != null
      ? appliedShopifyPrice
      : undefined;

  await prisma.trackedProduct.update({
    where: { id: product.id },
    data: {
      lastKnownPrice: newPrice,
      lastCheckedAt: new Date(),
      ...(newShopifyPrice != null ? { shopifyCurrentPrice: newShopifyPrice } : {}),
    },
  });

  // Log every check — use market movement for the displayed change %
  await prisma.priceLog.create({
    data: {
      storeId: product.storeId,
      trackedProductId: product.id,
      priceSource: product.priceSource,
      fetchedPrice: newPrice,
      previousPrice: ruleBasePrice > 0 ? ruleBasePrice : null,
      changePercent: ruleBasePrice > 0
        ? ((newPrice - ruleBasePrice) / ruleBasePrice) * 100
        : null,
      actionTaken,
      actionDetail,
    },
  });

  const ruleChangePct = ruleBasePrice > 0
    ? ((newPrice - ruleBasePrice) / ruleBasePrice) * 100
    : 0;
  const sign = ruleChangePct >= 0 ? "+" : "";
  console.log(
    `[PriceEngine] ${product.shopifyProductTitle}: store £${ruleBasePrice.toFixed(2)} / market £${newPrice.toFixed(2)} (${sign}${ruleChangePct.toFixed(1)}%) → ${actionTaken}`
  );
}

// ── Store-level sync ─────────────────────────────────────────────────────────

/** Tracks which stores currently have a sync in progress (server-process scoped). */
const activeSyncs = new Set<string>();

export async function runSyncForStore(storeId: string): Promise<void> {
  if (activeSyncs.has(storeId)) {
    console.warn(`[PriceEngine] Sync for store ${storeId} is already in progress — skipping duplicate run`);
    return;
  }
  activeSyncs.add(storeId);

  try {
    return await _runSyncForStore(storeId);
  } finally {
    activeSyncs.delete(storeId);
  }
}

async function _runSyncForStore(storeId: string): Promise<void> {
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

  // Prefer the offline session token (always kept current by the Shopify SDK)
  // over store.accessToken, which is only refreshed when the merchant visits
  // the dashboard. Using a stale store.accessToken is the most common cause of
  // rule_failed entries immediately after linking a product from another page.
  const offlineSession = await prisma.session.findFirst({
    where: { shop: store.shop, isOnline: false },
    orderBy: { id: "desc" },
  });
  const accessToken = offlineSession?.accessToken ?? store.accessToken;

  if (!accessToken) {
    console.error(`[PriceEngine] No access token available for ${store.shop} — sync aborted`);
    return;
  }

  // Keep Store.accessToken in sync so it's fresh for the next run too
  if (offlineSession?.accessToken && offlineSession.accessToken !== store.accessToken) {
    await prisma.store.update({
      where: { id: storeId },
      data: { accessToken: offlineSession.accessToken },
    });
    console.log(`[PriceEngine] Updated stored access token for ${store.shop} from offline session`);
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
    await checkAndSyncProduct(product, store.rules, store.shop, accessToken, settings);
    await new Promise((r) => setTimeout(r, 500)); // 500ms between API calls
  }

  // Stamp the completed sync time so the cron can respect pollIntervalMinutes
  await prisma.store.update({
    where: { id: storeId },
    data: { lastSyncAt: new Date() },
  });

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