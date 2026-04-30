/**
 * eBay category constants — shared between client and server.
 * Keep this file free of any server-only imports.
 */

export const EBAY_POKEMON_CATEGORIES = [
  { label: "Individual Cards", value: "183454" },
  { label: "Graded Cards (PSA / BGS / CGC)", value: "261328" },
  { label: "Sealed Booster Packs", value: "183456" },
  { label: "Sealed Boxes & Sets", value: "183455" },
  { label: "Lots & Collections", value: "197" },
] as const;

export type EbayCategoryId = (typeof EBAY_POKEMON_CATEGORIES)[number]["value"];
