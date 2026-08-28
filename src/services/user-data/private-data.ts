// Plaintext credentials from legacy settings must never cross the portable
// archive boundary. Modern credentials travel only through the encrypted
// decryption-ticket workflow.

export type LegacyImageProvider = "nanogpt" | "novelai";

export interface LegacyImageProviderCredential {
  provider: LegacyImageProvider;
  apiKey: unknown;
  providerSettings: Record<string, unknown>;
}

export interface LegacyImagePrivateDataInspection {
  scrubbedValue: unknown;
  credentials: LegacyImageProviderCredential[];
  changed: boolean;
}

const MAX_PRIVATE_DATA_DEPTH = 128;
const PRIVATE_JSON_MARKER = /\b(?:nanogpt|novelai|apiKey)\b/;

interface ScrubResult {
  value: unknown;
  changed: boolean;
}

function legacyProviderForKey(key: string): LegacyImageProvider | null {
  if (key === "nanogpt" || key === "novelai") return key;
  return null;
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function copyEntriesBefore(
  target: Record<string, unknown>,
  entries: [string, unknown][],
  end: number,
): void {
  for (let index = 0; index < end; index++) {
    const [key, value] = entries[index];
    defineOwn(target, key, value);
  }
}

function looksLikeJsonContainer(value: string): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[";
}

function looksLikeJsonStructure(value: string): boolean {
  const trimmed = value.trimStart();
  const firstValueCharacter = trimmed.slice(1).trimStart()[0];
  if (trimmed[0] === "{") {
    return firstValueCharacter === '"' || firstValueCharacter === "}";
  }
  return trimmed[0] === "["
    && '"{[-0123456789tfn]'.includes(firstValueCharacter);
}

function scrubEncodedProviderContainer(
  value: string,
  provider: LegacyImageProvider | null,
  providerSettings: Record<string, unknown> | null,
  depth: number,
  credentials: LegacyImageProviderCredential[],
): ScrubResult {
  if (!looksLikeJsonContainer(value)) return { value, changed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Decode JSON Unicode escapes only for classification. The content stays
    // opaque, but an attacker cannot hide a truncated provider/apiKey marker
    // from the fail-closed decision with \uXXXX spelling.
    const classified = value.replace(
      /\\u([0-9a-fA-F]{4})/g,
      (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (
      provider !== null
      || PRIVATE_JSON_MARKER.test(classified)
      || looksLikeJsonStructure(value)
    ) {
      throw new Error(
        "imageGeneration settings contain malformed JSON-encoded provider data",
      );
    }
    return { value, changed: false };
  }

  const scrubbed = scrubLegacyProviderSecrets(
    parsed,
    provider,
    providerSettings,
    depth + 1,
    credentials,
  );
  return scrubbed.changed
    ? { value: JSON.stringify(scrubbed.value), changed: true }
    : { value, changed: false };
}

function scrubLegacyProviderSecrets(
  value: unknown,
  provider: LegacyImageProvider | null,
  providerSettings: Record<string, unknown> | null,
  depth: number,
  credentials: LegacyImageProviderCredential[],
): ScrubResult {
  if (depth > MAX_PRIVATE_DATA_DEPTH) {
    throw new Error("imageGeneration settings exceed the portable privacy depth limit");
  }
  if (typeof value === "string") {
    return scrubEncodedProviderContainer(
      value,
      provider,
      providerSettings,
      depth,
      credentials,
    );
  }
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index++) {
      const scrubbed = scrubLegacyProviderSecrets(
        value[index],
        provider,
        providerSettings,
        depth + 1,
        credentials,
      );
      if (scrubbed.changed && out === null) out = value.slice(0, index);
      if (out !== null) out.push(scrubbed.value);
    }
    return out === null
      ? { value, changed: false }
      : { value: out, changed: true };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("imageGeneration settings contain a non-JSON value");
  }

  const objectValue = value as Record<string, unknown>;
  const scopedProviderSettings = provider === null
    ? null
    : providerSettings ?? objectValue;
  const entries = Object.entries(objectValue);
  let out: Record<string, unknown> | null = null;
  for (let index = 0; index < entries.length; index++) {
    const [key, entry] = entries[index];
    if (provider !== null && key === "apiKey") {
      credentials.push({
        provider,
        apiKey: entry,
        providerSettings: scopedProviderSettings ?? objectValue,
      });
      if (out === null) {
        out = Object.create(null) as Record<string, unknown>;
        copyEntriesBefore(out, entries, index);
      }
      continue;
    }

    const nestedProvider = legacyProviderForKey(key);
    const scrubbed = scrubLegacyProviderSecrets(
      entry,
      nestedProvider ?? provider,
      nestedProvider === null ? scopedProviderSettings : null,
      depth + 1,
      credentials,
    );
    if (scrubbed.changed && out === null) {
      out = Object.create(null) as Record<string, unknown>;
      copyEntriesBefore(out, entries, index);
    }
    if (out !== null) defineOwn(out, key, scrubbed.value);
  }
  return out === null
    ? { value, changed: false }
    : { value: out, changed: true };
}

/**
 * Inspect arbitrary imageGeneration JSON with the same recursive privacy
 * rules used at both portable boundaries. The scrubbed value is safe to
 * persist only after every returned credential has been migrated.
 */
export function inspectLegacyImageGenerationPrivateData(
  value: unknown,
): LegacyImagePrivateDataInspection {
  const credentials: LegacyImageProviderCredential[] = [];
  const scrubbed = scrubLegacyProviderSecrets(value, null, null, 0, credentials);
  return {
    scrubbedValue: scrubbed.value,
    credentials,
    changed: scrubbed.changed,
  };
}

/**
 * Remove supported legacy plaintext credentials from an imageGeneration
 * settings row. Malformed containers fail closed so export/import remains an
 * all-or-nothing operation rather than passing through an uninspected value.
 */
export function scrubLegacyImageGenerationSettingRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const rowEntries = Object.entries(row);
  const keyEntry = rowEntries.find(([key]) => key === "key");
  if (keyEntry?.[1] !== "imageGeneration") return row;
  const valueEntry = rowEntries.find(([key]) => key === "value");
  if (typeof valueEntry?.[1] !== "string") {
    throw new Error("imageGeneration settings value must be JSON text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(valueEntry[1]);
  } catch {
    throw new Error("imageGeneration settings value is malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("imageGeneration settings value must be a JSON object");
  }

  const inspection = inspectLegacyImageGenerationPrivateData(parsed);
  if (!inspection.changed) return row;

  // A null-prototype target plus defineProperty is deliberate: assignment to
  // a normal object's `__proto__` invokes its legacy setter and silently
  // drops valid own JSON data. Rebuild only changed rows and retain every own
  // entry, including an exact `__proto__` entry.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of rowEntries) {
    defineOwn(
      out,
      key,
      key === "value" ? JSON.stringify(inspection.scrubbedValue) : entry,
    );
  }
  return out;
}
