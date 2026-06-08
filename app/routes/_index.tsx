import { redirect } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

/**
 * Root route — Shopify loads the app at `application_url` (e.g. https://localhost:3001/).
 * All app UI lives under /app, so we redirect here while preserving Shopify's
 * query params (shop, hmac, host, session, id_token, etc.) so that
 * authenticate.admin() in app.tsx can complete the OAuth/session flow.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  return redirect(`/app${url.search}`);
};
