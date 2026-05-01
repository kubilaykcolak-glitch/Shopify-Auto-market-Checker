/**
 * eBay Price Service â€” Browse API
 *
 * Uses the eBay Browse API (/buy/browse/v1/item_summary/search) with sold
 * listing filtering to get real market prices. Replaces the legacy Finding API.
 *
 * Credentials required (both found on the same page):
 *   https://developer.ebay.com/ â†’ My Account â†’ Application Keys â†’ Production
 *   EBAY_CLIENT_ID     = "App ID (Client ID)"
 *   EBAY_CLIENT_SECRET = "Cert ID (Client Secret)"
 *
 * If you previously had EBAY_APP_ID, that value is your EBAY_CLIENT_ID.
 */

import { fetchWithRetry, FetchError } from "./fetch-utils.server";
export { EBAY_POKEMON_CATEGORIES, type EbayCategoryId } from "./ebay-categories";

const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
// Scope required for Browse API public (client credentials) access
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";

interface TokenCache {
  token: string;
  expiresAt: number; // Unix ms
}

let tokenCache: TokenCache | null = null;

// â”€â”€ OAuth App Token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function getEbayAppToken(): Promise<string> {
  // Return cached token with 60s buffer before expiry
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET. " +
        "Find them at https://developer.ebay.com â†’ Application Keys â†’ Production."
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetchWithRetry(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: EBAY_SCOPE,
    }),
  });

  const data = await response.json();

  if (!data.access_token) {
    const reason = data.error_description ?? data.error ?? JSON.stringify(data);
    throw new Error(`eBay OAuth failed: ${reason}`);
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };

  console.log("[eBay] OAuth app token obtained, expires in", data.expires_in, "seconds");
  return tokenCache.token;
}

// â”€â”€ Shared response type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface EbaySoldListing {
  title: string;
  price: number;
  currency: string;
  soldDate: string;  // ISO string
  condition: string;
  itemUrl: string;
}

// â”€â”€ Browse API call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function searchSoldListings(
  query: string,
  categoryId: string,
  limit: number
): Promise<any[]> {
  const token = await getEbayAppToken();

  const params = new URLSearchParams({
    q: query,
    category_ids: categoryId,
    // Filter: fixed price, sold only, GBP currency, items located in GB
    filter: "buyingOptions:{FIXED_PRICE},soldItemsOnly:true,currency:GBP,itemLocationCountry:GB",
    sort: "newlyListed",
    limit: String(limit),
    fieldgroups: "MATCHING_ITEMS",
  });

  const response = await fetchWithRetry(`${EBAY_BROWSE_URL}?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
    },
  });

  const data = await response.json();
  return data.itemSummaries ?? [];
}

function mapToSoldListing(item: any): EbaySoldListing {
  return {
    title: item.title ?? "Unknown",
    price: parseFloat(item.price?.value ?? "0"),
    currency: item.price?.currency ?? "GBP",
    // Browse API returns itemEndDate for sold items
    soldDate: item.itemEndDate ?? item.itemCreationDate ?? "",
    condition: item.condition ?? "Not specified",
    itemUrl: item.itemWebUrl ?? "",
  };
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Preview top N sold listings for the product linking confirmation step.
 * Returns enough detail for a merchant to verify the search is returning
 * sensible results before saving.
 */
export async function previewEbaySoldListings(
  query: string,
  categoryId: string,
  limit = 5
): Promise<EbaySoldListing[]> {
  try {
    const items = await searchSoldListings(query, categoryId, limit);
    return items.map(mapToSoldListing);
  } catch (error) {
    if (error instanceof FetchError) {
      throw new Error(`eBay search failed (HTTP ${error.status}): ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get the trimmed median market price for a tracked product.
 * Called on every scheduled sync.
 *
 * Returns null if:
 * - No results found
 * - eBay credentials not set
 * - API returns an error after retries
 */
export async function getEbayMarketPrice(
  query: string,
  categoryId: string,
  daysBack = 30
): Promise<number | null> {
  try {
    const items = await searchSoldListings(query, categoryId, 50);

    if (items.length === 0) {
      console.warn(`[eBay] No results for query: "${query}" in category ${categoryId}`);
      return null;
    }

    // Prefer items sold within the last N days; fall back to all items if < 3 recent
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
    const recent = items.filter((item: any) => {
      if (!item.itemEndDate) return false;
      return new Date(item.itemEndDate).getTime() >= cutoff;
    });

    const source = recent.length >= 3 ? recent : items;

    const prices = source
      .map((item: any) => parseFloat(item.price?.value ?? "0"))
      .filter((p: number) => !isNaN(p) && p > 0);

    if (prices.length === 0) return null;

    // Remove top and bottom 10% outliers, then return median
    prices.sort((a: number, b: number) => a - b);
    const trimCount = Math.floor(prices.length * 0.1);
    const endIndex = trimCount > 0 ? prices.length - trimCount : prices.length;
    const trimmed = prices.slice(trimCount, endIndex);

    const working = trimmed.length > 0 ? trimmed : prices;
    const mid = Math.floor(working.length / 2);
    const median =
      working.length % 2 === 0
        ? (working[mid - 1] + working[mid]) / 2
        : working[mid];

    console.log(
      `[eBay] "${query}" â€” ${source.length} listings, trimmed to ${working.length}, median: Â£${median.toFixed(2)}`
    );
    return median;
  } catch (error) {
    if (error instanceof FetchError && error.status === 401) {
      // Token may have expired mid-request â€” clear cache so next call re-authenticates
      tokenCache = null;
    }
    console.error(`[eBay] getEbayMarketPrice failed for "${query}":`, error);
    return null;
  }
}

/**
 * Legacy compatibility shim â€” kept so any existing callers don't break.
 * New code should use previewEbaySoldListings directly.
 */
export async function searchEbayProducts(
  query: string
): Promise<{ id: string; title: string }[]> {
  const listings = await previewEbaySoldListings(query, "183454", 5);
  return listings.map((l, i) => ({ id: String(i), title: l.title }));
}