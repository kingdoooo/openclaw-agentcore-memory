import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IndexedKeyConfig, MetadataConfig } from "./config.js";
import {
  ALWAYS_FILTERABLE_KEYS,
  SYSTEM_TIMESTAMP_KEYS,
  MAX_FILTERS,
  coerceValue,
  normalizeOne,
  buildFilters,
  buildRecordMetadata,
  type FilterOperator,
} from "./metadata-filter.js";

// ---------------------------------------------------------------------------
// coerceValue — exhaustive operator → value-variant table (Requirement 7.6, 8.3)
// ---------------------------------------------------------------------------

describe("coerceValue - operator to value variant table", () => {
  it("EQUALS_TO with a string emits stringValue (7.6)", () => {
    assert.deepEqual(coerceValue("EQUALS_TO", "high"), { stringValue: "high" });
  });

  it("EQUALS_TO with a number emits stringValue (stringified)", () => {
    assert.deepEqual(coerceValue("EQUALS_TO", 42), { stringValue: "42" });
  });

  it("CONTAINS with a string emits stringValue (7.6)", () => {
    assert.deepEqual(coerceValue("CONTAINS", "invoice"), {
      stringValue: "invoice",
    });
  });

  it("CONTAINS with a non-string returns null", () => {
    assert.equal(coerceValue("CONTAINS", 3 as unknown as number), null);
    assert.equal(coerceValue("CONTAINS", ["a"] as unknown as string[]), null);
  });

  for (const op of [
    "GREATER_THAN",
    "GREATER_THAN_OR_EQUALS",
    "LESS_THAN",
    "LESS_THAN_OR_EQUALS",
  ] as const) {
    it(`${op} with a number emits numberValue (7.6)`, () => {
      assert.deepEqual(coerceValue(op, 10), { numberValue: 10 });
    });

    it(`${op} with a string returns null (type mismatch)`, () => {
      assert.equal(coerceValue(op, "10"), null);
    });
  }

  it("BEFORE/AFTER with an ISO string normalizes to UTC ISO-8601 (8.3)", () => {
    assert.deepEqual(coerceValue("AFTER", "2026-01-01T00:00:00Z"), {
      dateTimeValue: "2026-01-01T00:00:00.000Z",
    });
    // A non-UTC offset is normalized to UTC.
    assert.deepEqual(coerceValue("BEFORE", "2026-01-01T00:00:00+02:00"), {
      dateTimeValue: "2025-12-31T22:00:00.000Z",
    });
  });

  it("BEFORE/AFTER with a Date normalizes to UTC ISO-8601 (8.3)", () => {
    const d = new Date(Date.UTC(2030, 5, 15, 12, 30, 0));
    assert.deepEqual(coerceValue("AFTER", d), {
      dateTimeValue: "2030-06-15T12:30:00.000Z",
    });
  });

  it("BEFORE/AFTER with an invalid date returns null", () => {
    assert.equal(coerceValue("AFTER", "not-a-date"), null);
    assert.equal(coerceValue("BEFORE", new Date("invalid")), null);
    assert.equal(coerceValue("AFTER", 123 as unknown as number), null);
  });

  it("EXISTS / NOT_EXISTS never coerce a value", () => {
    assert.equal(coerceValue("EXISTS", "x"), null);
    assert.equal(coerceValue("NOT_EXISTS", "x"), null);
  });
});

// ---------------------------------------------------------------------------
// normalizeOne — operator inference, EXISTS handling, every drop reason
// ---------------------------------------------------------------------------

describe("normalizeOne - operator inference (Requirement 7.1)", () => {
  it("infers EXISTS when no operator and no value", () => {
    const r = normalizeOne({ key: "priority" });
    assert.ok(r.ok);
    assert.equal(r.filter.operator, "EXISTS");
    assert.equal(r.filter.right, undefined);
  });

  it("infers EQUALS_TO when a value is present but no operator", () => {
    const r = normalizeOne({ key: "priority", value: "high" });
    assert.ok(r.ok);
    assert.equal(r.filter.operator, "EQUALS_TO");
    assert.deepEqual(r.filter.right, { metadataValue: { stringValue: "high" } });
  });
});

describe("normalizeOne - EXISTS / NOT_EXISTS emit no right (Requirement 7.3)", () => {
  for (const operator of ["EXISTS", "NOT_EXISTS"] as const) {
    it(`${operator} produces a filter without right`, () => {
      const r = normalizeOne({ key: "department", operator });
      assert.ok(r.ok);
      assert.deepEqual(r.filter, {
        left: { metadataKey: "department" },
        operator,
      });
    });
  }
});

describe("normalizeOne - drop reasons (Requirement 7.2, 7.4, 7.5, 7.7, 10.1)", () => {
  it("empty_key when key is empty (7.7)", () => {
    const r = normalizeOne({ key: "" });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "empty_key");
  });

  it("unsupported_operator for an unknown operator (7.2)", () => {
    const r = normalizeOne({ key: "priority", operator: "LIKE", value: "x" });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "unsupported_operator");
  });

  it("missing_value when a value-requiring operator has no value (7.4)", () => {
    const r = normalizeOne({ key: "score", operator: "GREATER_THAN" });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "missing_value");
  });

  it("operator_value_type_mismatch for a string with GREATER_THAN (7.5)", () => {
    const r = normalizeOne({ key: "score", operator: "GREATER_THAN", value: "10" });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "operator_value_type_mismatch");
  });

  it("key_not_indexed when key is unindexed and dropUnindexedFilters=true (10.1)", () => {
    const indexedKeys: IndexedKeyConfig[] = [{ key: "priority", type: "STRING" }];
    const r = normalizeOne(
      { key: "unknownKey", value: "x" },
      { indexedKeys, dropUnindexedFilters: true },
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "key_not_indexed");
  });

  it("passes an unindexed key through when dropUnindexedFilters=false (10.2)", () => {
    const indexedKeys: IndexedKeyConfig[] = [{ key: "priority", type: "STRING" }];
    const r = normalizeOne(
      { key: "unknownKey", value: "x" },
      { indexedKeys, dropUnindexedFilters: false },
    );
    assert.ok(r.ok);
    assert.equal(r.filter.left.metadataKey, "unknownKey");
  });

  it("always allows system timestamp keys regardless of indexedKeys (8.4)", () => {
    const indexedKeys: IndexedKeyConfig[] = [{ key: "priority", type: "STRING" }];
    for (const key of ALWAYS_FILTERABLE_KEYS) {
      const r = normalizeOne(
        { key, operator: "EXISTS" },
        { indexedKeys, dropUnindexedFilters: true },
      );
      assert.ok(r.ok, `${key} should be filterable`);
    }
  });

  it("does not enforce filterability when indexedKeys is empty", () => {
    const r = normalizeOne({ key: "anything", value: "x" }, { indexedKeys: [] });
    assert.ok(r.ok);
  });
});

// ---------------------------------------------------------------------------
// buildFilters — ordering, dedup, cap, timestamps, disabled no-op
// ---------------------------------------------------------------------------

describe("buildFilters", () => {
  it("returns empty result when enabled is false (Requirement 14.1)", () => {
    const result = buildFilters({
      enabled: false,
      userFilters: [{ key: "priority", value: "high" }],
    });
    assert.deepEqual(result, { filters: [], dropped: [] });
  });

  it("orders defaults, then user filters, then timestamp bounds (6.2, 8.1, 8.2)", () => {
    const result = buildFilters({
      defaultFilters: [{ key: "userId", value: "u1" }],
      userFilters: [{ key: "priority", value: "high" }],
      createdAfter: "2026-01-01T00:00:00Z",
      createdBefore: "2026-12-31T00:00:00Z",
    });
    assert.equal(result.filters.length, 4);
    assert.equal(result.filters[0].left.metadataKey, "userId");
    assert.equal(result.filters[1].left.metadataKey, "priority");
    assert.equal(result.filters[2].left.metadataKey, SYSTEM_TIMESTAMP_KEYS.createdAt);
    assert.equal(result.filters[2].operator, "AFTER");
    assert.equal(result.filters[3].operator, "BEFORE");
  });

  it("caps at 5 and records overflow as exceeds_max_5_filters (6.1, 6.3)", () => {
    const userFilters = Array.from({ length: 8 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
    }));
    const result = buildFilters({ userFilters });
    assert.equal(result.filters.length, MAX_FILTERS);
    const overflow = result.dropped.filter(
      (d) => d.reason === "exceeds_max_5_filters",
    );
    assert.equal(overflow.length, 3);
  });

  it("dedups by (key, operator, value), keeping the first occurrence (9.2)", () => {
    const result = buildFilters({
      userFilters: [
        { key: "priority", value: "high" },
        { key: "priority", value: "high" },
        { key: "priority", value: "low" },
      ],
    });
    assert.equal(result.filters.length, 2);
    assert.deepEqual(result.filters[0].right, {
      metadataValue: { stringValue: "high" },
    });
    assert.deepEqual(result.filters[1].right, {
      metadataValue: { stringValue: "low" },
    });
  });

  it("is deterministic for equal inputs (9.1)", () => {
    const opts = {
      defaultFilters: [{ key: "userId", value: "u1" }],
      userFilters: [{ key: "priority", value: "high" }],
      createdAfter: "2026-01-01T00:00:00Z",
    };
    assert.deepEqual(buildFilters(opts), buildFilters(opts));
  });

  it("does not mutate caller inputs (9.3)", () => {
    const userFilters = [{ key: "priority", value: "high" }];
    const defaultFilters = [{ key: "userId", value: "u1" }];
    const snapshotUser = JSON.stringify(userFilters);
    const snapshotDefault = JSON.stringify(defaultFilters);
    buildFilters({ userFilters, defaultFilters });
    assert.equal(JSON.stringify(userFilters), snapshotUser);
    assert.equal(JSON.stringify(defaultFilters), snapshotDefault);
  });

  it("createdAfter accepts a Date and normalizes to UTC ISO-8601 (8.3)", () => {
    const result = buildFilters({
      createdAfter: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    });
    assert.equal(result.filters.length, 1);
    assert.deepEqual(result.filters[0].right, {
      metadataValue: { dateTimeValue: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("drops unindexed keys but keeps valid ones (10.1, 16.1)", () => {
    const result = buildFilters({
      userFilters: [
        { key: "priority", value: "high" },
        { key: "notIndexed", value: "x" },
      ],
      indexedKeys: [{ key: "priority", type: "STRING" }],
      dropUnindexedFilters: true,
    });
    assert.equal(result.filters.length, 1);
    assert.equal(result.filters[0].left.metadataKey, "priority");
    assert.ok(result.dropped.some((d) => d.reason === "key_not_indexed"));
  });
});

// ---------------------------------------------------------------------------
// buildRecordMetadata — strict passthrough, unknown-key drop, allowedValues
// ---------------------------------------------------------------------------

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

describe("buildRecordMetadata", () => {
  const base = { category: "fact", scope: "agent:bija", source: "manual" };

  it("returns base metadata unchanged when disabled (Requirement 14.2)", () => {
    const result = buildRecordMetadata(
      base,
      { priority: "high" },
      { department: "billing" },
      metaConfig({ enabled: false, strictKeys: ["department"] }),
    );
    assert.deepEqual(result, base);
  });

  it("does not mutate the base metadata object", () => {
    const snapshot = JSON.stringify(base);
    buildRecordMetadata(base, { priority: "high" }, {}, metaConfig({
      indexedKeys: [{ key: "priority", type: "STRING" }],
    }));
    assert.equal(JSON.stringify(base), snapshot);
  });

  it("copies strict-key values verbatim for configured strict keys (Requirement 2.1, 2.2)", () => {
    const result = buildRecordMetadata(
      base,
      {},
      { department: "billing" },
      metaConfig({
        indexedKeys: [{ key: "department", type: "STRING" }],
        strictKeys: ["department"],
      }),
    );
    assert.equal(result.department, "billing");
  });

  it("drops strict values whose key is not a configured strict key (Requirement 2.3)", () => {
    const result = buildRecordMetadata(
      base,
      {},
      { department: "billing" },
      metaConfig({ strictKeys: [] }),
    );
    assert.equal(result.department, undefined);
  });

  it("drops unknown free-metadata keys, retaining known ones (Requirement 1.2, 1.4)", () => {
    const result = buildRecordMetadata(
      base,
      { priority: "high", bogus: "x" },
      {},
      metaConfig({ indexedKeys: [{ key: "priority", type: "STRING" }] }),
    );
    assert.equal(result.priority, "high");
    assert.equal(result.bogus, undefined);
  });

  it("serializes array values to strings (Requirement 1.3)", () => {
    const result = buildRecordMetadata(
      base,
      { tags: ["invoice", "duplicate"] },
      {},
      metaConfig({ indexedKeys: [{ key: "tags", type: "STRINGLIST" }] }),
    );
    assert.equal(result.tags, JSON.stringify(["invoice", "duplicate"]));
  });

  it("drops values outside allowedValues but retains other keys (Requirement 1.5, 16.2)", () => {
    const config = metaConfig({
      indexedKeys: [
        { key: "priority", type: "STRING" },
        { key: "department", type: "STRING" },
      ],
      schemaByStrategy: {
        SEMANTIC: [
          { key: "priority", type: "STRING", allowedValues: ["low", "high"] },
        ],
      },
    });
    const result = buildRecordMetadata(
      base,
      { priority: "urgent", department: "billing" },
      {},
      config,
    );
    assert.equal(result.priority, undefined, "invalid allowedValues dropped");
    assert.equal(result.department, "billing", "other keys retained");
  });
});
