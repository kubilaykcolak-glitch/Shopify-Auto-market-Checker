/**
 * eBay Price Service — Browse API
 *
 * Fetches sold listing prices via the eBay Browse API with a sold-first
 * search strategy:
 *
 *   Phase 1 — Sold listings (filter=soldItemsOnly:true)
 *     Prices reflect actual transaction values — what buyers paid.
 *     Works on EBAY_GB and EBAY_US for queries that have real sold results.
 *     When eBay has no sold data for a query it returns errorId 12002 in the
 *     warnings array (not an HTTP error); the code treats this as zero results
 *     and moves to the next step.
 *
 *   Phase 2 — Active listings fallback
 *     Used only when every sold attempt returns zero results.
 *     UI surfaces a warning banner when this path is taken.
 *
 * NOTE — Finding API (findCompletedItems) and Marketplace Insights API:
 *   Both are blocked for this developer account (HTTP 500 / 403 respectively).
 *   Do not re-add them; they only add retry delays without returning data.
 *
 * Filter encoding note:
 *   The soldItemsOnly filter MUST be appended to the URL as a raw string, NOT
 *   via URLSearchParams. URLSearchParams encodes ':' → '%3A' and eBay's filter
 *   parser silently ignores the param when it receives the encoded form,
 *   returning active listings as if no filter was set.
 *
 * Credentials required:
 *   https://developer.ebay.com → Application Keys → Production
 *   EBAY_CLIENT_ID     = "App ID (Client ID)"
 *   EBAY_CLIENT_SECRET = "Cert ID (Client Secret)"
 */

import { fetchWithRetry, FetchError } from "./fetch-utils.server";
export { EBAY_POKEMON_CATEGORIES, type EbayCategoryId } from "./ebay-categories";

const EBAY_TOKEN_URL  = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const EBAY_SCOPE      = "https://api.ebay.com/oauth/api_scope";

// ── OAuth App Token ───────────────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function getEbayAppToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const clientId     = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "eBay credentials not configured. Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET. " +
        "Find them at https://developer.ebay.com → Application Keys → Production."
    );
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetchWithRetry(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: EBAY_SCOPE }),
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
  console.log("[eBay] OAuth token obtained, expires in", data.expires_in, "seconds");
  return tokenCache.token;
}

// ── Shared response types ─────────────────────────────────────────────────────

export interface EbaySoldListing {
  title: string;
  price: number;
  currency: string;
  /** Sale date (soldItemsOnly results) or listing creation date (active fallback) */
  soldDate: string;
  condition: string;
  itemUrl: string;
}

export interface EbayPreviewResult {
  listings: EbaySoldListing[];
  effectiveQuery: string;
  /**
   * True = prices are from real sold/completed transactions.
   * False = no sold data found; prices are from active listings (approximation).
   */
  usedSoldData: boolean;
}

// ── Browse API call ───────────────────────────────────────────────────────────

/** Convert a price to GBP. */
function toGBP(value: number, currency: string): number {
  if (currency === "GBP") return value;
  if (currency === "USD") {
    const rate = parseFloat(process.env.USD_TO_GBP_RATE ?? "0.79");
    return value * rate;
  }
  return value;
}

/** Normalise USD items to GBP in-place (for EBAY_US results). */
function normaliseToGBP(items: any[]): any[] {
  return items.map((item: any) => {
    const currency: string = item.price?.currency ?? "USD";
    const raw: number = parseFloat(item.price?.value ?? "0");
    if (currency !== "GBP") {
      return {
        ...item,
        price: { value: String(toGBP(raw, currency).toFixed(2)), currency: "GBP" },
      };
    }
    return item;
  });
}

/**
 * Single Browse API call.
 *
 * soldOnly=true appends &filter=soldItemsOnly:true to the URL as a raw string.
 * This MUST NOT go through URLSearchParams — see file header for why.
 *
 * No sort param — eBay's default "Best Match" ranks by relevance. "sort:price"
 * returns cheapest items first (stickers, proxies) which pollutes price averages.
 */
async function browseSearch(
  token: string,
  query: string,
  limit: number,
  categoryId?: string,
  marketplace: "EBAY_GB" | "EBAY_US" = "EBAY_GB",
  soldOnly = false
): Promise<any[]> {
  // Replace slashes with spaces: "199/197" → "199 197"
  // URLSearchParams encodes "/" as "%2F" which eBay treats as a literal string.
  const normQ = query.replace(/\//g, " ").replace(/\s{2,}/g, " ").trim();

  const params = new URLSearchParams({
    q: normQ,
    limit: String(Math.min(limit, 200)),
  });
  if (categoryId) params.set("category_ids", categoryId);

  // Append filter with literal colon — URLSearchParams would encode ':' → '%3A'
  // which eBay silently ignores, returning active listings instead.
  let url = `${EBAY_BROWSE_URL}?${params.toString()}`;
  if (soldOnly) url += "&filter=soldItemsOnly:true";

  const response = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });

  const data = await response.json();

  // Hard errors inside a 200 response
  if (data.errors?.length) {
    const msg: string = data.errors[0]?.message ?? JSON.stringify(data.errors[0]);
    console.error(`[eBay] browseSearch (${marketplace}, sold=${soldOnly}): API error: ${msg}`);
    throw new FetchError(200, `eBay error: ${msg}`);
  }

  const items: any[] = data.itemSummaries ?? [];

  if (items.length === 0) {
    // Warnings (e.g. errorId 12002 "soldItemsOnly filter value is invalid") appear
    // when the filter yields no results for this query/marketplace combination.
    // Treat as zero results — the fallback chain will try the next step.
    const warnSummary = data.warnings?.length
      ? ` warning=${data.warnings[0]?.errorId ?? "?"}:"${data.warnings[0]?.message?.slice(0, 80) ?? ""}"`
      : "";
    console.log(
      `[eBay] (${marketplace}, sold=${soldOnly}, cat=${categoryId ?? "none"}): 0 results for "${normQ}"${warnSummary}`
    );
  } else {
    console.log(
      `[eBay] (${marketplace}, sold=${soldOnly}, cat=${categoryId ?? "none"}): ${items.length} results for "${normQ}"`
    );
  }

  return items;
}

// ── Query simplification ──────────────────────────────────────────────────────

/**
 * Generate progressively simpler fallback queries.
 * "charizard obsidian flames 199/197 PSA 10"
 *   → "charizard obsidian flames PSA 10"   (no card number)
 *   → "charizard obsidian flames 199/197"  (no grade)
 *   → "charizard obsidian flames"           (neither)
 */
function simplifyQuery(query: string): string[] {
  const variants: string[] = [];
  const seen = new Set<string>([query]);

  const cardNumberPattern = /\b\d{1,3}[/ ]\d{1,3}\b/g;
  const gradePattern = /\b(psa|bgs|cgc|sgc|ace)\s*\d*\b/gi;
  const clean = (s: string) => s.replace(/\s{2,}/g, " ").trim();

  for (const v of [
    clean(query.replace(cardNumberPattern, " ")),
    clean(query.replace(gradePattern, " ")),
    clean(query.replace(cardNumberPattern, " ").replace(gradePattern, " ")),
  ]) {
    if (v && !seen.has(v)) { seen.add(v); variants.push(v); }
  }
  return variants;
}

// ── Core search with sold-first strategy ─────────────────────────────────────

interface SearchResult {
  items: any[];
  effectiveQuery: string;
  usedSoldData: boolean;
  source: string;
}

/**
 * Run the market+category fallback chain for one soldOnly mode.
 *
 *   Step 1: EBAY_GB + category
 *   Step 2: EBAY_GB, no category
 *   Step 3: EBAY_US, no category (prices converted to GBP)
 *
 * Returns null if all steps produce zero results.
 */
async function searchMarkets(
  token: string,
  query: string,
  categoryId: string,
  limit: number,
  soldOnly: boolean
): Promise<{ items: any[]; marketplace: string } | null> {
  // Step 1: UK + category
  const gb1 = await browseSearch(token, query, limit, categoryId, "EBAY_GB", soldOnly);
  if (gb1.length > 0) return { items: gb1, marketplace: "EBAY_GB" };

  // Step 2: UK, no category
  const gb2 = await browseSearch(token, query, limit, undefined, "EBAY_GB", soldOnly);
  if (gb2.length > 0) return { items: gb2, marketplace: "EBAY_GB" };

  // Step 3: US, no category — convert USD → GBP
  const us = await browseSearch(token, query, limit, undefined, "EBAY_US", soldOnly);
  if (us.length > 0) return { items: normaliseToGBP(us), marketplace: "EBAY_US" };

  return null;
}

/** Sentinel thrown when the OAuth token is confirmed invalid (HTTP 401). */
class TokenInvalidError extends Error {
  constructor() { super("eBay OAuth token invalid (401)"); this.name = "TokenInvalidError"; }
}

/**
 * Full search with sold-first strategy and progressive query simplification.
 *
 *   Phase 1 — Sold listings
 *     Tries the full query then simplified variants across all markets.
 *
 *   Phase 2 — Active listings (fallback)
 *     Only runs if Phase 1 returns nothing everywhere.
 *     Caller receives usedSoldData:false so the UI can warn the user.
 */
async function searchListings(
  query: string,
  categoryId: string,
  limit: number
): Promise<SearchResult> {
  const token = await getEbayAppToken();
  const queriesToTry = [query, ...simplifyQuery(query)];

  /**
   * Wraps searchMarkets and converts a 401 FetchError into a TokenInvalidError
   * so the outer loops can abort immediately — no point continuing with a token
   * eBay has already rejected.
   */
  async function tryMarkets(
    q: string,
    soldOnly: boolean
  ): Promise<{ items: any[]; marketplace: string } | null> {
    try {
      return await searchMarkets(token, q, categoryId, limit, soldOnly);
    } catch (err) {
      if (err instanceof FetchError && err.status === 401) {
        // Clear the cache so the next top-level search gets a fresh token
        tokenCache = null;
        throw new TokenInvalidError();
      }
      // Any other error (5xx exhausted, network failure): log and treat as zero results
      console.warn(`[eBay] Search error for "${q}" (sold=${soldOnly}):`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ── Phase 1: Sold listings ─────────────────────────────────────────────────
  for (const q of queriesToTry) {
    try {
      const result = await tryMarkets(q, true);
      if (result) {
        if (q !== query) console.log(`[eBay] Sold: simplified query "${q}" matched on ${result.marketplace}`);
        return { items: result.items, effectiveQuery: q, usedSoldData: true, source: `sold-${result.marketplace}` };
      }
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        console.error("[eBay] Token invalid (401) — aborting search, cache cleared for next request");
        return { items: [], effectiveQuery: query, usedSoldData: false, source: "none" };
      }
    }
  }

  console.log(`[eBay] No sold listings found for "${query}" — falling back to active listings`);

  // ── Phase 2: Active listings ───────────────────────────────────────────────
  for (const q of queriesToTry) {
    try {
      const result = await tryMarkets(q, false);
      if (result) {
        if (q !== query) console.log(`[eBay] Active: simplified query "${q}" matched on ${result.marketplace}`);
        return { items: result.items, effectiveQuery: q, usedSoldData: false, source: `active-${result.marketplace}` };
      }
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        console.error("[eBay] Token invalid (401) — aborting search, cache cleared for next request");
        return { items: [], effectiveQuery: query, usedSoldData: false, source: "none" };
      }
    }
  }

  return { items: [], effectiveQuery: query, usedSoldData: false, source: "none" };
}

/** Map a Browse API item to the shared listing shape. */
function mapItem(item: any, soldData: boolean): EbaySoldListing {
  const soldDate = soldData
    ? (item.lastSoldDate ?? item.itemEndDate ?? item.itemCreationDate ?? "")
    : (item.itemCreationDate ?? "");

  return {
    title: item.title ?? "Unknown",
    price: parseFloat(item.price?.value ?? "0"),
    currency: item.price?.currency ?? "GBP",
    soldDate,
    condition: item.condition ?? "Not specified",
    itemUrl: item.itemWebUrl ?? "",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Preview top N listings for the product-linking confirmation step.
 * Sold listings are shown where available; falls back to active with a warning.
 */
export async function previewEbaySoldListings(
  query: string,
  categoryId: string,
  limit = 5
): Promise<EbayPreviewResult> {
  try {
    const { items, effectiveQuery, usedSoldData, source } = await searchListings(query, categoryId, limit);
    console.log(`[eBay] preview: source=${source} usedSold=${usedSoldData} count=${items.length} query="${effectiveQuery}"`);
    return {
      listings: items.slice(0, limit).map((i) => mapItem(i, usedSoldData)),
      effectiveQuery,
      usedSoldData,
    };
  } catch (error) {
    if (error instanceof FetchError) {
      throw new Error(`eBay search failed (HTTP ${error.status}): ${error.message}`);
    }
    throw error;
  }
}

/**
 * Get the trimmed average market price for a scheduled sync.
 * Uses sold data where available; active listings as approximation fallback.
 */
export async function getEbayMarketPrice(
  query: string,
  categoryId: string,
  daysBack = 30 // kept for API compatibility — not used with Browse API
): Promise<number | null> {
  try {
    const { items, effectiveQuery, usedSoldData, source } = await searchListings(query, categoryId, 50);

    if (items.length === 0) {
      console.warn(`[eBay] No listings found for "${query}" in category ${categoryId}`);
      return null;
    }

    // For active listing fallback: prefer fixed-price over auctions for cleaner signals
    let priceItems = items;
    if (!usedSoldData) {
      const fixed = items.filter((i: any) =>
        Array.isArray(i.buyingOptions) && i.buyingOptions.includes("FIXED_PRICE")
      );
      if (fixed.length >= 3) priceItems = fixed;
    }

    const prices = priceItems
      .map((i: any) => parseFloat(i.price?.value ?? "0"))
      .filter((p: number) => !isNaN(p) && p > 0);

    if (prices.length === 0) return null;

    prices.sort((a: number, b: number) => a - b);
    const trimCount = Math.floor(prices.length * 0.1);
    const endIndex = trimCount > 0 ? prices.length - trimCount : prices.length;
    const trimmed = prices.slice(trimCount, endIndex);
    const working = trimmed.length > 0 ? trimmed : prices;
    const average = working.reduce((sum: number, p: number) => sum + p, 0) / working.length;

    const querySuffix = effectiveQuery !== query ? ` (simplified from "${query}")` : "";
    console.log(
      `[eBay] "${effectiveQuery}"${querySuffix} — source=${source} usedSold=${usedSoldData}, ${working.length} prices, avg: £${average.toFixed(2)}`
    );
    return average;
  } catch (error) {
    console.error(`[eBay] getEbayMarketPrice failed for "${query}":`, error);
    return null;
  }
}

/**
 * Legacy compatibility shim.
 */
export async function searchEbayProducts(
  query: string
): Promise<{ id: string; title: string }[]> {
  const { listings } = await previewEbaySoldListings(query, "183454", 5);
  return listings.map((l, i) => ({ id: String(i), title: l.title }));
}
