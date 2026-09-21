import {
  PROPERTY_GROUPS,
  type ExplorerNode,
  type ExplorerProperty,
  type ExplorerPropertyGroup,
  type ExplorerPropertyValue,
} from "@/features/explorer/types";

/**
 * Turning property values into the text the inspector shows. Pure, so the
 * formatting is testable on its own and the inspector stays a view.
 */

/** Decimals kept for a number. Whole numbers are shown without a point. */
const MAX_DECIMALS = 3;

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "∞" : Number.isNaN(value) ? "—" : "-∞";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(MAX_DECIMALS)));
}

/** The value as one line, e.g. `0, 10, 0` or `true`. */
export function formatPropertyValue(value: ExplorerPropertyValue): string {
  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return value.unit === undefined ? formatNumber(value.value) : `${formatNumber(value.value)} ${value.unit}`;
    case "boolean":
      return value.value ? "true" : "false";
    case "enum":
      return value.value;
    case "vector":
      return value.value.map(formatNumber).join(", ");
    case "unknown":
      return "—";
  }
}

/** A longer description for the row's tooltip, e.g. naming a vector's axes. */
export function describePropertyValue(property: ExplorerProperty): string {
  const { value } = property;
  const formatted = formatPropertyValue(value);

  switch (value.kind) {
    case "vector":
      return value.axes.map((axis, index) => `${axis} ${formatNumber(value.value[index] ?? 0)}`).join("  ");
    case "enum":
      return `${formatted} — one of ${value.options.join(", ")}`;
    case "unknown":
      return "The provider does not report this value.";
    default:
      return formatted;
  }
}

export interface PropertyGroupView {
  readonly group: ExplorerPropertyGroup;
  readonly properties: readonly ExplorerProperty[];
}

/**
 * The object's properties in group order, skipping groups it has none of.
 * Properties keep the order the provider listed them in.
 */
export function groupProperties(properties: readonly ExplorerProperty[]): readonly PropertyGroupView[] {
  return PROPERTY_GROUPS.map((group) => ({
    group,
    properties: properties.filter((property) => property.group === group),
  })).filter((entry) => entry.properties.length > 0);
}

/** Properties whose group is not one the inspector knows; shown last so nothing is hidden. */
export function ungroupedProperties(properties: readonly ExplorerProperty[]): readonly ExplorerProperty[] {
  const known: ReadonlySet<string> = new Set(PROPERTY_GROUPS);
  return properties.filter((property) => !known.has(property.group));
}

/** `Camera · 5 properties`, for the inspector header's summary line. */
export function summarizeNode(node: ExplorerNode): string {
  const count = node.properties.length;
  const children = node.childIds.length;
  const parts = [node.className, `${count} ${count === 1 ? "property" : "properties"}`];
  if (children > 0) parts.push(`${children} ${children === 1 ? "child" : "children"}`);
  return parts.join(" · ");
}
