/**
 * PriceCharting Service
 *
 * PriceCharting has a simple API for card/game prices.
 * Sign up at: https://www.pricecharting.com/api-documentation
 * You need: PRICECHARTING_API_KEY
 *
 * Great for sealed products and vintage sets.
 */

const PRICECHARTING_API_BASE = "https://www.pricecharting.com/api";

interface PriceChartingProduct {
  id: string;
  "product-name": string;
  "console-name": string;
  "loose-price": number;   // raw/ungraded price (in cents)
  "cib-price": number;     // complete in box
  "new-price": number;     // sealed/new
  "graded-price": number;  // graded (PSA 9/10 average)
  "box-only-price": number;
  "manual-only-price": number;
}

export async function searchPriceChartingProducts(query: string): Promise<{ id: string; name: string; console: string }[]> {
  const apiKey = process.env.PRICECHARTING_API_KEY;
  if (!apiKey) throw new Error("PRICECHARTING_API_KEY not configured");

  const response = await fetch(
    `${PRICECHARTING_API_BASE}/products?q=${encodeURIComponent(query)}&id=${apiKey}`
  );

  if (!response.ok) throw new Error(`PriceCharting search failed: ${response.status}`);

  const data = await response.json();
  const products: PriceChartingProduct[] = data.products || [];

  return products
    .filter((p) => p["console-name"]?.toLowerCase().includes("pokemon"))
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      name: p["product-name"],
      console: p["console-name"],
    }));
}

export async function getPriceChartingPrice(
  productId: string,
  condition: string = "near_mint"
): Promise<number | null> {
  const apiKey = process.env.PRICECHARTING_API_KEY;
  if (!apiKey) throw new Error("PRICECHARTING_API_KEY not configured");

  const response = await fetch(
    `${PRICECHARTING_API_BASE}/product?id=${productId}&key=${apiKey}`
  );

  if (!response.ok) throw new Error(`PriceCharting pricing failed: ${response.status}`);

  const data: PriceChartingProduct = await response.json();

  // Prices come in cents — convert to pounds (approximate, uses USD/GBP rate env var or default)
  const fxRate = parseFloat(process.env.USD_TO_GBP_RATE || "0.79");

  const priceMap: Record<string, number | null> = {
    near_mint: data["loose-price"] ? (data["loose-price"] / 100) * fxRate : null,
    loose: data["loose-price"] ? (data["loose-price"] / 100) * fxRate : null,
    sealed: data["new-price"] ? (data["new-price"] / 100) * fxRate : null,
    new: data["new-price"] ? (data["new-price"] / 100) * fxRate : null,
    graded: data["graded-price"] ? (data["graded-price"] / 100) * fxRate : null,
    psa10: data["graded-price"] ? (data["graded-price"] / 100) * fxRate : null,
    psa9: data["graded-price"] ? (data["graded-price"] / 100) * fxRate * 0.7 : null, // approx discount
    cib: data["cib-price"] ? (data["cib-price"] / 100) * fxRate : null,
  };

  return priceMap[condition] ?? priceMap["near_mint"] ?? null;
}
