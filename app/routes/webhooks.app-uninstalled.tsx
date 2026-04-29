import { authenticate } from "../shopify.server";
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED":
      // Delete all store data when the app is uninstalled
      await prisma.store.delete({ where: { shop } }).catch(() => {
        // Store may not exist if install was incomplete — ignore
      });
      console.log(`[Webhook] APP_UNINSTALLED — cleaned up data for ${shop}`);
      break;

    default:
      console.log(`[Webhook] Unhandled topic: ${topic}`);
  }

  return new Response();
};