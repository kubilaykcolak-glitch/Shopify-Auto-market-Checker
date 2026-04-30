import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  TextField,
  Select,
  Badge,
  Banner,
  Checkbox,
  Box,
  Collapsible,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ── Loader ────────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    include: { settings: true },
  });

  // High-level integration status — what merchants care about
  const integrationStatus = {
    ebay: !!(process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET),
    tcgplayer: !!(process.env.TCGPLAYER_PUBLIC_KEY && process.env.TCGPLAYER_PRIVATE_KEY),
    pricecharting: !!process.env.PRICECHARTING_API_KEY,
    resend: !!process.env.RESEND_API_KEY,
  };

  // Actual conversion rate value for display
  const usdToGbpRate = parseFloat(process.env.USD_TO_GBP_RATE ?? "0.79");

  // Raw env var names — only surfaced in the Developer Settings section
  const advancedEnvStatus: Record<string, boolean> = {
    EBAY_CLIENT_ID: !!process.env.EBAY_CLIENT_ID,
    EBAY_CLIENT_SECRET: !!process.env.EBAY_CLIENT_SECRET,
    TCGPLAYER_PUBLIC_KEY: !!process.env.TCGPLAYER_PUBLIC_KEY,
    TCGPLAYER_PRIVATE_KEY: !!process.env.TCGPLAYER_PRIVATE_KEY,
    PRICECHARTING_API_KEY: !!process.env.PRICECHARTING_API_KEY,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    USD_TO_GBP_RATE: !!process.env.USD_TO_GBP_RATE,
  };

  return json({
    settings: store?.settings,
    storeId: store?.id,
    integrationStatus,
    usdToGbpRate,
    advancedEnvStatus,
  });
}

// ── Action ────────────────────────────────────────────────────────────────────

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const store = await prisma.store.findUnique({ where: { shop: session.shop } });
  if (!store) return json({ error: "Store not found" });

  await prisma.storeSettings.upsert({
    where: { storeId: store.id },
    update: {
      pollIntervalMinutes: parseInt(formData.get("pollIntervalMinutes") as string) || 30,
      emailAlerts: formData.get("emailAlerts") === "true",
      alertEmail: (formData.get("alertEmail") as string) || null,
      slackWebhookUrl: (formData.get("slackWebhookUrl") as string) || null,
    },
    create: {
      storeId: store.id,
      pollIntervalMinutes: parseInt(formData.get("pollIntervalMinutes") as string) || 30,
      emailAlerts: formData.get("emailAlerts") === "true",
      alertEmail: (formData.get("alertEmail") as string) || null,
      slackWebhookUrl: (formData.get("slackWebhookUrl") as string) || null,
    },
  });

  return json({ success: true });
}

// ── Static data ───────────────────────────────────────────────────────────────

const intervalOptions = [
  { label: "Every 15 minutes", value: "15" },
  { label: "Every 30 minutes (recommended)", value: "30" },
  { label: "Every hour", value: "60" },
  { label: "Every 2 hours", value: "120" },
  { label: "Every 6 hours", value: "360" },
  { label: "Once a day", value: "1440" },
];

const ADVANCED_ENV_VARS = [
  { key: "EBAY_CLIENT_ID", label: "eBay Client ID" },
  { key: "EBAY_CLIENT_SECRET", label: "eBay Client Secret" },
  { key: "TCGPLAYER_PUBLIC_KEY", label: "TCGPlayer Public Key" },
  { key: "TCGPLAYER_PRIVATE_KEY", label: "TCGPlayer Private Key" },
  { key: "PRICECHARTING_API_KEY", label: "PriceCharting API Key" },
  { key: "RESEND_API_KEY", label: "Email Service Key" },
  { key: "USD_TO_GBP_RATE", label: "USD → GBP Conversion Rate" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { settings, integrationStatus, usdToGbpRate, advancedEnvStatus } =
    useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [pollInterval, setPollInterval] = useState(
    String(settings?.pollIntervalMinutes ?? "30")
  );
  const [emailAlerts, setEmailAlerts] = useState(settings?.emailAlerts ?? false);
  const [alertEmail, setAlertEmail] = useState(settings?.alertEmail ?? "");
  const [slackWebhook, setSlackWebhook] = useState(settings?.slackWebhookUrl ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);

  function handleSave() {
    submit(
      {
        pollIntervalMinutes: pollInterval,
        emailAlerts: String(emailAlerts),
        alertEmail,
        slackWebhookUrl: slackWebhook,
      },
      { method: "POST" }
    );
  }

  const hasAnyDataSource =
    integrationStatus.ebay || integrationStatus.tcgplayer || integrationStatus.pricecharting;

  const overallStatus = hasAnyDataSource
    ? { tone: "success" as const, label: "Operational" }
    : { tone: "warning" as const, label: "Service unavailable" };

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <BlockStack gap="500">

        {/* ── System Status ──────────────────────────────────────────────────── */}
        <Card>
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text variant="headingMd" as="h2">System Status</Text>
              <Text tone="subdued" variant="bodySm" as="p">
                {hasAnyDataSource
                  ? "Price data services are running normally."
                  : "Price data services are currently unavailable. Please contact support."}
              </Text>
            </BlockStack>
            <Badge tone={overallStatus.tone} size="large">
              {overallStatus.label}
            </Badge>
          </InlineStack>
        </Card>

        {/* ── Alerts & Notifications ──────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Alerts & Notifications</Text>

            {/* Email alerts */}
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      Email Alerts
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="p">
                      {integrationStatus.resend
                        ? "Get notified when automation rules take action"
                        : "Email service not configured — contact your app provider to enable"}
                    </Text>
                  </BlockStack>
                  <Badge
                    tone={
                      !integrationStatus.resend
                        ? "new"
                        : emailAlerts
                        ? "success"
                        : "warning"
                    }
                  >
                    {!integrationStatus.resend
                      ? "Not available"
                      : emailAlerts
                      ? "✓ Enabled"
                      : "Disabled"}
                  </Badge>
                </InlineStack>

                {integrationStatus.resend && (
                  <>
                    <Checkbox
                      label="Enable email alerts"
                      checked={emailAlerts}
                      onChange={setEmailAlerts}
                    />
                    {emailAlerts && (
                      <TextField
                        label="Alert email address"
                        type="email"
                        value={alertEmail}
                        onChange={setAlertEmail}
                        autoComplete="email"
                        helpText="You'll receive an email when a rule changes a price or sets a product out of stock."
                      />
                    )}
                  </>
                )}
              </BlockStack>
            </Box>

            {/* Slack */}
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      Slack Alerts
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="p">
                      Post price change notifications directly to a Slack channel
                    </Text>
                  </BlockStack>
                  <Badge tone={slackWebhook ? "success" : "new"}>
                    {slackWebhook ? "✓ Connected" : "Optional"}
                  </Badge>
                </InlineStack>
                <TextField
                  label="Webhook URL"
                  value={slackWebhook}
                  onChange={setSlackWebhook}
                  autoComplete="off"
                  placeholder="https://hooks.slack.com/services/..."
                  helpText={
                    slackWebhook
                      ? undefined
                      : "From Slack: Apps → Incoming Webhooks → Add to Slack"
                  }
                />
              </BlockStack>
            </Box>
          </BlockStack>
        </Card>

        {/* ── App Settings ───────────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">App Settings</Text>

            <Select
              label="Price check frequency"
              options={intervalOptions}
              value={pollInterval}
              onChange={setPollInterval}
              helpText="How often your tracked products are checked against live market data. More frequent checks consume more API quota."
            />

            {/* Currency — display only */}
            <Box padding="300" background="bg-surface-secondary" borderRadius="200">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text variant="bodyMd" fontWeight="semibold" as="span">
                    Currency Settings
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">
                    PriceCharting data is returned in USD and automatically converted
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text variant="bodySm" fontWeight="semibold" as="span" alignment="end">
                    GBP (£)
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="span" alignment="end">
                    1 USD = £{usdToGbpRate.toFixed(2)}
                  </Text>
                </BlockStack>
              </InlineStack>
            </Box>
          </BlockStack>
        </Card>

        {/* ── Save ───────────────────────────────────────────────────────────── */}
        <InlineStack>
          <Button variant="primary" onClick={handleSave} loading={isSaving}>
            Save settings
          </Button>
        </InlineStack>

        {/* ── Developer Settings ─────────────────────────────────────────────── */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="050">
                <Text variant="headingMd" as="h2">Developer Settings</Text>
                <Text variant="bodySm" tone="subdued" as="p">
                  Technical configuration — for app administrators only
                </Text>
              </BlockStack>
              <Button
                size="slim"
                variant="plain"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? "Hide details" : "Show details"}
              </Button>
            </InlineStack>

            <Collapsible
              open={showAdvanced}
              id="developer-settings"
              transition={{ duration: "200ms", timingFunction: "ease-in-out" }}
            >
              <BlockStack gap="400">
                <Banner tone="info">
                  <p>
                    All API credentials are your developer keys — merchants never need to supply
                    their own. Set them as environment variables on your hosting platform (Fly.io,
                    Railway, etc.) and redeploy to apply changes. They are never stored in the
                    database.
                  </p>
                </Banner>

                <Text variant="bodyMd" fontWeight="semibold" as="p">Price data sources</Text>
                <BlockStack gap="200">
                  {ADVANCED_ENV_VARS.filter(v =>
                    ["EBAY_CLIENT_ID","EBAY_CLIENT_SECRET","TCGPLAYER_PUBLIC_KEY","TCGPLAYER_PRIVATE_KEY","PRICECHARTING_API_KEY"].includes(v.key)
                  ).map(({ key, label }) => (
                    <Box key={key} padding="200" background="bg-surface-secondary" borderRadius="100">
                      <InlineStack align="space-between">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">{label}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">{key}</Text>
                        </BlockStack>
                        <Badge tone={advancedEnvStatus[key] ? "success" : "critical"}>
                          {advancedEnvStatus[key] ? "Set" : "Not set"}
                        </Badge>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>

                <Text variant="bodyMd" fontWeight="semibold" as="p">Other services</Text>
                <BlockStack gap="200">
                  {ADVANCED_ENV_VARS.filter(v =>
                    ["RESEND_API_KEY","USD_TO_GBP_RATE"].includes(v.key)
                  ).map(({ key, label }) => (
                    <Box key={key} padding="200" background="bg-surface-secondary" borderRadius="100">
                      <InlineStack align="space-between">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">{label}</Text>
                          <Text as="span" variant="bodySm" tone="subdued">{key}</Text>
                        </BlockStack>
                        <Badge tone={advancedEnvStatus[key] ? "success" : "critical"}>
                          {advancedEnvStatus[key] ? "Set" : "Not set"}
                        </Badge>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}
