import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  validateMetadataConfig,
  type MetadataConfig,
} from "./config.js";

// A minimal MetadataConfig factory so each validation test overrides only what it exercises.
function metaConfig(overrides: Partial<MetadataConfig> = {}): MetadataConfig {
  return {
    enabled: true,
    indexedKeys: [],
    schemaByStrategy: {},
    strictKeys: [],
    defaultRecallFilters: [],
    dropUnindexedFilters: true,
    ...overrides,
  };
}

describe("resolveConfig - metadata parsing (Requirement 11)", () => {
  it("defaults metadata.enabled to false when nothing supplied (11.6)", () => {
    const cfg = resolveConfig({}, {});
    assert.equal(cfg.metadata.enabled, false);
    assert.deepEqual(cfg.metadata.indexedKeys, []);
    assert.deepEqual(cfg.metadata.strictKeys, []);
    assert.deepEqual(cfg.metadata.schemaByStrategy, {});
    assert.deepEqual(cfg.metadata.defaultRecallFilters, []);
    assert.equal(cfg.metadata.dropUnindexedFilters, true);
  });

  it("parses AGENTCORE_METADATA_ENABLED from env (11.2)", () => {
    assert.equal(
      resolveConfig({ AGENTCORE_METADATA_ENABLED: "true" }, {}).metadata.enabled,
      true,
    );
    assert.equal(
      resolveConfig({ AGENTCORE_METADATA_ENABLED: "1" }, {}).metadata.enabled,
      true,
    );
    assert.equal(
      resolveConfig({ AGENTCORE_METADATA_ENABLED: "false" }, {}).metadata.enabled,
      false,
    );
  });

  it("parses AGENTCORE_METADATA_INDEXED_KEYS as key:type pairs (11.3)", () => {
    const cfg = resolveConfig(
      {
        AGENTCORE_METADATA_INDEXED_KEYS:
          "priority:STRING, tags:STRINGLIST, score:NUMBER, department",
      },
      {},
    );
    assert.deepEqual(cfg.metadata.indexedKeys, [
      { key: "priority", type: "STRING" },
      { key: "tags", type: "STRINGLIST" },
      { key: "score", type: "NUMBER" },
      { key: "department", type: "STRING" }, // no :type suffix defaults to STRING
    ]);
  });

  it("lowercase/unknown indexed key types normalize to a valid enum (11.3)", () => {
    const cfg = resolveConfig(
      { AGENTCORE_METADATA_INDEXED_KEYS: "a:string, b:bogus" },
      {},
    );
    assert.deepEqual(cfg.metadata.indexedKeys, [
      { key: "a", type: "STRING" },
      { key: "b", type: "STRING" }, // unknown type falls back to STRING
    ]);
  });

  it("parses AGENTCORE_METADATA_STRICT_KEYS as a comma list (11.4)", () => {
    const cfg = resolveConfig(
      { AGENTCORE_METADATA_STRICT_KEYS: "department, region " },
      {},
    );
    assert.deepEqual(cfg.metadata.strictKeys, ["department", "region"]);
  });

  it("resolves schemaByStrategy and defaultRecallFilters from raw only (11.5)", () => {
    const raw = {
      metadata: {
        schemaByStrategy: {
          SEMANTIC: [{ key: "priority", type: "STRING" }],
        },
        defaultRecallFilters: [{ key: "userId", value: "u1" }],
      },
    };
    // Even with env set for the scalar fields, complex objects come from raw.
    const cfg = resolveConfig({ AGENTCORE_METADATA_ENABLED: "true" }, raw);
    assert.deepEqual(cfg.metadata.schemaByStrategy, {
      SEMANTIC: [{ key: "priority", type: "STRING" }],
    });
    assert.deepEqual(cfg.metadata.defaultRecallFilters, [
      { key: "userId", value: "u1" },
    ]);
  });

  it("reads indexedKeys as objects from raw config when env absent", () => {
    const raw = {
      metadata: {
        indexedKeys: [
          { key: "priority", type: "STRING" },
          { key: "score", type: "NUMBER" },
        ],
      },
    };
    const cfg = resolveConfig({}, raw);
    assert.deepEqual(cfg.metadata.indexedKeys, [
      { key: "priority", type: "STRING" },
      { key: "score", type: "NUMBER" },
    ]);
  });

  it("env indexed keys take precedence over raw", () => {
    const cfg = resolveConfig(
      { AGENTCORE_METADATA_INDEXED_KEYS: "fromEnv:STRING" },
      { metadata: { indexedKeys: [{ key: "fromRaw", type: "NUMBER" }] } },
    );
    assert.deepEqual(cfg.metadata.indexedKeys, [
      { key: "fromEnv", type: "STRING" },
    ]);
  });
});

describe("validateMetadataConfig (Requirement 12)", () => {
  it("returns a result and never throws for malformed input (12.6)", () => {
    // Intentionally pass junk; must not throw.
    const result = validateMetadataConfig(undefined as unknown as MetadataConfig);
    assert.equal(typeof result.valid, "boolean");
    assert.ok(Array.isArray(result.errors));

    const result2 = validateMetadataConfig({} as MetadataConfig);
    assert.equal(typeof result2.valid, "boolean");
    assert.ok(Array.isArray(result2.errors));
  });

  it("accepts a fully-valid config (12.1)", () => {
    const cfg = metaConfig({
      indexedKeys: [
        { key: "priority", type: "STRING" },
        { key: "department", type: "STRING" },
        { key: "score", type: "NUMBER" },
      ],
      strictKeys: ["department"],
      schemaByStrategy: {
        SEMANTIC: [
          {
            key: "department",
            type: "STRING",
            extractionType: "STRICTLY_CONSISTENT",
          },
          { key: "priority", type: "STRING", allowedValues: ["low", "high"] },
        ],
      },
    });
    const result = validateMetadataConfig(cfg);
    assert.equal(result.valid, true, result.errors.join("; "));
    assert.deepEqual(result.errors, []);
  });

  it("rejects more than 10 indexed keys (12.2)", () => {
    const indexedKeys = Array.from({ length: 11 }, (_, i) => ({
      key: `k${i}`,
      type: "STRING" as const,
    }));
    const result = validateMetadataConfig(metaConfig({ indexedKeys }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("maximum of 10")));
  });

  it("rejects a strict key not present in indexedKeys (12.3)", () => {
    const result = validateMetadataConfig(
      metaConfig({
        indexedKeys: [{ key: "priority", type: "STRING" }],
        strictKeys: ["department"],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("not present in indexedKeys")));
  });

  it("rejects a strict key that is not typed STRING (12.3)", () => {
    const result = validateMetadataConfig(
      metaConfig({
        indexedKeys: [{ key: "score", type: "NUMBER" }],
        strictKeys: ["score"],
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("must be of type STRING")));
  });

  it("rejects more than 3 strict keys per strategy (12.4)", () => {
    const result = validateMetadataConfig(
      metaConfig({
        schemaByStrategy: {
          SEMANTIC: [
            { key: "a", type: "STRING", extractionType: "STRICTLY_CONSISTENT" },
            { key: "b", type: "STRING", extractionType: "STRICTLY_CONSISTENT" },
            { key: "c", type: "STRING", extractionType: "STRICTLY_CONSISTENT" },
            { key: "d", type: "STRING", extractionType: "STRICTLY_CONSISTENT" },
          ],
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("more than 3 strict keys")));
  });

  it("rejects strict keys under the SUMMARY strategy (12.4)", () => {
    const result = validateMetadataConfig(
      metaConfig({
        schemaByStrategy: {
          SUMMARY: [
            {
              key: "department",
              type: "STRING",
              extractionType: "STRICTLY_CONSISTENT",
            },
          ],
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("SUMMARY")));
  });

  it("rejects allowedValues with more than 10 entries (12.5)", () => {
    const allowedValues = Array.from({ length: 11 }, (_, i) => `v${i}`);
    const result = validateMetadataConfig(
      metaConfig({
        schemaByStrategy: {
          SEMANTIC: [{ key: "priority", type: "STRING", allowedValues }],
        },
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("allowedValues")));
  });

  it("rejects an indexed key with an invalid character set (12.5)", () => {
    const result = validateMetadataConfig(
      metaConfig({ indexedKeys: [{ key: "bad!key#", type: "STRING" }] }),
    );
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("character set")));
  });
});
