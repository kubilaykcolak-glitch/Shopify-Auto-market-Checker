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
  Box,
} from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    include: { rules: { orderBy: { createdAt: "asc" } } },
  });

  return json({ rules: store?.rules ?? [], storeId: store?.id });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const store = await prisma.store.findUnique({ where: { shop: session.shop } });
  if (!store) return json({ error: "Store not found" });

  if (intent === "create_rule") {
    const thresholdRaw = formData.get("thresholdPct") as string;
    const actionValueRaw = formData.get("actionValue") as string;
    await prisma.automationRule.create({
      data: {
        storeId: store.id,
        name: formData.get("name") as string,
        description: formData.get("description") as string,
        ruleType: formData.get("ruleType") as string,
        action: formData.get("action") as string,
        thresholdPct: thresholdRaw ? parseFloat(thresholdRaw) : null,
        actionValue: actionValueRaw ? parseFloat(actionValueRaw) : null,
        isEnabled: true,
      },
    });
    return json({ success: true });
  }

  if (intent === "toggle_rule") {
    const ruleId = formData.get("ruleId") as string;
    const isEnabled = formData.get("isEnabled") === "true";
    await prisma.automationRule.update({
      where: { id: ruleId },
      data: { isEnabled: !isEnabled },
    });
    return json({ success: true });
  }

  if (intent === "delete_rule") {
    const ruleId = formData.get("ruleId") as string;
    await prisma.automationRule.delete({ where: { id: ruleId } });
    return json({ success: true });
  }

  return json({ error: "Unknown intent" });
}

const RULE_PRESETS = [
  {
    name: "Auto-update price on rise",
    description: "When market price rises, update Shopify price to match",
    ruleType: "price_rise",
    action: "update_price",
    thresholdPct: 5,
    actionValue: null,
  },
  {
    name: "Disable product on price crash",
    description: "If price drops significantly, mark product out of stock for manual review",
    ruleType: "price_drop",
    action: "disable_product",
    thresholdPct: 20,
    actionValue: null,
  },
  {
    name: "Update price on any drop",
    description: "When market price drops, automatically lower your Shopify price",
    ruleType: "price_drop",
    action: "update_price",
    thresholdPct: 5,
    actionValue: null,
  },
  {
    name: "Alert on large swings",
    description: "Send a notification when price moves significantly either way",
    ruleType: "notify",
    action: "notify_only",
    thresholdPct: 15,
    actionValue: null,
  },
  {
    name: "Price floor protection",
    description:
      "Never set price below cost + margin %. Requires cost price to be set on each product.",
    ruleType: "price_floor",
    action: "floor_price",
    thresholdPct: null,
    actionValue: 10,
  },
  {
    name: "Set out of stock when below floor",
    description:
      "If market price drops below cost + margin %, pull the product from sale entirely instead of forcing the floor price.",
    ruleType: "price_floor",
    action: "disable_product",
    thresholdPct: null,
    actionValue: 10,
  },
] as const;

const ruleTypeOptions = [
  { label: "Price rise (market goes up)", value: "price_rise" },
  { label: "Price drop (market goes down)", value: "price_drop" },
  { label: "Price floor (minimum price protection)", value: "price_floor" },
  { label: "Notify only (no price change)", value: "notify" },
];

const actionOptions: Record<string, { label: string; value: string }[]> = {
  price_rise: [
    { label: "Update Shopify price to match market", value: "update_price" },
    { label: "Notify only", value: "notify_only" },
  ],
  price_drop: [
    { label: "Update Shopify price to match market", value: "update_price" },
    { label: "Disable product (set out of stock)", value: "disable_product" },
    { label: "Notify only", value: "notify_only" },
  ],
  price_floor: [
    { label: "Apply floor price (cost + margin)", value: "floor_price" },
    { label: "Set out of stock (pull from sale below floor)", value: "disable_product" },
  ],
  notify: [{ label: "Notify only (no price change)", value: "notify_only" }],
};

const badgeTone: Record<string, "success" | "critical" | "warning" | "info"> = {
  price_rise: "success",
  price_drop: "critical",
  price_floor: "warning",
  notify: "info",
};

export default function RulesPage() {
  const { rules } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [showNewRule, setShowNewRule] = useState(false);
  const [newRule, setNewRule] = useState({
    name: "",
    description: "",
    ruleType: "price_rise",
    action: "update_price",
    thresholdPct: "5",
    actionValue: "10",
  });

  function applyPreset(preset: (typeof RULE_PRESETS)[number]) {
    setNewRule({
      name: preset.name,
      description: preset.description ?? "",
      ruleType: preset.ruleType,
      action: preset.action,
      thresholdPct: preset.thresholdPct != null ? String(preset.thresholdPct) : "",
      actionValue: preset.actionValue != null ? String(preset.actionValue) : "",
    });
    setShowNewRule(true);
  }

  function handleSaveRule() {
    submit({ intent: "create_rule", ...newRule }, { method: "POST" });
    setShowNewRule(false);
    setNewRule({
      name: "",
      description: "",
      ruleType: "price_rise",
      action: "update_price",
      thresholdPct: "5",
      actionValue: "10",
    });
  }

  function handleToggle(rule: (typeof rules)[number]) {
    submit(
      { intent: "toggle_rule", ruleId: rule.id, isEnabled: String(rule.isEnabled) },
      { method: "POST" }
    );
  }

  function handleDelete(ruleId: string) {
    if (confirm("Delete this rule?")) {
      submit({ intent: "delete_rule", ruleId }, { method: "POST" });
    }
  }

  return (
    <Page title="Automation Rules" backAction={{ content: "Dashboard", url: "/app" }}>
      <BlockStack gap="500">

        <Banner tone="info" title="How rules work">
          <p>
            Rules are evaluated on every price check in this order: floor protection first, then
            price drops, then price rises, then notify-only rules. The first rule that takes
            action wins — remaining rules are skipped.
          </p>
        </Banner>

        {/* Existing rules */}
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text variant="headingMd" as="h2">
                Active Rules ({rules.length})
              </Text>
              <Button variant="primary" onClick={() => setShowNewRule(true)}>
                Add rule
              </Button>
            </InlineStack>

            {rules.length === 0 && (
              <Text tone="subdued" as="p">
                No rules yet. Add one using the button above or pick a preset below.
              </Text>
            )}

            {rules.map((rule) => (
              <Box
                key={rule.id}
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <InlineStack align="space-between" blockAlign="start">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text variant="bodyMd" fontWeight="semibold" as="span">
                        {rule.name}
                      </Text>
                      <Badge tone={badgeTone[rule.ruleType] ?? "info"}>
                        {rule.ruleType.replace(/_/g, " ")}
                      </Badge>
                      {!rule.isEnabled && <Badge tone="critical">Disabled</Badge>}
                    </InlineStack>
                    {rule.description && (
                      <Text variant="bodySm" tone="subdued" as="p">
                        {rule.description}
                      </Text>
                    )}
                    <Text variant="bodySm" as="p">
                      Threshold:{" "}
                      {rule.thresholdPct != null ? `${rule.thresholdPct}%` : "—"} · Action:{" "}
                      {rule.action.replace(/_/g, " ")}
                      {rule.actionValue != null ? ` (${rule.actionValue}%)` : ""}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    <Button
                      size="slim"
                      onClick={() => handleToggle(rule)}
                      variant={rule.isEnabled ? "secondary" : "primary"}
                    >
                      {rule.isEnabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="slim"
                      tone="critical"
                      onClick={() => handleDelete(rule.id)}
                    >
                      Delete
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        </Card>

        {/* New rule form */}
        {showNewRule && (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">New Rule</Text>

              <TextField
                label="Rule name"
                value={newRule.name}
                onChange={(v) => setNewRule({ ...newRule, name: v })}
                autoComplete="off"
              />
              <TextField
                label="Description (optional)"
                value={newRule.description}
                onChange={(v) => setNewRule({ ...newRule, description: v })}
                autoComplete="off"
              />

              <Select
                label="When does this rule trigger?"
                options={ruleTypeOptions}
                value={newRule.ruleType}
                onChange={(v) =>
                  setNewRule({ ...newRule, ruleType: v, action: actionOptions[v][0].value })
                }
              />

              {newRule.ruleType !== "price_floor" && (
                <TextField
                  label="Threshold (%)"
                  type="number"
                  value={newRule.thresholdPct}
                  onChange={(v) => setNewRule({ ...newRule, thresholdPct: v })}
                  autoComplete="off"
                  helpText="e.g. 5 = trigger when price changes by 5% or more"
                  suffix="%"
                />
              )}

              <Select
                label="What action should be taken?"
                options={actionOptions[newRule.ruleType] ?? []}
                value={newRule.action}
                onChange={(v) => setNewRule({ ...newRule, action: v })}
              />

              {newRule.ruleType === "price_floor" && (
                <BlockStack gap="200">
                  <TextField
                    label="Minimum margin above cost (%)"
                    type="number"
                    value={newRule.actionValue}
                    onChange={(v) => setNewRule({ ...newRule, actionValue: v })}
                    autoComplete="off"
                    helpText="e.g. 10 = never sell below (cost price + 10%). Cost price must be set on each tracked product."
                    suffix="%"
                  />
                  <Banner tone="warning" title="Cost price required per product">
                    <p>
                      The floor rule only activates for products that have a cost price set.
                      You can set cost prices when linking products or on each product's detail
                      page.
                    </p>
                  </Banner>
                </BlockStack>
              )}

              <InlineStack gap="300">
                <Button
                  variant="primary"
                  onClick={handleSaveRule}
                  disabled={!newRule.name}
                  loading={navigation.state === "submitting"}
                >
                  Save rule
                </Button>
                <Button onClick={() => setShowNewRule(false)}>Cancel</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {/* Presets */}
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">Rule Presets</Text>
            <Text tone="subdued" as="p">
              Click a preset to pre-fill the form above, then customise and save.
            </Text>
            {RULE_PRESETS.map((preset) => (
              <Box
                key={preset.name}
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      {preset.name}
                    </Text>
                    <Text variant="bodySm" tone="subdued" as="p">
                      {preset.description}
                    </Text>
                  </BlockStack>
                  <Button size="slim" onClick={() => applyPreset(preset)}>
                    Use preset
                  </Button>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        </Card>

      </BlockStack>
    </Page>
  );
}