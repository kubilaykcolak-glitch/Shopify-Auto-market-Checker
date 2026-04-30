import React, { useState, useMemo } from "react";
import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  useLoaderData,
  useSubmit,
  useNavigation,
  useActionData,
} from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  InlineGrid,
  Button,
  TextField,
  Select,
  ResourceList,
  ResourceItem,
  Thumbnail,
  Badge,
  Banner,
  DataTable,
  Box,
  Link,
  Checkbox,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { searchTCGPlayerProduct } from "../lib/tcgplayer.server";
import { previewEbaySoldListings } from "../lib/ebay.server";
import { searchPriceChartingProducts } from "../lib/pricecharting.server";
import type { EbaySoldListing } from "../lib/ebay.server";
import { EBAY_POKEMON_CATEGORIES } from "../lib/ebay-categories";

// ── Loader: fetch Shopify products ───────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      products(first: 250) {
        edges {
          node {
            id
            title
            featuredImage { url }
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  price
                  inventoryItem {
                    unitCost { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }
    }
  `);

  const { data } = await response.json();
  const shopifyProducts = data?.products?.edges?.map((e: any) => e.node) ?? [];

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    select: { id: true },
  });

  return json({ shopifyProducts, storeId: store?.id });
}

// ── Action ───────────────────────────────────────────────────────────────────

type ActionResult =
  | { intent: "search_results"; results: { id: string; name: string; extra?: string }[]; error: string | null }
  | { intent: "ebay_preview"; listings: EbaySoldListing[]; error: string | null }
  | { intent: "link_success"; count: number; error: null }
  | { error: string };

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Search TCGPlayer / PriceCharting ─────────────────────────────────────
  if (intent === "search_price_source") {
    const query = formData.get("query") as string;
    const source = formData.get("source") as string;

    try {
      let results: { id: string; name: string; extra?: string }[] = [];
      if (source === "tcgplayer") {
        const r = await searchTCGPlayerProduct(query);
        results = r.map((p) => ({ id: String(p.productId), name: p.name }));
      } else if (source === "pricecharting") {
        const r = await searchPriceChartingProducts(query);
        results = r.map((p) => ({ id: p.id, name: p.name, extra: p.console }));
      }
      return json<ActionResult>({ intent: "search_results", results, error: null });
    } catch (error: any) {
      return json<ActionResult>({ intent: "search_results", results: [], error: error.message });
    }
  }

  // ── eBay: preview sold listings ──────────────────────────────────────────
  if (intent === "preview_ebay") {
    const query = formData.get("query") as string;
    const categoryId = formData.get("categoryId") as string;
    try {
      const listings = await previewEbaySoldListings(query, categoryId, 5);
      return json<ActionResult>({ intent: "ebay_preview", listings, error: null });
    } catch (error: any) {
      return json<ActionResult>({ intent: "ebay_preview", listings: [], error: error.message });
    }
  }

  // ── Single product link ──────────────────────────────────────────────────
  if (intent === "link_product") {
    const store = await prisma.store.findUnique({ where: { shop: session.shop } });
    if (!store) return json<ActionResult>({ error: "Store not found" });

    const shopifyProductId = formData.get("shopifyProductId") as string;
    const shopifyVariantId = formData.get("shopifyVariantId") as string;
    const shopifyProductTitle = formData.get("shopifyProductTitle") as string;
    const shopifyCurrentPrice = parseFloat(formData.get("shopifyCurrentPrice") as string);
    const priceSource = formData.get("priceSource") as string;
    const externalId = (formData.get("externalId") as string) ?? "";
    const externalName = (formData.get("externalName") as string) ?? "";
    const cardCondition = (formData.get("cardCondition") as string) || "near_mint";
    const isSealed = formData.get("isSealed") === "true";
    const ebaySearchQuery = (formData.get("ebaySearchQuery") as string) || null;
    const ebayCategoryId = (formData.get("ebayCategoryId") as string) || null;
    const costPriceRaw = formData.get("costPrice") as string;
    const costPrice = costPriceRaw ? parseFloat(costPriceRaw) : null;
    const costPriceSource = (formData.get("costPriceSource") as string) || null;

    await prisma.trackedProduct.upsert({
      where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId } },
      update: { priceSource, externalId, externalName, cardCondition, isSealed, ebaySearchQuery, ebayCategoryId, costPrice, costPriceSource },
      create: {
        storeId: store.id,
        shopifyProductId,
        shopifyVariantId,
        shopifyProductTitle,
        shopifyCurrentPrice,
        priceSource,
        externalId,
        externalName,
        cardCondition,
        isSealed,
        ebaySearchQuery,
        ebayCategoryId,
        costPrice,
        costPriceSource,
        baselinePrice: shopifyCurrentPrice,
      },
    });

    return json<ActionResult>({ intent: "link_success", count: 1, error: null });
  }

  // ── Bulk product link ────────────────────────────────────────────────────
  if (intent === "link_products_bulk") {
    const store = await prisma.store.findUnique({ where: { shop: session.shop } });
    if (!store) return json<ActionResult>({ error: "Store not found" });

    const priceSource = formData.get("priceSource") as string;
    const cardCondition = (formData.get("cardCondition") as string) || "near_mint";
    const ebayCategory = (formData.get("ebayCategory") as string) || "183454";
    const externalId = (formData.get("externalId") as string) ?? "";
    const externalName = (formData.get("externalName") as string) ?? "";
    const productsJson = formData.get("productsJson") as string;

    const products: {
      shopifyProductId: string;
      shopifyVariantId: string;
      shopifyProductTitle: string;
      shopifyCurrentPrice: string;
      costPrice: string;
    }[] = JSON.parse(productsJson);

    for (const p of products) {
      const isEbay = priceSource === "ebay";
      const currentPrice = parseFloat(p.shopifyCurrentPrice) || 0;
      const costPrice = p.costPrice ? parseFloat(p.costPrice) : null;

      await prisma.trackedProduct.upsert({
        where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId: p.shopifyVariantId } },
        update: {
          priceSource,
          externalId: isEbay ? "" : externalId,
          externalName: isEbay ? p.shopifyProductTitle : externalName,
          cardCondition,
          isSealed: false,
          ebaySearchQuery: isEbay ? p.shopifyProductTitle : null,
          ebayCategoryId: isEbay ? ebayCategory : null,
          costPrice,
          costPriceSource: costPrice ? "manual" : null,
        },
        create: {
          storeId: store.id,
          shopifyProductId: p.shopifyProductId,
          shopifyVariantId: p.shopifyVariantId,
          shopifyProductTitle: p.shopifyProductTitle,
          shopifyCurrentPrice: currentPrice,
          priceSource,
          externalId: isEbay ? "" : externalId,
          externalName: isEbay ? p.shopifyProductTitle : externalName,
          cardCondition,
          isSealed: false,
          ebaySearchQuery: isEbay ? p.shopifyProductTitle : null,
          ebayCategoryId: isEbay ? ebayCategory : null,
          costPrice,
          costPriceSource: costPrice ? "manual" : null,
          baselinePrice: currentPrice,
        },
      });
    }

    return json<ActionResult>({ intent: "link_success", count: products.length, error: null });
  }

  return json<ActionResult>({ error: "Unknown intent" });
}

// ── Static options ────────────────────────────────────────────────────────────

const conditionOptions = [
  { label: "Near Mint (NM)", value: "near_mint" },
  { label: "Lightly Played (LP)", value: "lightly_played" },
  { label: "Moderately Played (MP)", value: "moderately_played" },
  { label: "Heavily Played (HP)", value: "heavily_played" },
  { label: "PSA 10", value: "psa10" },
  { label: "PSA 9", value: "psa9" },
  { label: "PSA 8", value: "psa8" },
  { label: "Sealed / New", value: "sealed" },
];

const sourceOptions = [
  { label: "eBay sold listings (UK market prices)", value: "ebay" },
  { label: "TCGPlayer (best for individual cards)", value: "tcgplayer" },
  { label: "PriceCharting (sealed products & vintage)", value: "pricecharting" },
];

const ebayCategoryOptions = EBAY_POKEMON_CATEGORIES.map((c) => ({
  label: c.label,
  value: c.value,
}));

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProduct() {
  const { shopifyProducts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  // ── Product list state ───────────────────────────────────────────────────
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ── Price source config ──────────────────────────────────────────────────
  const [priceSource, setPriceSource] = useState("ebay");
  const [cardCondition, setCardCondition] = useState("near_mint");
  const [ebayCategory, setEbayCategory] = useState("183454");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedExternal, setSelectedExternal] = useState<{ id: string; name: string; extra?: string } | null>(null);
  const [ebayConfirmed, setEbayConfirmed] = useState(false);

  // ── Cost price ───────────────────────────────────────────────────────────
  const [costPriceShared, setCostPriceShared] = useState("");
  const [useShopifyCost, setUseShopifyCost] = useState(true);

  // ── Derived state ────────────────────────────────────────────────────────
  const filteredProducts = useMemo(
    () => shopifyProducts.filter((p: any) =>
      p.title.toLowerCase().includes(searchFilter.toLowerCase())
    ),
    [shopifyProducts, searchFilter]
  );

  const selectedProducts = useMemo(
    () => shopifyProducts.filter((p: any) => selectedIds.includes(p.id)),
    [shopifyProducts, selectedIds]
  );

  const isSingleSelect = selectedIds.length === 1;
  const isMultiSelect = selectedIds.length > 1;
  const singleProduct = isSingleSelect ? selectedProducts[0] : null;
  const singleVariant = singleProduct ? singleProduct.variants.edges[0]?.node : null;
  const shopifyCostForSingle = singleVariant?.inventoryItem?.unitCost?.amount
    ? parseFloat(singleVariant.inventoryItem.unitCost.amount)
    : null;

  // ── Navigation states ────────────────────────────────────────────────────
  const isSearching =
    navigation.state === "submitting" &&
    (navigation.formData?.get("intent") === "search_price_source" ||
      navigation.formData?.get("intent") === "preview_ebay");
  const isLinking =
    navigation.state === "submitting" &&
    (navigation.formData?.get("intent") === "link_product" ||
      navigation.formData?.get("intent") === "link_products_bulk");

  // ── Action data ──────────────────────────────────────────────────────────
  const searchResults =
    actionData && "intent" in actionData && actionData.intent === "search_results"
      ? actionData.results : [];

  const ebayPreviewListings: EbaySoldListing[] =
    actionData && "intent" in actionData && actionData.intent === "ebay_preview"
      ? actionData.listings : [];

  const hasEbayError =
    actionData && "intent" in actionData &&
    actionData.intent === "ebay_preview" && actionData.error;

  // ── Ready-to-link check ──────────────────────────────────────────────────
  const configReady =
    selectedIds.length > 0 &&
    (priceSource === "ebay"
      ? isMultiSelect || (ebayConfirmed && searchQuery.trim().length > 0)
      : !!selectedExternal);

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleSourceChange(v: string) {
    setPriceSource(v);
    setSelectedExternal(null);
    setEbayConfirmed(false);
    setSearchQuery("");
  }

  function handleSearch() {
    submit({ intent: "search_price_source", query: searchQuery, source: priceSource }, { method: "POST" });
  }

  function handleEbayPreview() {
    submit({ intent: "preview_ebay", query: searchQuery, categoryId: ebayCategory }, { method: "POST" });
  }

  function handleLink() {
    if (isSingleSelect && singleProduct && singleVariant) {
      const isEbay = priceSource === "ebay";
      let costPrice = costPriceShared;
      if (useShopifyCost && shopifyCostForSingle && shopifyCostForSingle > 0) {
        costPrice = shopifyCostForSingle.toFixed(2);
      }
      submit(
        {
          intent: "link_product",
          shopifyProductId: singleProduct.id,
          shopifyVariantId: singleVariant.id,
          shopifyProductTitle: singleProduct.title,
          shopifyCurrentPrice: singleVariant.price,
          priceSource,
          externalId: isEbay ? "" : (selectedExternal?.id ?? ""),
          externalName: isEbay ? searchQuery : (selectedExternal?.name ?? ""),
          cardCondition,
          isSealed: String(cardCondition === "sealed"),
          ebaySearchQuery: isEbay ? searchQuery : "",
          ebayCategoryId: isEbay ? ebayCategory : "",
          costPrice,
          costPriceSource: (useShopifyCost && shopifyCostForSingle) ? "shopify" : "manual",
        },
        { method: "POST" }
      );
    } else {
      const productsPayload = selectedProducts.map((p: any) => {
        const variant = p.variants.edges[0]?.node;
        let costPrice = costPriceShared;
        if (useShopifyCost) {
          const shopifyCost = variant?.inventoryItem?.unitCost?.amount;
          if (shopifyCost && parseFloat(shopifyCost) > 0) {
            costPrice = parseFloat(shopifyCost).toFixed(2);
          }
        }
        return {
          shopifyProductId: p.id,
          shopifyVariantId: variant?.id ?? "",
          shopifyProductTitle: p.title,
          shopifyCurrentPrice: variant?.price ?? "0",
          costPrice,
        };
      });

      submit(
        {
          intent: "link_products_bulk",
          productsJson: JSON.stringify(productsPayload),
          priceSource,
          cardCondition,
          ebayCategory,
          externalId: selectedExternal?.id ?? "",
          externalName: selectedExternal?.name ?? "",
        },
        { method: "POST" }
      );
    }
  }

  // ── Success screen ────────────────────────────────────────────────────────
  if (actionData && "intent" in actionData && actionData.intent === "link_success") {
    const count = actionData.count;
    return (
      <Page title={count === 1 ? "Product Linked!" : "Products Linked!"} backAction={{ content: "Dashboard", url: "/app" }}>
        <BlockStack gap="400">
          <Banner
            tone="success"
            title={count === 1 ? "Product successfully linked" : `${count} products successfully linked`}
          >
            <p>
              {count === 1
                ? "The product is now tracked. Prices will sync on the next scheduled check, or trigger a manual sync from the dashboard."
                : `All ${count} products are now tracked. Prices will sync on the next scheduled check.`}
            </p>
          </Banner>
          <InlineStack gap="300">
            <Button url="/app/products/new" variant="primary">Link more products</Button>
            <Button url="/app">Back to dashboard</Button>
          </InlineStack>
        </BlockStack>
      </Page>
    );
  }

  return (
    <Page title="Link Products" backAction={{ content: "Dashboard", url: "/app" }}>
      <InlineGrid columns={["oneHalf", "oneHalf"]} gap="500">

        {/* ── LEFT: Search + Select ─────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text variant="headingMd" as="h2">Select products</Text>
                <Text variant="bodySm" tone="subdued" as="p">
                  Choose one or more products to track.
                </Text>
              </BlockStack>
              {selectedIds.length > 0 && (
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="info">{`${selectedIds.length} selected`}</Badge>
                  <Button size="slim" variant="plain" onClick={() => setSelectedIds([])}>
                    Clear
                  </Button>
                </InlineStack>
              )}
            </InlineStack>

            <TextField
              label="Search products"
              labelHidden
              value={searchFilter}
              onChange={setSearchFilter}
              placeholder="Search by product name..."
              autoComplete="off"
              clearButton
              onClearButtonClick={() => setSearchFilter("")}
            />

            {filteredProducts.length === 0 && searchFilter ? (
              <Box padding="400">
                <Text tone="subdued" as="p" alignment="center">
                  No products match "{searchFilter}"
                </Text>
              </Box>
            ) : (
              <ResourceList
                resourceName={{ singular: "product", plural: "products" }}
                items={filteredProducts}
                selectedItems={selectedIds}
                onSelectionChange={(ids) =>
                  setSelectedIds(
                    ids === "All"
                      ? filteredProducts.map((p: any) => p.id)
                      : (ids as string[])
                  )
                }
                selectable
                renderItem={(product: any) => {
                  const variant = product.variants.edges[0]?.node;
                  return (
                    <ResourceItem
                      id={product.id}
                      onClick={() => {
                        setSelectedIds((prev) =>
                          prev.includes(product.id)
                            ? prev.filter((id) => id !== product.id)
                            : [...prev, product.id]
                        );
                      }}
                      media={
                        product.featuredImage ? (
                          <Thumbnail source={product.featuredImage.url} alt={product.title} size="small" />
                        ) : (
                          <Thumbnail source="" alt={product.title} size="small" />
                        )
                      }
                    >
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="semibold" as="span">
                          {product.title}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="span">
                          {product.variants.edges.length} variant
                          {product.variants.edges.length !== 1 ? "s" : ""} · £{variant?.price}
                        </Text>
                      </BlockStack>
                    </ResourceItem>
                  );
                }}
              />
            )}

            {shopifyProducts.length === 250 && (
              <Banner tone="warning">
                <p>
                  Showing your first 250 products. Use the search above to find others.
                </p>
              </Banner>
            )}
          </BlockStack>
        </Card>

        {/* ── RIGHT: Configure + Cost + Link ───────────────────────────────── */}
        <BlockStack gap="400">
          {selectedIds.length === 0 ? (
            /* Placeholder when nothing is selected */
            <Card>
              <Box padding="600">
                <BlockStack gap="200">
                  <Text variant="bodyMd" tone="subdued" as="p" alignment="center">
                    ← Select one or more products to configure their price source.
                  </Text>
                </BlockStack>
              </Box>
            </Card>
          ) : (
            <>
              {/* ── Configure price source ─────────────────────────────────── */}
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="050">
                    <Text variant="headingMd" as="h2">Configure price source</Text>
                    {isMultiSelect && (
                      <Text variant="bodySm" tone="subdued" as="p">
                        Applies to all {selectedIds.length} selected products.
                      </Text>
                    )}
                  </BlockStack>

                  <Select
                    label="Price data source"
                    options={sourceOptions}
                    value={priceSource}
                    onChange={handleSourceChange}
                  />

                  {priceSource !== "ebay" && (
                    <Select
                      label="Card condition / grade"
                      options={conditionOptions}
                      value={cardCondition}
                      onChange={setCardCondition}
                    />
                  )}

                  {/* ── eBay ───────────────────────────────────────────────── */}
                  {priceSource === "ebay" && (
                    <BlockStack gap="400">
                      <Select
                        label="eBay category"
                        options={ebayCategoryOptions}
                        value={ebayCategory}
                        onChange={(v) => { setEbayCategory(v); setEbayConfirmed(false); }}
                      />

                      {isMultiSelect ? (
                        <Banner tone="info" title="Bulk eBay tracking">
                          <p>
                            Each product's Shopify title will be used as its eBay search query.
                            You can refine per-product from the product detail page after linking.
                          </p>
                        </Banner>
                      ) : (
                        <BlockStack gap="300">
                          <Banner tone="info" title="How eBay tracking works">
                            <p>
                              Enter a precise query — we lock it in and run it on every sync.
                              Include set name, card number, and grade/condition.
                            </p>
                          </Banner>

                          <TextField
                            label="eBay search query"
                            value={searchQuery}
                            onChange={(v) => { setSearchQuery(v); setEbayConfirmed(false); }}
                            placeholder='"Charizard Obsidian Flames 199/197 PSA 10" GBP'
                            autoComplete="off"
                            helpText="Include condition/grade, set name, and card number"
                            connectedRight={
                              <Button
                                onClick={handleEbayPreview}
                                loading={isSearching}
                                disabled={!searchQuery.trim()}
                              >
                                Preview
                              </Button>
                            }
                          />

                          {hasEbayError && (
                            <Banner tone="critical" title="eBay search failed">
                              <p>{(actionData as any).error}</p>
                            </Banner>
                          )}

                          {ebayPreviewListings.length > 0 && !ebayConfirmed && (
                            <BlockStack gap="300">
                              <Text variant="bodyMd" fontWeight="semibold" as="p">
                                Top {ebayPreviewListings.length} recent sold listings:
                              </Text>
                              <DataTable
                                columnContentTypes={["text", "text", "text", "text"]}
                                headings={["Title", "Price", "Condition", "Date"]}
                                rows={ebayPreviewListings.map((l) => [
                                  <Text as="span" variant="bodySm" key={l.itemUrl}>
                                    <Link url={l.itemUrl} external>
                                      {l.title.length > 45 ? l.title.slice(0, 45) + "…" : l.title}
                                    </Link>
                                  </Text>,
                                  `£${l.price.toFixed(2)}`,
                                  l.condition,
                                  l.soldDate ? new Date(l.soldDate).toLocaleDateString("en-GB") : "—",
                                ])}
                              />
                              <Banner tone="warning" title="Do these look right?">
                                <p>
                                  If they don't match, refine your query and preview again.
                                </p>
                              </Banner>
                              <InlineStack gap="300">
                                <Button variant="primary" tone="success" onClick={() => setEbayConfirmed(true)}>
                                  ✓ Confirm
                                </Button>
                                <Button onClick={() => { setSearchQuery(""); setEbayConfirmed(false); }}>
                                  Try again
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          )}

                          {ebayPreviewListings.length === 0 &&
                            actionData && "intent" in actionData &&
                            actionData.intent === "ebay_preview" && !hasEbayError && (
                              <Banner tone="warning" title="No results found">
                                <p>
                                  Try broadening the search — remove the condition/grade and search
                                  by card name and set only.
                                </p>
                              </Banner>
                            )}

                          {ebayConfirmed && (
                            <Banner tone="success" title="Search confirmed">
                              <p>
                                <strong>"{searchQuery}"</strong> ·{" "}
                                {EBAY_POKEMON_CATEGORIES.find((c) => c.value === ebayCategory)?.label}
                              </p>
                            </Banner>
                          )}
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}

                  {/* ── TCGPlayer / PriceCharting ───────────────────────────── */}
                  {priceSource !== "ebay" && (
                    <BlockStack gap="300">
                      {isMultiSelect && (
                        <Banner tone="info" title="Linking multiple products">
                          <p>
                            The same card ID will be linked to all {selectedIds.length} selected
                            products — useful for the same card at different conditions.
                          </p>
                        </Banner>
                      )}

                      <TextField
                        label="Search for this card"
                        value={searchQuery}
                        onChange={setSearchQuery}
                        placeholder="e.g. Charizard ex Obsidian Flames"
                        autoComplete="off"
                        connectedRight={
                          <Button onClick={handleSearch} loading={isSearching}>
                            Search
                          </Button>
                        }
                      />

                      {actionData && "error" in actionData && actionData.error && (
                        <Banner tone="critical" title="Search failed">
                          <p>{actionData.error}</p>
                        </Banner>
                      )}

                      {searchResults.length > 0 && (
                        <BlockStack gap="200">
                          <Text variant="bodyMd" as="p">Select the matching result:</Text>
                          <ResourceList
                            resourceName={{ singular: "result", plural: "results" }}
                            items={searchResults}
                            renderItem={(result: any) => (
                              <ResourceItem id={result.id} onClick={() => setSelectedExternal(result)}>
                                <InlineStack align="space-between">
                                  <BlockStack gap="050">
                                    <Text as="span" variant="bodyMd">{result.name}</Text>
                                    {result.extra && (
                                      <Text as="span" variant="bodySm" tone="subdued">{result.extra}</Text>
                                    )}
                                  </BlockStack>
                                  {selectedExternal?.id === result.id && (
                                    <Badge tone="success">Selected ✓</Badge>
                                  )}
                                </InlineStack>
                              </ResourceItem>
                            )}
                          />
                        </BlockStack>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* ── Cost price ─────────────────────────────────────────────── */}
              {configReady && (
                <Card>
                  <BlockStack gap="400">
                    <BlockStack gap="050">
                      <Text variant="headingMd" as="h2">Cost price (optional)</Text>
                      <Text tone="subdued" variant="bodySm" as="p">
                        Used with floor price rules to protect your minimum margin.
                      </Text>
                    </BlockStack>

                    <Checkbox
                      label={
                        isMultiSelect
                          ? "Use each product's Shopify cost price where available"
                          : shopifyCostForSingle
                          ? `Use Shopify cost price (£${shopifyCostForSingle.toFixed(2)})`
                          : "Use Shopify cost price (not set for this product)"
                      }
                      checked={useShopifyCost}
                      onChange={setUseShopifyCost}
                      disabled={!isMultiSelect && !shopifyCostForSingle}
                    />

                    {(!useShopifyCost || isMultiSelect) && (
                      <TextField
                        label={
                          isMultiSelect
                            ? "Fallback cost price (£)"
                            : "Cost price (£)"
                        }
                        type="number"
                        value={costPriceShared}
                        onChange={setCostPriceShared}
                        autoComplete="off"
                        placeholder="e.g. 12.50"
                        prefix="£"
                        helpText={
                          isMultiSelect
                            ? "Applied to products where Shopify cost is not set."
                            : "What you paid — used as the anchor for floor price rules."
                        }
                      />
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* ── Link button ─────────────────────────────────────────────── */}
              {configReady && (
                <InlineStack gap="300">
                  <Button variant="primary" onClick={handleLink} loading={isLinking}>
                    {selectedIds.length > 1
                      ? `Link ${selectedIds.length} products`
                      : "Link product"}
                  </Button>
                  <Button
                    onClick={() => {
                      setSelectedIds([]);
                      setSelectedExternal(null);
                      setEbayConfirmed(false);
                      setSearchQuery("");
                      setCostPriceShared("");
                    }}
                  >
                    Clear selection
                  </Button>
                </InlineStack>
              )}
            </>
          )}
        </BlockStack>

      </InlineGrid>
    </Page>
  );
}
