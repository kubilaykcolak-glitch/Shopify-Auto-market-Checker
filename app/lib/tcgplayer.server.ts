/**
 * TCGPlayer Price Service
 *
 * TCGPlayer has a Partner API — you need to apply at:
 * https://developer.tcgplayer.com/
 *
 * After approval you get: TCGPLAYER_PUBLIC_KEY and TCGPLAYER_PRIVATE_KEY
 *
 * The API flow:
 * 1. Get bearer token (client credentials)
 * 2. Search for product by name
 * 3. Get pricing for that product ID
 */

const TCGPLAYER_API_BASE = "https://api.tcgplayer.com";
const TCGPLAYER_API_VERSION = "v1.39.0";

interface TCGPlayerPrice {
  subTypeName: string; // "Normal", "Holofoil", etc.
  lowPrice: number;
  midPrice: number;
  highPrice: number;
  marketPrice: number | null;
  directLowPrice: number | null;
}

interface TCGPlayerProduct {
  productId: number;
  name: string;
  cleanName: string;
  imageUrl: string;
  groupId: number;
  url: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getBearerToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const publicKey = process.env.TCGPLAYER_PUBLIC_KEY;
  const privateKey = process.env.TCGPLAYER_PRIVATE_KEY;

  if (!publicKey || !privateKey) {
    throw new Error("TCGPlayer API keys not configured (TCGPLAYER_PUBLIC_KEY, TCGPLAYER_PRIVATE_KEY)");
  }

  const response = await fetch(`${TCGPLAYER_API_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: publicKey,
      client_secret: privateKey,
    }),
  });

  if (!response.ok) {
    throw new Error(`TCGPlayer auth failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

export async function searchTCGPlayerProduct(query: string): Promise<TCGPlayerProduct[]> {
  const token = await getBearerToken();

  const params = new URLSearchParams({
    q: query,
    limit: "10",
    offset: "0",
    categoryId: "3", // 3 = Pokémon
  });

  const response = await fetch(
    `${TCGPLAYER_API_BASE}/${TCGPLAYER_API_VERSION}/catalog/products?${params}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`TCGPlayer search failed: ${response.status}`);
  }

  const data = await response.json();
  return data.results || [];
}

export async function getTCGPlayerPrice(productId: string, condition: string = "near_mint"): Promise<number | null> {
  const token = await getBearerToken();

  const response = await fetch(
    `${TCGPLAYER_API_BASE}/${TCGPLAYER_API_VERSION}/pricing/product/${productId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`TCGPlayer pricing failed: ${response.status} for product ${productId}`);
  }

  const data = await response.json();
  const results: TCGPlayerPrice[] = data.results || [];

  if (results.length === 0) return null;

  // Map condition to TCGPlayer subTypeName
  const conditionMap: Record<string, string[]> = {
    near_mint: ["Normal", "Holofoil", "Reverse Holofoil"],
    lightly_played: ["Lightly Played", "Lightly Played Holofoil"],
    moderately_played: ["Moderately Played"],
    heavily_played: ["Heavily Played"],
    damaged: ["Damaged"],
    psa10: ["PSA 10"],
    psa9: ["PSA 9"],
    psa8: ["PSA 8"],
  };

  const targetSubtypes = conditionMap[condition] || conditionMap["near_mint"];
  const match = results.find((r) => targetSubtypes.some((t) => r.subTypeName?.includes(t)));
  const priceEntry = match || results[0];

  // Prefer marketPrice, fall back to midPrice
  return priceEntry.marketPrice ?? priceEntry.midPrice ?? null;
}
