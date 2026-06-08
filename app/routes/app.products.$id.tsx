import {
  json,
  redirect,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Badge,
  Banner,
  DataTable,
  Box,
  Divider,
  Tooltip,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { EBAY_POKEMON_CATEGORIES } from "../lib/ebay-categories";
import { checkAndSyncProduct } from "../lib/price-engine.server";

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

  // sync_product needs rules + settings — fetch with full include
  if (intent === "sync_product") {
    const fullStore = await prisma.store.findUnique({
      where: { shop: session.shop },
      include: {
        rules: { orderBy: { createdAt: "asc" } },
        settings: true,
      },
    });
    if (!fullStore) return json({ error: "Store not found" });

    const syncProduct = await prisma.trackedProduct.findFirst({
      where: { id: params.id, storeId: fullStore.id },
    });
    if (!syncProduct) return json({ error: "Product not found" });

    const settings = fullStore.settings ?? {
      emailAlerts: false,
      alertEmail: null,
      slackWebhookUrl: null,
      discordWebhookUrl: null,
    };

    await checkAndSyncProduct(syncProduct, fullStore.rules, fullStore.shop, fullStore.accessToken, settings);
    return json({ success: true, intent: "sync_product" });
  }

  // All other intents only need the store id
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

  if (intent === "update_tracking") {
    const ebaySearchQuery = (formData.get("ebaySearchQuery") as string | null)?.trim() || null;
    const ebayCategoryId = (formData.get("ebayCategoryId") as string | null) || null;
    const cardCondition = (formData.get("cardCondition") as string | null) || product.cardCondition;

    await prisma.trackedProduct.update({
      where: { id: product.id },
      data: { ebaySearchQuery, ebayCategoryId, cardCondition },
    });
    return json({ success: true, intent: "update_tracking" });
  }

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
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [costPrice, setCostPrice] = useState(
    product.costPrice != null ? String(product.costPrice) : ""
  );

  // Tracking config editable state
  const [ebaySearchQuery, setEbaySearchQuery] = useState(
    product.ebaySearchQuery ?? product.externalName ?? ""
  );
  const [ebayCategoryId, setEbayCategoryId] = useState(
    product.ebayCategoryId ?? "183454"
  );
  const [cardCondition, setCardCondition] = useState(product.cardCondition ?? "near_mint");

  const isSaving = navigation.state === "submitting";
  const isPausing =
    isSaving && navigation.formData?.get("intent") === "toggle_pause";
  const isUnlinking =
    isSaving && navigation.formData?.get("intent") === "unlink";
  const isSyncing =
    isSaving && navigation.formData?.get("intent") === "sync_product";
  const isSavingTracking =
    isSaving && navigation.formData?.get("intent") === "update_tracking";

  function handleSaveTracking() {
    submit(
      { intent: "update_tracking", ebaySearchQuery, ebayCategoryId, cardCondition },
      { method: "POST" }
    );
  }

  function handleSaveCost() {
    submit({ intent: "update_cost", costPrice }, { method: "POST" });
  }

  function handleSyncNow() {
    submit({ intent: "sync_product" }, { method: "POST" });
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

  // Select options
  const categoryOptions = EBAY_POKEMON_CATEGORIES.map((c) => ({ label: c.label, value: c.value }));

  const conditionOptions = [
    { label: "Near Mint", value: "near_mint" },
    { label: "Lightly Played", value: "lightly_played" },
    { label: "Moderately Played", value: "moderately_played" },
    { label: "Heavily Played", value: "heavily_played" },
    { label: "Damaged", value: "damaged" },
    { label: "Graded", value: "graded" },
    { label: "Sealed", value: "sealed" },
  ];

  const priceChange =
    product.lastKnownPrice != null && product.baselinePrice != null && product.baselinePrice > 0
      ? ((product.lastKnownPrice - product.baselinePrice) / product.baselinePrice) * 100
      : null;

  const logRows = product.priceLogs.map((log) => {
    const actionTone =
      log.actionTaken === "price_updated"
        ? "success"
        : log.actionTaken === "product_disabled"
        ? "critical"
        : log.actionTaken === "floor_applied"
        ? "warning"
        : log.actionTaken === "rule_failed"
        ? "critical"
        : "info";

    // Full detail for the tooltip; fall back to the action name if no detail logged
    const detail = log.actionDetail?.trim() || log.actionTaken || "";

    return [
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
      // Tooltip keeps the table cell compact while still surfacing the full
      // detail text — long detail strings were previously breaking the layout.
      detail ? (
        <Tooltip content={detail} key={`action-${log.id}`} dismissOnMouseOut>
          <Badge tone={actionTone}>{log.actionTaken ?? "nothing"}</Badge>
        </Tooltip>
      ) : (
        <Badge tone={actionTone} key={`action-${log.id}`}>{log.actionTaken ?? "nothing"}</Badge>
      ),
    ];
  });

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
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">Tracking Configuration</Text>
                  <InlineStack gap="200">
                    <Badge tone="info">
                      {product.priceSource === "ebay"
                        ? "eBay"
                        : product.priceSource === "tcgplayer"
                        ? "TCGPlayer"
                        : product.priceSource === "pricecharting"
                        ? "PriceCharting"
                        : product.priceSource}
                    </Badge>
                    {product.disabledByRule ? (
                      <Badge tone="critical">Disabled by rule</Badge>
                    ) : product.isPaused ? (
                      <Badge tone="warning">Paused</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </InlineStack>
                </InlineStack>

                {/* eBay — editable fields */}
                {product.priceSource === "ebay" && (
                  <BlockStack gap="400">
                    <TextField
                      label="eBay search query"
                      value={ebaySearchQuery}
                      onChange={setEbaySearchQuery}
                      autoComplete="off"
                      helpText="The search term used to find sold listings on eBay. Edit this if results aren't matching your card."
                    />
                    <Select
                      label="eBay category"
                      options={categoryOptions}
                      value={ebayCategoryId}
                      onChange={setEbayCategoryId}
                      helpText="Narrows eBay results to the correct product type."
                    />
                    <Select
                      label="Condition"
                      options={conditionOptions}
                      value={cardCondition}
                      onChange={setCardCondition}
                      helpText="The condition used when matching sold listings."
                    />
                    <InlineStack>
                      <Button
                        variant="primary"
                        onClick={handleSaveTracking}
                        loading={isSavingTracking}
                      >
                        Save tracking config
                      </Button>
                    </InlineStack>
                    {actionData && "intent" in actionData && actionData.intent === "update_tracking" && (
                      <Banner tone="success">
                        <p>Tracking configuration saved. Sync now to fetch prices with the updated settings.</p>
                      </Banner>
                    )}
                  </BlockStack>
                )}

                {/* TCGPlayer / PriceCharting — read-only (external ID is fixed at link time) */}
                {product.priceSource !== "ebay" && (
                  <BlockStack gap="400">
                    <BlockStack gap="100">
                      <Text variant="bodySm" tone="subdued" as="p">Tracked item</Text>
                      <Text variant="bodyMd" as="p">{product.externalName}</Text>
                      <Text variant="bodySm" tone="subdued" as="p">
                        External ID: {product.externalId}
                      </Text>
                    </BlockStack>
                    <Select
                      label="Condition"
                      options={conditionOptions}
                      value={cardCondition}
                      onChange={setCardCondition}
                      helpText="The condition used when fetching prices."
                    />
                    <InlineStack>
                      <Button
                        variant="primary"
                        onClick={handleSaveTracking}
                        loading={isSavingTracking}
                      >
                        Save tracking config
                      </Button>
                    </InlineStack>
                    {actionData && "intent" in actionData && actionData.intent === "update_tracking" && (
                      <Banner tone="success">
                        <p>Tracking configuration saved. Sync now to fetch prices with the updated settings.</p>
                      </Banner>
                    )}
                    <Text variant="bodySm" tone="subdued" as="p">
                      To change the tracked item or price source, remove this link and re-link the product.
                    </Text>
                  </BlockStack>
                )}
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

                {/* Sync now */}
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text variant="bodyMd" fontWeight="semibold" as="span">
                          Manual sync
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="p">
                          Fetch the latest market price right now and apply any matching rules.
                        </Text>
                      </BlockStack>
                      <Button
                        variant="primary"
                        onClick={handleSyncNow}
                        loading={isSyncing}
                        disabled={product.isPaused}
                      >
                        Sync now
                      </Button>
                    </InlineStack>
                    {actionData && "intent" in actionData && actionData.intent === "sync_product" && (
                      <Banner tone="success">
                        <p>Sync complete — price and activity log updated.</p>
                      </Banner>
                    )}
                    {product.isPaused && (
                      <Text variant="bodySm" tone="subdued" as="p">
                        Resume tracking to enable manual sync.
                      </Text>
                    )}
                  </BlockStack>
                </Box>

                <Divider />

                {/* Pause / Resume */}
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