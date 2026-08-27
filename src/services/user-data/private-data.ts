// Plaintext credentials from legacy settings must never cross the portable
// archive boundary. Modern credentials travel only through the encrypted
// decryption-ticket workflow.

const LEGACY_IMAGE_PROVIDER_KEYS: Readonly<Record<string, true>> = {
  nanogpt: true,
  novelai: true,
};
const MAX_PRIVATE_DATA_DEPTH = 128;

function scrubLegacyProviderSecrets(
  value: unknown,
  providerBlock: boolean,
  depth: number,
): unknown {
  if (depth > MAX_PRIVATE_DATA_DEPTH) {
    throw new Error("imageGeneration settings exceed the portable privacy depth limit");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubLegacyProviderSecrets(entry, providerBlock, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("imageGeneration settings contain a non-JSON value");
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (providerBlock && key === "apiKey") continue;
    out[key] = scrubLegacyProviderSecrets(
      entry,
      LEGACY_IMAGE_PROVIDER_KEYS[key] === true,
      depth + 1,
    );
  }
  return out;
}

/**
 * Remove supported legacy plaintext credentials from an imageGeneration
 * settings row. Malformed containers fail closed so export/import remains an
 * all-or-nothing operation rather than passing through an uninspected value.
 */
export function scrubLegacyImageGenerationSettingRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (row.key !== "imageGeneration") return row;
  if (typeof row.value !== "string") {
    throw new Error("imageGeneration settings value must be JSON text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    throw new Error("imageGeneration settings value is malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("imageGeneration settings value must be a JSON object");
  }

  return {
    ...row,
    value: JSON.stringify(scrubLegacyProviderSecrets(parsed, false, 0)),
  };
}
