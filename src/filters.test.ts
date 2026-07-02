import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertSimplifiedFilters, inferFilterValue } from "./tools/recall.js";

describe("inferFilterValue", () => {
  it("returns stringValue for plain strings", () => {
    assert.deepEqual(inferFilterValue("hello"), { stringValue: "hello" });
  });

  it("returns stringValue for numeric-looking strings with EQUALS_TO operator", () => {
    assert.deepEqual(inferFilterValue("2026", "EQUALS_TO"), { stringValue: "2026" });
  });

  it("returns stringValue for numeric-looking strings with NOT_EQUALS_TO operator", () => {
    assert.deepEqual(inferFilterValue("404", "NOT_EQUALS_TO"), { stringValue: "404" });
  });

  it("returns numberValue for numeric strings with GREATER_THAN operator", () => {
    assert.deepEqual(inferFilterValue("42", "GREATER_THAN"), { numberValue: 42 });
  });

  it("returns numberValue for numeric strings with LESS_THAN operator", () => {
    assert.deepEqual(inferFilterValue("3.14", "LESS_THAN"), { numberValue: 3.14 });
  });

  it("returns stringValue for non-numeric strings with GREATER_THAN operator", () => {
    assert.deepEqual(inferFilterValue("abc", "GREATER_THAN"), { stringValue: "abc" });
  });

  it("returns dateTimeValue for ISO datetime strings", () => {
    assert.deepEqual(inferFilterValue("2026-01-01T00:00:00Z"), { dateTimeValue: "2026-01-01T00:00:00Z" });
  });

  it("returns dateTimeValue for ISO datetime with space separator", () => {
    assert.deepEqual(inferFilterValue("2026-01-01 12:00:00"), { dateTimeValue: "2026-01-01 12:00:00" });
  });

  it("returns dateTimeValue with T00:00:00Z suffix for date-only with AFTER operator", () => {
    assert.deepEqual(inferFilterValue("2026-01-01", "AFTER"), { dateTimeValue: "2026-01-01T00:00:00Z" });
  });

  it("returns dateTimeValue with T00:00:00Z suffix for date-only with BEFORE operator", () => {
    assert.deepEqual(inferFilterValue("2026-03-15", "BEFORE"), { dateTimeValue: "2026-03-15T00:00:00Z" });
  });

  it("returns stringValue for date-only without AFTER/BEFORE operator", () => {
    assert.deepEqual(inferFilterValue("2026-01-01", "EQUALS_TO"), { stringValue: "2026-01-01" });
  });

  it("returns stringValue for empty string", () => {
    assert.deepEqual(inferFilterValue(""), { stringValue: "" });
  });

  it("returns stringValue when no operator is provided for numeric values", () => {
    assert.deepEqual(inferFilterValue("100"), { stringValue: "100" });
  });

  it("returns numberValue for negative numbers with GREATER_THAN", () => {
    assert.deepEqual(inferFilterValue("-5", "GREATER_THAN"), { numberValue: -5 });
  });
});

describe("convertSimplifiedFilters", () => {
  it("returns undefined for undefined input", () => {
    assert.equal(convertSimplifiedFilters(undefined), undefined);
  });

  it("returns undefined for empty array", () => {
    assert.equal(convertSimplifiedFilters([]), undefined);
  });

  it("converts a single EQUALS_TO filter with string value", () => {
    const result = convertSimplifiedFilters([
      { key: "priority", operator: "EQUALS_TO", value: "high" },
    ]);
    assert.deepEqual(result, [
      {
        left: { metadataKey: "priority" },
        operator: "EQUALS_TO",
        right: { metadataValue: { stringValue: "high" } },
      },
    ]);
  });

  it("converts GREATER_THAN filter with numeric value", () => {
    const result = convertSimplifiedFilters([
      { key: "count", operator: "GREATER_THAN", value: "10" },
    ]);
    assert.deepEqual(result, [
      {
        left: { metadataKey: "count" },
        operator: "GREATER_THAN",
        right: { metadataValue: { numberValue: 10 } },
      },
    ]);
  });

  it("converts AFTER filter with ISO datetime value", () => {
    const result = convertSimplifiedFilters([
      { key: "x-amz-agentcore-memory-createdAt", operator: "AFTER", value: "2026-01-01T00:00:00Z" },
    ]);
    assert.deepEqual(result, [
      {
        left: { metadataKey: "x-amz-agentcore-memory-createdAt" },
        operator: "AFTER",
        right: { metadataValue: { dateTimeValue: "2026-01-01T00:00:00Z" } },
      },
    ]);
  });

  it("converts BEFORE filter with date-only value to dateTimeValue", () => {
    const result = convertSimplifiedFilters([
      { key: "expiry", operator: "BEFORE", value: "2026-06-15" },
    ]);
    assert.deepEqual(result, [
      {
        left: { metadataKey: "expiry" },
        operator: "BEFORE",
        right: { metadataValue: { dateTimeValue: "2026-06-15T00:00:00Z" } },
      },
    ]);
  });

  it("does NOT infer numberValue for EQUALS_TO with numeric string", () => {
    const result = convertSimplifiedFilters([
      { key: "version", operator: "EQUALS_TO", value: "2" },
    ]);
    assert.deepEqual(result, [
      {
        left: { metadataKey: "version" },
        operator: "EQUALS_TO",
        right: { metadataValue: { stringValue: "2" } },
      },
    ]);
  });

  it("converts multiple filters", () => {
    const result = convertSimplifiedFilters([
      { key: "priority", operator: "EQUALS_TO", value: "high" },
      { key: "score", operator: "GREATER_THAN", value: "0.8" },
    ]);
    assert.equal(result!.length, 2);
    assert.deepEqual(result![0].right.metadataValue, { stringValue: "high" });
    assert.deepEqual(result![1].right.metadataValue, { numberValue: 0.8 });
  });
});
