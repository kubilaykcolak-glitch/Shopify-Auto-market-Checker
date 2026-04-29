import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
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
  Select,
  Badge,
  Banner,
  Checkbox,
  Box,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ── Loader ────────────────────────────────────────────────────────────────────
// Env var presence is checked server-side here and passed as a status object.
// Never access process.env directly in the component — it leaks to the client
// after hydration on some Remix setups.

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    include: { settings: true },
  });

  const envStatus: Record<string, boolean> = {
    EBAY_CLIENT_ID: !!process.env.EBAY_CLIENT_ID,
    EBAY_CLIENT_SECRET: !!process.env.EBAY_CLIENT_SECRET,
    TCGPLAYER_PUBLIC_KEY: !!process.env.TCGPLAYER_PUBLIC_KEY,
    TCGPLAYER_PRIVATE_KEY: !!process.env.TCGPLAYER_PRIVATE_KEY,
    PRICECHARTING_API_KEY: !!process.env.PRICECHARTING_API_KEY,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    USD_TO_GBP_RATE: !!process.env.USD_TO_GBP_RATE,
  };

  return json({ settings: store?.settings, storeId: store?.id, envStatus });
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

// ── Component ─────────────────────────────────────────────────────────────────

const ENV_VAR_INFO: { key: string; desc: string; docsUrl: string }[] = [
  {
    key: "EBAY_CLIENT_ID",
    desc: "eBay Browse API Client ID",
    docsUrl: "https://developer.ebay.com/",
  },
  {
    key: "EBAY_CLIENT_SECRET",
    desc: "eBay Browse API Client Secret (Cert ID)",
    docsUrl: "https://developer.ebay.com/",
  },
  {
    key: "TCGPLAYER_PUBLIC_KEY",
    desc: "TCGPlayer Partner API public key",
    docsUrl: "https://developer.tcgplayer.com/",
  },
  {
    key: "TCGPLAYER_PRIVATE_KEY",
    desc: "TCGPlayer Partner API private key",
    docsUrl: "https://developer.tcgplayer.com/",
  },
  {
    key: "PRICECHARTING_API_KEY",
    desc: "PriceCharting API key",
    docsUrl: "https://www.pricecharting.com/api-documentation",
  },
  {
    key: "RESEND_API_KEY",
    desc: "Resend email API key (for alert emails)",
    docsUrl: "https://resend.com/",
  },
  {
    key: "USD_TO_GBP_RATE",
    desc: "USD to GBP rate for PriceCharting (e.g. 0.79)",
    docsUrl: "",
  },
];

const intervalOptions = [
  { label: "Every 15 minutes", value: "15" },
  { label: "Every 30 minutes (recommended)", value: "30" },
  { label: "Every hour", value: "60" },
  { label: "Every 2 hours", value: "120" },
  { label: "Every 6 hours", value: "360" },
  { label: "Once a day", value: "1440" },
];

export default function SettingsPage() {
  const { settings, envStatus } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [pollInterval, setPollInterval] = useState(
    String(settings?.pollIntervalMinutes ?? "30")
  );
  const [emailAlerts, setEmailAlerts] = useState(settings?.emailAlerts ?? false);
  const [alertEmail, setAlertEmail] = useState(settings?.alertEmail ?? "");
  const [slackWebhook, setSlackWebhook] = useState(settings?.slackWebhookUrl ?? "");

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

  const missingKeys = ENV_VAR_INFO.filter((v) => !envStatus[v.key]);

  return (
    <Page title="Settings" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">

            {missingKeys.length > 0 && (
              <Banner tone="warning" title={`${missingKeys.length} API key(s) not configured`}>
                <p>
                  The following environment variables are not set. Features that rely on them
                  will not work until they are configured on your hosting platform.
                </p>
                <ul>
                  {missingKeys.map((v) => (
                    <li key={v.key}>
                      <strong>{v.key}</strong> — {v.desc}
                      {v.docsUrl && (
                        <> (<a href={v.docsUrl} target="_blank" rel="noreferrer">get it here</a>)</>
                      )}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}

            {/* Sync frequency */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Price Check Frequency</Text>
                <Text tone="subdued" as="p">
                  How often PriceSync checks prices for all tracked products. More frequent
                  checks use more API quota — the default 30 minutes suits most stores.
                </Text>
                <Select
                  label="Check interval"
                  options={intervalOptions}
                  value={pollInterval}
                  onChange={setPollInterval}
                />
              </BlockStack>
            </Card>

            {/* Alerts */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Alerts & Notifications</Text>

                <Checkbox
                  label="Enable email alerts (requires RESEND_API_KEY)"
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
                    helpText="You'll receive an email when an automation rule triggers a significant action."
                  />
                )}

                <TextField
                  label="Slack webhook URL (optional)"
                  value={slackWebhook}
                  onChange={setSlackWebhook}
                  autoComplete="off"
                  helpText="Paste your Slack incoming webhook URL to receive alerts in a channel."
                  placeholder="https://hooks.slack.com/services/..."
                />
              </BlockStack>
            </Card>

            {/* API key status */}
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">API Key Status</Text>
                <Banner tone="info" title="API keys are environment variables">
                  <p>
                    For security, API keys are never stored in the database. Configure them as
                    environment variables on your hosting platform (Fly.io, Railway, etc.).
                  </p>
                </Banner>
                <BlockStack gap="200">
                  {ENV_VAR_INFO.map(({ key, desc }) => (
                    <Box
                      key={key}
                      padding="200"
                      background="bg-surface-secondary"
                      borderRadius="100"
                    >
                      <InlineStack align="space-between">
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {key}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {desc}
                          </Text>
                        </BlockStack>
                        <Badge tone={envStatus[key] ? "success" : "critical"}>
                          {envStatus[key] ? "Set" : "Missing"}
                        </Badge>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <InlineStack>
              <Button variant="primary" onClick={handleSave} loading={isSaving}>
                Save settings
              </Button>
            </InlineStack>

          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}