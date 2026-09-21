/**
 * The developer Explorer model.
 *
 * The Explorer shows an object hierarchy a developer is working against. It is
 * deliberately separate from the script workspace: scripts are documents Nova
 * owns and persists, Explorer objects are data read from an
 * {@link ExplorerProvider} and never written to disk.
 *
 * The provider shipped today is a local mock: it makes up a small, deterministic
 * hierarchy inside Nova. Nothing here reads another process, and no property in
 * this model describes one — there are no handles, addresses, module lists or
 * process ids, and there never will be.
 */

/** Groups the Property Inspector renders, in this order. */
export const PROPERTY_GROUPS = ["Identity", "Transform", "Appearance", "State", "Data"] as const;

export type ExplorerPropertyGroup = (typeof PROPERTY_GROUPS)[number];

/**
 * A typed property value. The kind decides how the inspector formats it, so no
 * caller has to guess from the JavaScript type.
 */
export type ExplorerPropertyValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number; readonly unit?: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "enum"; readonly value: string; readonly options: readonly string[] }
  /** Vector-like value, e.g. a position. `axes` labels the components. */
  | { readonly kind: "vector"; readonly value: readonly number[]; readonly axes: readonly string[] }
  /** A value the provider knows exists but cannot report. */
  | { readonly kind: "unknown" };

export interface ExplorerProperty {
  /** Stable within its node. */
  readonly id: string;
  readonly name: string;
  readonly group: ExplorerPropertyGroup;
  readonly value: ExplorerPropertyValue;
  /**
   * Whether the value may be edited. Every property of the mock provider is
   * read-only: Nova has nothing to write a change to, and offering an editor
   * that only changed a local copy would suggest otherwise.
   */
  readonly readOnly: boolean;
  /** One short sentence, shown as the row's tooltip. */
  readonly description?: string;
}

/** One object as a provider reports it. Flat: the parent link builds the tree. */
export interface ExplorerNodeData {
  /** Stable identity. Never derived from the name, which is not unique. */
  readonly id: string;
  readonly name: string;
  /** Class or type, e.g. "Camera". Free-form: the icon lookup falls back for unknown classes. */
  readonly className: string;
  /** Containing object, or null for a root. */
  readonly parentId: string | null;
  readonly properties?: readonly ExplorerProperty[];
  /** Extra provider facts shown in the inspector's footer, e.g. where the data came from. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A node as the model holds it: the provider's data plus its resolved place in the tree. */
export interface ExplorerNode extends ExplorerNodeData {
  /** Children in provider order. */
  readonly childIds: readonly string[];
  /** 0 for a root. */
  readonly depth: number;
  readonly properties: readonly ExplorerProperty[];
}

/**
 * The resolved hierarchy. Built once per provider read; selecting or expanding
 * never rebuilds it.
 */
export interface ExplorerModel {
  readonly nodes: ReadonlyMap<string, ExplorerNode>;
  /** Top-level objects, in provider order. */
  readonly rootIds: readonly string[];
  /** Total objects in the model. */
  readonly count: number;
  /** What the model had to repair while building, e.g. a parent that does not exist. */
  readonly issues: readonly ExplorerModelIssue[];
}

export type ExplorerModelIssue =
  /** Two objects reported the same id; the later one was dropped. */
  | { readonly kind: "duplicate-id"; readonly id: string }
  /** The parent does not exist, so the object was placed at the root. */
  | { readonly kind: "missing-parent"; readonly id: string; readonly parentId: string }
  /** Following the parents led back to the object, so the loop was broken at it. */
  | { readonly kind: "parent-cycle"; readonly id: string };

/** A node and its children, ready to render. */
export interface ExplorerTreeNode {
  readonly node: ExplorerNode;
  readonly children: readonly ExplorerTreeNode[];
  /** The node's own name matched the active query. False when nothing is being searched. */
  readonly matched: boolean;
}

export interface ExplorerTree {
  readonly roots: readonly ExplorerTreeNode[];
}

/** Provider metadata the UI may show. Kept apart from the provider itself, which the UI never holds. */
export interface ExplorerProviderInfo {
  readonly label: string;
  readonly providerType: string;
  /** True while the provider makes its data up rather than reading it from somewhere. */
  readonly mock: boolean;
  /** One sentence the UI shows wherever the data is presented. */
  readonly description: string;
}

/**
 * Where Explorer data comes from. The controller owns the model, the selection,
 * expansion and reporting; a provider only supplies objects and says when they
 * changed.
 *
 * Replacing the mock means writing one of these and naming it in
 * `app/services.tsx`: no model, hook, view or test has to change.
 */
export interface ExplorerProvider extends ExplorerProviderInfo {
  /** Reads the whole hierarchy. Called once at startup and again on reload. */
  read: () => readonly ExplorerNodeData[];
  /** Structure changes the provider notices by itself. */
  subscribe: (listener: () => void) => () => void;
}

export interface ExplorerSnapshot {
  readonly model: ExplorerModel;
  /** The selected object, or null. Always an id the model still holds. */
  readonly selectedId: string | null;
  /** Objects whose children are shown. */
  readonly expandedIds: ReadonlySet<string>;
}
