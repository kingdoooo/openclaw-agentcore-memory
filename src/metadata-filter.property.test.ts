/**
 * metadata-filter.property.test.ts — Property-based tests (fast-check) for the
 * pure `metadata-filter.ts` module.
 *
 * These tests encode the 8 "Correctness Properties" from the design document
 * (`.kiro/specs/structured-metadata-filtering/design.md`). Example-based unit
 * tests live in the companion `metadata-filter.test.ts`; this file exercises
 * the same functions across a wide, randomly-generated input space.
 *
 * Each property runs >= 100 iterations (fast-check `numRuns`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { MetadataConfig, MetadataFilterInput } from "./config.js";
import {
  buildFilters,
  buildRecordMetadata,
  coerceValue,
  SYSTEM_TIMESTAMP_KEYS,
  MAX_FILTERS,
  type MetadataFilter,
  type FilterOperator,
} from "./metadata-filter.js";

const NUM_RUNS = 200;

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

const SUPPORTED_OPERATORS: readonly FilterOperator[] = [
  "EQUALS_TO",
  "CONTAINS",
  "EXISTS",
  "NOT_EXISTS",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUALS",
  "LESS_THAN",
  "LESS_THAN_OR_EQUALS",
  "BEFORE",
  "AFTER",
];

const NUMERIC_OPERATORS: readonly FilterOperator[] = [
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUALS",
  "LESS_THAN",
  "LESS_THAN_OR_EQUALS",
];

const NO_VALUE_OPERATORS: readonly FilterOperator[] = ["EXISTS", "NOT_EXISTS"];

/** Safe metadata key: non-empty, avoids prototype-pollution special keys. */
const arbKey = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter(
    (k) => k !== "__proto__" && k !== "constructor" && k !== "prototype",
  );

/** Operator arbitrary: supported operators plus a couple of unsupported ones. */
const arbOperator = fc.constantFrom(
  ...SUPPORTED_OPERATORS,
  "LIKE",
  "BOGUS",
  "equals_to",
);

/** Valid millisecond timestamps in [1970, ~2100] so Dates are always valid. */
const arbEpochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });

/** Filter-input value arbitrary (string | number | string[] | ISO string). */
const arbValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.array(fc.string(), { maxLength: 4 }),
  arbEpochMs.map((ms) => new Date(ms).toISOString()),
);

/** A loose MetadataFilterInput; `operator` and `value` may be omitted. */
const arbInput: fc.Arbitrary<MetadataFilterInput> = fc.record(
  {
    key: fc.oneof(fc.constant(""), arbKey),
    operator: arbOperator,
    value: arbValue,
  },
  { requiredKeys: ["key"] },
) as fc.Arbitrary<MetadataFilterInput>;

const UTC_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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

/** Assert a survivor is a structurally valid wire MetadataFilter. */
function assertStructurallyValid(f: MetadataFilter): void {
  // left.metadataKey is a non-empty string.
  assert.equal(typeof f.left?.metadataKey, "string");
  assert.notEqual(f.left.metadataKey, "");

  // operator is supported.
  assert.ok(
    SUPPORTED_OPERATORS.includes(f.operator),
    `unsupported operator survived: ${f.operator}`,
  );

  if (NO_VALUE_OPERATORS.includes(f.operator)) {
    // EXISTS / NOT_EXISTS must carry no right value.
    assert.equal(f.right, undefined);
    return;
  }

  // Every value-requiring operator carries a right.metadataValue of the
  // variant matching the operator's coercion rule.
  assert.ok(f.right, `operator ${f.operator} must have a right value`);
  const mv = f.right.metadataValue as Record<string, unknown>;
  assert.equal(typeof mv, "object");

  if (f.operator === "EQUALS_TO" || f.operator === "CONTAINS") {
    assert.equal(typeof mv.stringValue, "string");
  } else if (NUMERIC_OPERATORS.includes(f.operator)) {
    assert.equal(typeof mv.numberValue, "number");
    assert.ok(Number.isFinite(mv.numberValue as number));
  } else if (f.operator === "BEFORE" || f.operator === "AFTER") {
    assert.equal(typeof mv.dateTimeValue, "string");
  } else {
    assert.fail(`unexpected value-requiring operator: ${f.operator}`);
  }
}

// ---------------------------------------------------------------------------
// Property 1: Cap invariant (Requirement 6.1)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 1: Cap invariant", () => {
  it("buildFilters(...).filters.length <= 5 for any arbitrary filter-input list", () => {
    fc.assert(
      fc.property(
        fc.array(arbInput, { maxLength: 30 }),
        fc.array(arbInput, { maxLength: 30 }),
        fc.option(arbEpochMs.map((ms) => new Date(ms).toISOString()), {
          nil: undefined,
        }),
        fc.option(arbEpochMs.map((ms) => new Date(ms).toISOString()), {
          nil: undefined,
        }),
        (userFilters, defaultFilters, createdAfter, createdBefore) => {
          const { filters } = buildFilters({
            enabled: true,
            userFilters,
            defaultFilters,
            createdAfter,
            createdBefore,
          });
          assert.ok(
            filters.length <= MAX_FILTERS,
            `expected <= ${MAX_FILTERS}, got ${filters.length}`,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: AND soundness (structural) (Requirements 4.3, 5.3, 7.3)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 2: AND soundness (structural)", () => {
  it("every survivor is a structurally valid MetadataFilter", () => {
    fc.assert(
      fc.property(
        fc.array(arbInput, { maxLength: 30 }),
        fc.array(arbInput, { maxLength: 30 }),
        fc.boolean(),
        (userFilters, defaultFilters, dropUnindexed) => {
          const { filters } = buildFilters({
            enabled: true,
            userFilters,
            defaultFilters,
            dropUnindexedFilters: dropUnindexed,
          });
          for (const f of filters) assertStructurallyValid(f);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Determinism of survivors (Requirements 9.1, 9.2, 9.3)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 5: Determinism of survivors", () => {
  it("equal inputs yield identical filters; survivors are unique; inputs unmutated", () => {
    fc.assert(
      fc.property(
        fc.array(arbInput, { maxLength: 20 }),
        fc.array(arbInput, { maxLength: 20 }),
        fc.option(arbEpochMs.map((ms) => new Date(ms).toISOString()), {
          nil: undefined,
        }),
        (userFilters, defaultFilters, createdAfter) => {
          const options = { enabled: true, userFilters, defaultFilters, createdAfter };

          // (9.3) inputs are not mutated.
          const snapshot = JSON.stringify(options);
          const first = buildFilters(structuredClone(options));
          assert.equal(JSON.stringify(options), snapshot);

          // (9.1) equal inputs → identical ordered filters.
          const second = buildFilters(structuredClone(options));
          assert.deepEqual(first.filters, second.filters);

          // (9.2) no two survivors share (key, operator, serialized value).
          const seen = new Set<string>();
          for (const f of first.filters) {
            const dedupKey = `${f.left.metadataKey}\u0000${f.operator}\u0000${JSON.stringify(
              f.right?.metadataValue ?? null,
            )}`;
            assert.ok(!seen.has(dedupKey), `duplicate survivor: ${dedupKey}`);
            seen.add(dedupKey);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Strict-value fidelity (Requirement 2.2)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 6: Strict-value fidelity", () => {
  it("buildRecordMetadata stores every strict-key value verbatim", () => {
    fc.assert(
      fc.property(
        fc.dictionary(arbKey, fc.string(), { maxKeys: 8, noNullPrototype: true }), // strictMeta
        fc.dictionary(arbKey, fc.string(), { maxKeys: 8, noNullPrototype: true }), // base
        (strictMeta, base) => {
          const config = metaConfig({ strictKeys: Object.keys(strictMeta) });
          const result = buildRecordMetadata(base, undefined, strictMeta, config);
          for (const [k, v] of Object.entries(strictMeta)) {
            assert.equal(
              result[k],
              v,
              `strict value for "${k}" was transformed`,
            );
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Idempotent no-op (Requirements 14.1, 14.2)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 7: Idempotent no-op", () => {
  it("buildFilters returns empty filters when enabled is false", () => {
    fc.assert(
      fc.property(
        fc.array(arbInput, { maxLength: 20 }),
        fc.array(arbInput, { maxLength: 20 }),
        fc.option(arbEpochMs.map((ms) => new Date(ms).toISOString()), {
          nil: undefined,
        }),
        (userFilters, defaultFilters, createdAfter) => {
          const { filters } = buildFilters({
            enabled: false,
            userFilters,
            defaultFilters,
            createdAfter,
          });
          assert.equal(filters.length, 0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("buildRecordMetadata returns base metadata when enabled is false", () => {
    fc.assert(
      fc.property(
        fc.dictionary(arbKey, fc.string(), { maxKeys: 8, noNullPrototype: true }), // base
        fc.dictionary(arbKey, fc.string(), { maxKeys: 8, noNullPrototype: true }), // userMeta (ignored)
        fc.dictionary(arbKey, fc.string(), { maxKeys: 8, noNullPrototype: true }), // strictMeta (ignored)
        (base, userMeta, strictMeta) => {
          const config = metaConfig({
            enabled: false,
            strictKeys: Object.keys(strictMeta),
          });
          const result = buildRecordMetadata(base, userMeta, strictMeta, config);
          assert.deepEqual(result, base);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: Timestamp UTC normalization (Requirement 8.3)
// ---------------------------------------------------------------------------

describe("Feature: structured-metadata-filtering, Property 8: Timestamp UTC normalization", () => {
  it("coerceValue normalizes any Date/ISO input for BEFORE/AFTER to UTC ISO-8601", () => {
    fc.assert(
      fc.property(
        arbEpochMs,
        fc.constantFrom<FilterOperator>("BEFORE", "AFTER"),
        fc.boolean(),
        (ms, operator, asDate) => {
          const date = new Date(ms);
          const input = asDate ? date : date.toISOString();
          const result = coerceValue(operator, input);
          assert.ok(result && "dateTimeValue" in result);
          const iso = (result as { dateTimeValue: string }).dateTimeValue;
          assert.match(iso, UTC_ISO_8601);
          assert.equal(iso, date.toISOString());
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("buildFilters normalizes createdAfter/createdBefore bounds to UTC ISO-8601", () => {
    fc.assert(
      fc.property(arbEpochMs, fc.boolean(), (ms, asDate) => {
        const date = new Date(ms);
        const input = asDate ? date : date.toISOString();
        const { filters } = buildFilters({
          enabled: true,
          createdAfter: input,
        });
        assert.equal(filters.length, 1);
        const f = filters[0];
        assert.equal(f.left.metadataKey, SYSTEM_TIMESTAMP_KEYS.createdAt);
        assert.equal(f.operator, "AFTER");
        const mv = f.right?.metadataValue as { dateTimeValue: string };
        assert.match(mv.dateTimeValue, UTC_ISO_8601);
        assert.equal(mv.dateTimeValue, date.toISOString());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
