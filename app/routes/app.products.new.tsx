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
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
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
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { searchTCGPlayerProduct } from "../lib/tcgplayer.server";
import { previewEbaySoldListings, EBAY_POKEMON_CATEGORIES } from "../lib/ebay.server";
import { searchPriceChartingProducts } from "../lib/pricecharting.server";
import type { EbaySoldListing } from "../lib/ebay.server";

// ── Loader: fetch Shopify products ──────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(`
    query {
      products(first: 50) {
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
  | { intent: "link_success"; error: null }
  | { error: string };

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // ── Search TCGPlayer / PriceCharting ──────────────────────────────────────
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

  // ── eBay: preview sold listings for confirmation ──────────────────────────
  if (intent === "preview_ebay") {
    const query = formData.get("query") as string;
    const categoryId = formData.get("categoryId") as string;

    try {
      const listings = await previewEbaySoldListings(query, categoryId, 5);
      return json<ActionResult>({ intent: "ebay_preview", listings, error: null });
    } catch (error: any) {
      return json<ActionResult>({
        intent: "ebay_preview",
        listings: [],
        error: error.message,
      });
    }
  }

  // ── Save the product link ─────────────────────────────────────────────────
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
    const cardSet = (formData.get("cardSet") as string) || "";
    const cardNumber = (formData.get("cardNumber") as string) || "";

    // eBay-specific fields
    const ebaySearchQuery = (formData.get("ebaySearchQuery") as string) || null;
    const ebayCategoryId = (formData.get("ebayCategoryId") as string) || null;

    // Cost price
    const costPriceRaw = formData.get("costPrice") as string;
    const costPrice = costPriceRaw ? parseFloat(costPriceRaw) : null;
    const costPriceSource = (formData.get("costPriceSource") as string) || null;

    await prisma.trackedProduct.upsert({
      where: { storeId_shopifyVariantId: { storeId: store.id, shopifyVariantId } },
      update: {
        priceSource,
        externalId,
        externalName,
        cardCondition,
        isSealed,
        cardSet,
        cardNumber,
        ebaySearchQuery,
        ebayCategoryId,
        costPrice,
        costPriceSource,
      },
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
        cardSet,
        cardNumber,
        ebaySearchQuery,
        ebayCategoryId,
        costPrice,
        costPriceSource,
        baselinePrice: shopifyCurrentPrice,
      },
    });

    return json<ActionResult>({ intent: "link_success", error: null });
  }

  return json<ActionResult>({ error: "Unknown intent" });
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function NewProduct() {
  const { shopifyProducts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  // Product selection
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [selectedVariant, setSelectedVariant] = useState<any>(null);

  // Price source config
  const [priceSource, setPriceSource] = useState("tcgplayer");
  const [searchQuery, setSearchQuery] = useState("");
  const [cardCondition, setCardCondition] = useState("near_mint");
  const [isSealed, setIsSealed] = useState(false);
  const [selectedExternal, setSelectedExternal] = useState<any>(null);

  // eBay-specific
  const [ebayCategory, setEbayCategory] = useState("183454");
  const [ebayConfirmed, setEbayConfirmed] = useState(false);

  // Cost price
  const [costPriceValue, setCostPriceValue] = useState("");
  const [costPriceSource, setCostPriceSourceState] = useState<"shopify" | "manual" | "">("");

  const isSearching =
    navigation.state === "submitting" &&
    (navigation.formData?.get("intent") === "search_price_source" ||
      navigation.formData?.get("intent") === "preview_ebay");
  const isLinking =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "link_product";

  const searchResults =
    actionData && "intent" in actionData && actionData.intent === "search_results"
      ? actionData.results
      : [];

  const ebayPreviewListings: EbaySoldListing[] =
    actionData && "intent" in actionData && actionData.intent === "ebay_preview"
      ? actionData.listings
      : [];

  const hasEbayError =
    actionData && "intent" in actionData && actionData.intent === "ebay_preview" && actionData.error;

  function handleSelectProduct(product: any) {
    const variant = product.variants.edges[0]?.node;
    setSelectedProduct(product);
    setSelectedVariant(variant);
    setSelectedExternal(null);
    setEbayConfirmed(false);
    setCostPriceValue("");
    setCostPriceSourceState("");

    // Pre-fill cost price from Shopify if available
    const shopifyCost = variant?.inventoryItem?.unitCost?.amount;
    if (shopifyCost && parseFloat(shopifyCost) > 0) {
      setCostPriceValue(parseFloat(shopifyCost).toFixed(2));
      setCostPriceSourceState("shopify");
    }
  }

  function handleSearch() {
    submit(
      { intent: "search_price_source", query: searchQuery, source: priceSource },
      { method: "POST" }
    );
  }

  function handleEbayPreview() {
    submit(
      { intent: "preview_ebay", query: searchQuery, categoryId: ebayCategory },
      { method: "POST" }
    );
  }

  function handleLink() {
    const isEbay = priceSource === "ebay";
    submit(
      {
        intent: "link_product",
        shopifyProductId: selectedProduct.id,
        shopifyVariantId: selectedVariant.id,
        shopifyProductTitle: selectedProduct.title,
        shopifyCurrentPrice: selectedVariant.price,
        priceSource,
        externalId: isEbay ? "" : (selectedExternal?.id ?? ""),
        externalName: isEbay ? searchQuery : (selectedExternal?.name ?? ""),
        cardCondition,
        isSealed: String(isSealed),
        ebaySearchQuery: isEbay ? searchQuery : "",
        ebayCategoryId: isEbay ? ebayCategory : "",
        costPrice: costPriceValue,
        costPriceSource: costPriceSource || "manual",
      },
      { method: "POST" }
    );
  }

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
    { label: "TCGPlayer (best for individual cards)", value: "tcgplayer" },
    { label: "eBay sold listings (UK market prices)", value: "ebay" },
    { label: "PriceCharting (sealed products & vintage)", value: "pricecharting" },
  ];

  const ebayCategoryOptions = EBAY_POKEMON_CATEGORIES.map((c) => ({
    label: c.label,
    value: c.value,
  }));

  // Determine if the user is ready to link
  const readyToLink =
    selectedProduct &&
    selectedVariant &&
    (priceSource === "ebay" ? ebayConfirmed && searchQuery.trim().length > 0 : !!selectedExternal);

  // ── Success screen ──────────────────────────────────────────────────────────
  if (actionData && "intent" in actionData && actionData.intent === "link_success") {
    return (
      <Page title="Product Linked!" backAction={{ content: "Dashboard", url: "/app" }}>
        <BlockStack gap="400">
          <Banner tone="success" title="Product successfully linked">
            <p>
              The product is now tracked. Prices will sync on the next scheduled check, or
              trigger a manual sync from the dashboard.
            </p>
          </Banner>
          <InlineStack gap="300">
            <Button url="/app/products/new" variant="primary">
              Link another product
            </Button>
            <Button url="/app">Back to dashboard</Button>
          </InlineStack>
        </BlockStack>
      </Page>
    );
  }

  return (
    <Page title="Link New Product" backAction={{ content: "Dashboard", url: "/app" }}>
      <BlockStack gap="500">

        {/* ── Step 1: Select Shopify product ──────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Step 1 — Choose a Shopify product</Text>
            <Text tone="subdued" as="p">
              Select which product in your store you want to link to live pricing data.
            </Text>
            <ResourceList
              resourceName={{ singular: "product", plural: "products" }}
              items={shopifyProducts}
              renderItem={(product) => {
                const variant = product.variants.edges[0]?.node;
                const isSelected = selectedProduct?.id === product.id;
                return (
                  <ResourceItem
                    id={product.id}
                    onClick={() => handleSelectProduct(product)}
                    media={
                      product.featuredImage ? (
                        <Thumbnail
                          source={product.featuredImage.url}
                          alt={product.title}
                          size="small"
                        />
                      ) : (
                        <Thumbnail source="" alt={product.title} size="small" />
                      )
                    }
                  >
                    <InlineStack align="space-between">
                      <BlockStack gap="100">
                        <Text variant="bodyMd" fontWeight="semibold" as="span">
                          {product.title}
                        </Text>
                        <Text variant="bodySm" tone="subdued" as="span">
                          {product.variants.edges.length} variant
                          {product.variants.edges.length !== 1 ? "s" : ""} · £{variant?.price}
                        </Text>
                      </BlockStack>
                      {isSelected && <Badge tone="success">Selected ✓</Badge>}
                    </InlineStack>
                  </ResourceItem>
                );
              }}
            />
          </BlockStack>
        </Card>

        {/* ── Step 2: Configure price source ──────────────────────────────── */}
        {selectedProduct && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Step 2 — Configure price source for: {selectedProduct.title}
              </Text>

              <Select
                label="Price data source"
                options={sourceOptions}
                value={priceSource}
                onChange={(v) => {
                  setPriceSource(v);
                  setSelectedExternal(null);
                  setEbayConfirmed(false);
                }}
              />

              {priceSource !== "ebay" && (
                <Select
                  label="Card condition / grade"
                  options={conditionOptions}
                  value={cardCondition}
                  onChange={setCardCondition}
                />
              )}

              {/* ── TCGPlayer / PriceCharting search ──────────────────────── */}
              {priceSource !== "ebay" && (
                <BlockStack gap="300">
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
                          <ResourceItem
                            id={result.id}
                            onClick={() => setSelectedExternal(result)}
                          >
                            <InlineStack align="space-between">
                              <BlockStack gap="050">
                                <Text as="span" variant="bodyMd">{result.name}</Text>
                                {result.extra && (
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {result.extra}
                                  </Text>
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

              {/* ── eBay search + confirmation ─────────────────────────────── */}
              {priceSource === "ebay" && (
                <BlockStack gap="400">
                  <Banner tone="info" title="How eBay tracking works">
                    <p>
                      Enter a precise search query — the same one you'd type on eBay to find this
                      item. We'll lock this query in and run it on every sync so results stay
                      consistent. Be specific: include set name, card number, and grade/condition.
                    </p>
                  </Banner>

                  <Select
                    label="eBay category"
                    options={ebayCategoryOptions}
                    value={ebayCategory}
                    onChange={(v) => {
                      setEbayCategory(v);
                      setEbayConfirmed(false);
                    }}
                  />

                  <TextField
                    label="eBay search query"
                    value={searchQuery}
                    onChange={(v) => {
                      setSearchQuery(v);
                      setEbayConfirmed(false);
                    }}
                    placeholder='e.g. "Charizard Obsidian Flames 199/197 PSA 10" GBP'
                    autoComplete="off"
                    helpText="Tip: include condition/grade, set name, and card number for accurate results"
                    connectedRight={
                      <Button
                        onClick={handleEbayPreview}
                        loading={isSearching}
                        disabled={!searchQuery.trim()}
                      >
                        Preview results
                      </Button>
                    }
                  />

                  {hasEbayError && (
                    <Banner tone="critical" title="eBay search failed">
                      <p>{(actionData as any).error}</p>
                    </Banner>
                  )}

                  {/* eBay confirmation table */}
                  {ebayPreviewListings.length > 0 && !ebayConfirmed && (
                    <BlockStack gap="300">
                      <Text variant="bodyMd" fontWeight="semibold" as="p">
                        Top {ebayPreviewListings.length} recent sold listings for this query:
                      </Text>
                      <DataTable
                        columnContentTypes={["text", "text", "text", "text"]}
                        headings={["Title", "Sold Price", "Condition", "Sold Date"]}
                        rows={ebayPreviewListings.map((l) => [
                          <Text as="span" variant="bodySm" key={l.itemUrl}>
                            <Link url={l.itemUrl} external>
                              {l.title.length > 60 ? l.title.slice(0, 60) + "…" : l.title}
                            </Link>
                          </Text>,
                          `£${l.price.toFixed(2)}`,
                          l.condition,
                          l.soldDate
                            ? new Date(l.soldDate).toLocaleDateString("en-GB")
                            : "—",
                        ])}
                      />
                      <Banner tone="warning" title="Do these results look right?">
                        <p>
                          Check that the listings above match the card you're tracking. If they
                          don't, refine your search query and preview again.
                        </p>
                      </Banner>
                      <InlineStack gap="300">
                        <Button
                          variant="primary"
                          tone="success"
                          onClick={() => setEbayConfirmed(true)}
                        >
                          ✓ Looks right — confirm this search
                        </Button>
                        <Button
                          onClick={() => {
                            setSearchQuery("");
                            setEbayConfirmed(false);
                          }}
                        >
                          Try a different query
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )}

                  {ebayPreviewListings.length === 0 &&
                    actionData &&
                    "intent" in actionData &&
                    actionData.intent === "ebay_preview" &&
                    !hasEbayError && (
                      <Banner tone="warning" title="No results found">
                        <p>
                          No sold listings matched this query on eBay. Try broadening the search —
                          remove the condition/grade and try just the card name and set.
                        </p>
                      </Banner>
                    )}

                  {ebayConfirmed && (
                    <Banner tone="success" title="eBay search confirmed">
                      <p>
                        Query locked in: <strong>"{searchQuery}"</strong> in category{" "}
                        <strong>
                          {EBAY_POKEMON_CATEGORIES.find((c) => c.value === ebayCategory)?.label}
                        </strong>
                        . This exact search will be used on every sync.
                      </p>
                    </Banner>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        )}

        {/* ── Step 3: Cost price ───────────────────────────────────────────── */}
        {selectedProduct && (priceSource === "ebay" ? ebayConfirmed : !!selectedExternal) && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">Step 3 — Set cost price (optional)</Text>
              <Text tone="subdued" as="p">
                Your cost price is used to protect you from selling below a minimum margin when
                the "price floor" automation rule is active. Leave blank if you don't use floor
                rules.
              </Text>

              {costPriceSource === "shopify" && (
                <Banner tone="info" title="Cost price from Shopify">
                  <p>
                    We pre-filled this from the cost you entered in Shopify for this variant. You
                    can edit it below.
                  </p>
                </Banner>
              )}

              <TextField
                label="Your cost price (£)"
                type="number"
                value={costPriceValue}
                onChange={(v) => {
                  setCostPriceValue(v);
                  setCostPriceSourceState("manual");
                }}
                autoComplete="off"
                placeholder="e.g. 12.50"
                prefix="£"
                helpText="What you paid for this item. Used as the anchor for floor price rules."
              />
            </BlockStack>
          </Card>
        )}

        {/* ── Link button ──────────────────────────────────────────────────── */}
        {readyToLink && (
          <InlineStack gap="300">
            <Button variant="primary" onClick={handleLink} loading={isLinking}>
              Link product
            </Button>
            <Button
              onClick={() => {
                setSelectedProduct(null);
                setSelectedExternal(null);
                setEbayConfirmed(false);
                setCostPriceValue("");
              }}
            >
              Start over
            </Button>
          </InlineStack>
        )}

      </BlockStack>
    </Page>
  );
}