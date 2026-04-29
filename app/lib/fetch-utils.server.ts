/**
 * fetchWithRetry — resilient HTTP fetch wrapper
 *
 * Wraps the native fetch() with:
 * - Up to 3 retry attempts
 * - Exponential backoff on server errors (1s, 2s, 4s)
 * - Respects Retry-After header on HTTP 429 (rate limited)
 * - Throws immediately on 4xx client errors (except 429)
 *
 * All eBay, TCGPlayer, and PriceCharting calls should use this.
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class FetchError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  attempt = 1
): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(url, options);
  } catch (networkError) {
    // Network-level failure (DNS, connection refused, timeout)
    if (attempt >= MAX_RETRIES) {
      throw new Error(`Network error after ${MAX_RETRIES} attempts: ${url} — ${String(networkError)}`);
    }
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.warn(`[fetchWithRetry] Network error on attempt ${attempt}/${MAX_RETRIES}. Retrying in ${delay}ms...`);
    await sleep(delay);
    return fetchWithRetry(url, options, attempt + 1);
  }

  if (response.ok) return response;

  // Client error (4xx) except rate limit — don't retry
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new FetchError(
      response.status,
      `HTTP ${response.status} from ${url}`
    );
  }

  // Out of retries
  if (attempt >= MAX_RETRIES) {
    throw new FetchError(
      response.status,
      `HTTP ${response.status} after ${MAX_RETRIES} attempts: ${url}`
    );
  }

  // Rate limited — respect Retry-After if present
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "0", 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * Math.pow(2, attempt - 1);
    console.warn(`[fetchWithRetry] Rate limited (429). Waiting ${delay}ms before attempt ${attempt + 1}/${MAX_RETRIES}`);
    await sleep(delay);
    return fetchWithRetry(url, options, attempt + 1);
  }

  // Server error (5xx) — exponential backoff
  const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
  console.warn(`[fetchWithRetry] HTTP ${response.status}. Waiting ${delay}ms before attempt ${attempt + 1}/${MAX_RETRIES}`);
  await sleep(delay);
  return fetchWithRetry(url, options, attempt + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}