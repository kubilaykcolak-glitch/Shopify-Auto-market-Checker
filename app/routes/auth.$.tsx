import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate, login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // The SDK redirects to /auth/login when it can't find a valid shop/session.
  // authenticate.admin() must NOT be called from that path — call login() instead,
  // which renders Shopify's OAuth install flow.
  if (url.pathname === "/auth/login") {
    return login(request);
  }

  // All other /auth/* paths (/auth/callback, /auth/session-token, /auth/exit-iframe, etc.)
  // are handled by the SDK internally — it throws the appropriate Response itself.
  await authenticate.admin(request);
  return null;
};
