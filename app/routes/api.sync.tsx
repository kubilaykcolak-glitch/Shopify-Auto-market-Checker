import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { runSyncForStore } from "../lib/price-engine.server";
import prisma from "../db.server";

/**
 * POST /api/sync
 * Triggers an immediate sync for the authenticated store.
 * Called from the dashboard "Sync Now" button via the loader action.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  if (!store) {
    return json({ error: "Store not found" }, { status: 404 });
  }

  // Fire and forget — return immediately so the UI isn't blocked
  runSyncForStore(store.id).catch((error: unknown) => {
    console.error(`[API/sync] Sync failed for ${session.shop}:`, error);
  });

  return json({ success: true, message: "Sync started" });
}