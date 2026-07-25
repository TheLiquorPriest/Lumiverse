import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registry } from "../macros";
import { macrosRoutes } from "./macros.routes";

// The catalog handler reads only the macro registry (macros.routes.ts calls
// initMacros() at import), so no database or session is required here.
const app = new Hono().route("/macros", macrosRoutes);

interface CatalogEntry {
  name: string;
  syntax: string;
  description: string;
  args?: { name: string; optional: boolean }[];
  returns?: string;
  category?: string;
}
interface Catalog {
  categories: { category: string; macros: CatalogEntry[] }[];
}

const EXTENSION_CATEGORY = "extension:catalog_scope_test";
const EXTENSION_MACRO = "catalog_scope_test_macro";

async function catalog(query = ""): Promise<Catalog> {
  const res = await app.request(`/macros${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Catalog;
}

function macroNames(result: Catalog): string[] {
  return result.categories.flatMap((group) => group.macros.map((macro) => macro.name));
}

/** Register a macro the way WorkerHost registers an extension macro: no `builtIn`. */
function registerExtensionMacro(): void {
  registry.registerMacro({
    name: EXTENSION_MACRO,
    category: EXTENSION_CATEGORY,
    description: "Registered by a test standing in for an extension",
    handler: () => "",
  });
}

afterEach(() => {
  registry.unregisterMacro(EXTENSION_MACRO);
});

describe("GET /macros catalog scope", () => {
  test("returns every registration by default", async () => {
    registerExtensionMacro();
    const result = await catalog();
    const names = macroNames(result);

    expect(names).toContain("user");
    expect(names).toContain(EXTENSION_MACRO);
    expect(result.categories.some((group) => group.category === EXTENSION_CATEGORY)).toBe(true);
  });

  test("treats scope=all as the default", async () => {
    registerExtensionMacro();
    const [defaulted, explicit] = await Promise.all([catalog(), catalog("?scope=all")]);

    expect(explicit).toEqual(defaulted);
  });

  test("scope=core keeps built-ins and drops extension registrations", async () => {
    registerExtensionMacro();
    const core = await catalog("?scope=core");
    const names = macroNames(core);

    expect(names).toContain("user");
    expect(names).not.toContain(EXTENSION_MACRO);
    // A category emptied by the filter must be omitted, not returned blank.
    expect(core.categories.some((group) => group.category === EXTENSION_CATEGORY)).toBe(false);
    expect(core.categories.every((group) => group.macros.length > 0)).toBe(true);
  });

  test("preserves the catalog entry shape under every scope", async () => {
    const core = await catalog("?scope=core");
    const entry = core.categories
      .flatMap((group) => group.macros)
      .find((macro) => macro.name === "random");

    expect(entry).toBeDefined();
    expect(entry!.syntax.startsWith("{{random")).toBe(true);
    expect(typeof entry!.description).toBe("string");
    expect(entry!.category).toBe("Random");
  });

  test("rejects an unknown scope", async () => {
    const res = await app.request("/macros?scope=everything");

    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    if (!body || typeof body !== "object" || !("error" in body)) {
      throw new Error("expected an error body");
    }
    expect(String(body.error)).toContain("scope");
  });
});
