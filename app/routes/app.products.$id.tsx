import {
  json,
  redirect,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Badge,
  Banner,
  DataTable,
  Box,
  Divider,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { EBAY_POKEMON_CATEGORIES } from "../lib/ebay-categories";

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  if (!store) throw new Response("Store not found", { status: 404 });

  const product = await prisma.trackedProduct.findFirst({
    where: { id: params.id, storeId: store.id },
    include: {
      priceLogs: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  if (!product) throw new Response("Product not found", { status: 404 });

  return json({ product });
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });
  if (!store) return json({ error: "Store not found" });

  // Verify this product belongs to the current store
  const product = await prisma.trackedProduct.findFirst({
    where: { id: params.id, storeId: store.id },
  });
  if (!product) return json({ error: "Product not found" });

  if (intent === "update_cost") {
    const costPriceRaw = formData.get("costPrice") as string;
    const costPrice = costPriceRaw ? parseFloat(costPriceRaw) : null;

    await prisma.trackedProduct.update({
      where: { id: product.id },
      data: {
        costPrice: costPrice && !isNaN(costPrice) ? costPrice : null,
        costPriceSource: "manual",
      },
    });
    return json({ success: true, intent: "update_cost" });
  }

  if (intent === "toggle_pause") {
    await prisma.trackedProduct.update({
      where: { id: product.id },
      data: { isPaused: !product.isPaused },
    });
    return json({ success: true, intent: "toggle_pause" });
  }

  if (intent === "unlink") {
    await prisma.trackedProduct.delete({ where: { id: product.id } });
    return redirect("/app");
  }

  return json({ error: "Unknown intent" });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProductDetail() {
  const { product } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [costPrice, setCostPrice] = useState(
    product.costPrice != null ? String(product.costPrice) : ""
  );

  const isSaving = navigation.state === "submitting";
  const isPausing =
    isSaving && navigation.formData?.get("intent") === "toggle_pause";
  const isUnlinking =
    isSaving && navigation.formData?.get("intent") === "unlink";

  function handleSaveCost() {
    submit({ intent: "update_cost", costPrice }, { method: "POST" });
  }

  function handleTogglePause() {
    submit({ intent: "toggle_pause" }, { method: "POST" });
  }

  function handleUnlink() {
    if (
      confirm(
        `Remove tracking for "${product.shopifyProductTitle}"? This cannot be undone. Your Shopify product will not be affected.`
      )
    ) {
      submit({ intent: "unlink" }, { method: "POST" });
    }
  }

  // Derive eBay category label if applicable
  const ebayCategoryLabel = product.ebayCategoryId
    ? EBAY_POKEMON_CATEGORIES.find((c) => c.value === product.ebayCategoryId)?.label
    : null;

  const priceChange =
    product.lastKnownPrice != null && product.baselinePrice != null && product.baselinePrice > 0
      ? ((product.lastKnownPrice - product.baselinePrice) / product.baselinePrice) * 100
      : null;

  const logRows = product.priceLogs.map((log) => [
    new Date(log.createdAt).toLocaleString("en-GB"),
    `£${log.fetchedPrice.toFixed(2)}`,
    log.previousPrice != null ? `£${log.previousPrice.toFixed(2)}` : "—",
    log.changePercent != null
      ? (
          <Text
            as="span"
            tone={log.changePercent >= 0 ? "success" : "critical"}
            key={log.id}
          >
            {log.changePercent >= 0 ? "+" : ""}
            {log.changePercent.toFixed(1)}%
          </Text>
        )
      : "—",
    <Badge
      key={`action-${log.id}`}
      tone={
        log.actionTaken === "price_updated"
          ? "success"
          : log.actionTaken === "product_disabled"
          ? "critical"
          : log.actionTaken === "floor_applied"
          ? "warning"
          : "info"
      }
    >
      {log.actionTaken ?? "nothing"}
    </Badge>,
  ]);

  return (
    <Page
      title={product.shopifyProductTitle}
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {/* ── Status banner ─────────────────────────────────────────── */}
            {product.disabledByRule && (
              <Banner tone="critical" title="This product is currently disabled by a rule">
                <p>
                  A price drop rule set this product's inventory to 0. It will be re-enabled
                  automatically if a price rise rule triggers, or you can re-enable it manually
                  in Shopify.
                </p>
              </Banner>
            )}

            {/* ── Price summary ──────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Price Summary</Text>
                <InlineStack gap="600" wrap>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued" as="p">Current market price</Text>
                    <Text variant="headingLg" as="p">
                      {product.lastKnownPrice != null
                        ? `£${product.lastKnownPrice.toFixed(2)}`
                        : "Not yet fetched"}
                    </Text>
                    {priceChange != null && (
                      <Text
                        as="p"
                        tone={priceChange >= 0 ? "success" : "critical"}
                        variant="bodySm"
                      >
                        {priceChange >= 0 ? "▲" : "▼"} {Math.abs(priceChange).toFixed(1)}% since
                        baseline
                      </Text>
                    )}
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued" as="p">Baseline price</Text>
                    <Text variant="headingLg" as="p">
                      {product.baselinePrice != null
                        ? `£${product.baselinePrice.toFixed(2)}`
                        : "—"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued" as="p">Shopify price</Text>
                    <Text variant="headingLg" as="p">
                      £{product.shopifyCurrentPrice.toFixed(2)}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text variant="bodySm" tone="subdued" as="p">Last checked</Text>
                    <Text variant="bodyMd" as="p">
                      {product.lastCheckedAt
                        ? new Date(product.lastCheckedAt).toLocaleString("en-GB")
                        : "Never"}
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Tracking config ────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">Tracking Configuration</Text>
                <InlineStack gap="400" wrap>
                  <Box>
                    <Text variant="bodySm" tone="subdued" as="p">Price source</Text>
                    <Badge tone="info">{product.priceSource}</Badge>
                  </Box>
                  {product.priceSource === "ebay" ? (
                    <>
                      <BlockStack gap="050">
                        <Text variant="bodySm" tone="subdued" as="p">eBay search query</Text>
                        <Text variant="bodyMd" as="p">
                          {product.ebaySearchQuery ?? product.externalName}
                        </Text>
                      </BlockStack>
                      <BlockStack gap="050">
                        <Text variant="bodySm" tone="subdued" as="p">eBay category</Text>
                        <Text variant="bodyMd" as="p">
                          {ebayCategoryLabel ?? product.ebayCategoryId ?? "—"}
                        </Text>
                      </BlockStack>
                    </>
                  ) : (
                    <BlockStack gap="050">
                      <Text variant="bodySm" tone="subdued" as="p">Tracked item</Text>
                      <Text variant="bodyMd" as="p">{product.externalName}</Text>
                    </BlockStack>
                  )}
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued" as="p">Condition</Text>
                    <Text variant="bodyMd" as="p">
                      {product.cardCondition.replace(/_/g, " ")}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text variant="bodySm" tone="subdued" as="p">Status</Text>
                    {product.disabledByRule ? (
                      <Badge tone="critical">Disabled by rule</Badge>
                    ) : product.isPaused ? (
                      <Badge tone="warning">Paused</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Cost price ─────────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text variant="headingMd" as="h2">Cost Price</Text>
                  {product.costPriceSource && (
                    <Badge tone={product.costPriceSource === "shopify" ? "info" : "success"}>
                      {product.costPriceSource === "shopify" ? "From Shopify" : "Manual"}
                    </Badge>
                  )}
                </InlineStack>
                <Text tone="subdued" as="p">
                  Your cost price is the anchor for floor price rules. It ensures you never
                  sell below cost + your configured minimum margin.
                </Text>
                <TextField
                  label="Cost price (£)"
                  type="number"
                  value={costPrice}
                  onChange={setCostPrice}
                  autoComplete="off"
                  prefix="£"
                  placeholder="e.g. 12.50"
                  helpText="What you paid for this item."
                />
                <InlineStack>
                  <Button onClick={handleSaveCost} loading={isSaving}>
                    Save cost price
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ── Price history ──────────────────────────────────────────── */}
            {product.priceLogs.length > 0 && (
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Price History (last {product.priceLogs.length} checks)
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["Time", "Market Price", "Previous", "Change", "Action"]}
                    rows={logRows}
                  />
                </BlockStack>
              </Card>
            )}

            {/* ── Controls ──────────────────────────────────────────────── */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Controls</Text>
                <InlineStack gap="300">
                  <Button
                    onClick={handleTogglePause}
                    loading={isPausing}
                    variant={product.isPaused ? "primary" : "secondary"}
                  >
                    {product.isPaused ? "Resume tracking" : "Pause tracking"}
                  </Button>
                </InlineStack>
                <Text tone="subdued" as="p" variant="bodySm">
                  Pausing stops price syncs for this product without removing the link.
                </Text>

                <Divider />

                <BlockStack gap="200">
                  <Text variant="bodyMd" fontWeight="semibold" as="p" tone="critical">
                    Danger zone
                  </Text>
                  <Text tone="subdued" as="p" variant="bodySm">
                    Removing this link stops tracking and deletes all price history for this
                    product. Your Shopify product listing is not affected.
                  </Text>
                  <InlineStack>
                    <Button
                      tone="critical"
                      onClick={handleUnlink}
                      loading={isUnlinking}
                    >
                      Remove product link
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}