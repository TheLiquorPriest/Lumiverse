import { isExcludedPath, joinComponentRegistryPaths } from './componentRegistryJoin'

/**
 * Dynamic component registry — auto-discovered via import.meta.glob.
 *
 * Globs all *.module.css and *.tsx files under src/components/ (plus App,
 * LandingPage, LoginPage).  Pairs them by path so each entry knows both
 * its stylesheet and its source component file.
 *
 * Zero maintenance: new components are picked up automatically on rebuild.
 */

// ── Glob discovery (lazy — no import cost, just path enumeration) ────
const cssModulePaths = Object.keys(
  import.meta.glob('/src/**/*.module.css', { eager: false }),
)
const tsxPaths = Object.keys(
  import.meta.glob('/src/**/*.tsx', { eager: false }),
)

// ── Build the registry ──────────────────────────────────────────────

export interface CSSModuleEntry {
  /** PascalCase component name derived from file path */
  component: string
  /** Display category derived from directory structure */
  category: string
  /** Path to the .module.css file */
  cssPath: string
  /** Path to the corresponding .tsx file (if found) */
  tsxPath: string | null
}

function buildRegistry(): CSSModuleEntry[] {
  const entries: CSSModuleEntry[] = []

  for (const entry of joinComponentRegistryPaths(cssModulePaths, tsxPaths)) {
    // The browser override registry is CSS-backed: retain TSX-only paths in
    // the canonical join for consumers that need them, but do not expose
    // entries without a stylesheet here.
    if (entry.cssPath === null || isExcludedPath(entry.cssPath)) continue
    entries.push({
      component: entry.component,
      category: entry.category,
      cssPath: entry.cssPath,
      tsxPath: entry.tsxPath,
    })
  }

  // Sort: categories alphabetically, components alphabetically within
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.component.localeCompare(b.component))

  return entries
}

export const CSS_MODULE_REGISTRY: readonly CSSModuleEntry[] = buildRegistry()

/** Generate a CSS selector for targeting a component via data-component. */
export function generateSelector(entry: CSSModuleEntry, part?: string): string {
  const base = `[data-component="${entry.component}"]`
  if (part) return `${base}[data-part="${part}"]`
  return base
}
