# Requirements Document

## Introduction

This document specifies the requirements for **Structured Metadata Filtering** in the
`memory-agentcore` OpenClaw plugin. The feature is derived from the approved design document
(`design.md`) and adds AWS Bedrock AgentCore Memory's structured metadata filtering and
strictly-consistent (deterministic) metadata on top of the plugin's existing namespace/scope
isolation model.

The feature lets callers (a) attach structured attributes (priority, department, channel, tags,
time bounds) to records on write, and (b) apply `metadataFilters` at read time to narrow results
*within* an already-authorized namespace. All new behavior is additive and backward-compatible:
when the feature is disabled, every read and write path behaves exactly as it does today.

A single pure module, `metadata-filter.ts`, is the sole path for constructing, validating, and
capping filters and for assembling write metadata. Filter application flows through the existing
`AgentCoreClient` read commands. Indexed-key provisioning is treated as an **externally-owned setup
concern**: operators declare `indexedKeys` and per-strategy metadata schemas when they create the
memory resource, and the plugin validates their presence on startup and degrades gracefully when
they are missing. The plugin does **not** call `CreateMemory`/`UpdateMemory`.

## Glossary

- **Plugin**: The `memory-agentcore` OpenClaw plugin as a whole.
- **Metadata_Filter_Module**: The new pure module `metadata-filter.ts`, exposing `buildFilters`,
  `normalizeOne`, and `buildRecordMetadata`.
- **AgentCore_Client**: The `AgentCoreClient` in `client.ts` that wraps the AWS SDK data-plane calls.
- **Store_Tool**: The `agentcore_store` tool that writes memory records.
- **Recall_Tool**: The `agentcore_recall` tool that performs semantic retrieval via
  `RetrieveMemoryRecordsCommand`.
- **Search_Tool**: The `agentcore_search` tool that performs non-semantic listing via
  `ListMemoryRecordsCommand`.
- **Auto_Recall_Hook**: The `before_prompt_build` hook that performs automatic recall.
- **Auto_Capture_Hook**: The `agent_end` hook that automatically captures memory events.
- **Config_Resolver**: The `resolveConfig` function in `config.ts`.
- **Metadata_Config_Validator**: The `validateMetadataConfig` function.
- **Metadata_Filter**: The canonical wire-shape filter expression
  `{ left: { metadataKey }, operator, right?: { metadataValue } }`.
- **Metadata_Filter_Input**: The loose caller-facing filter shape `{ key, operator?, value? }`.
- **Indexed_Key**: A metadata key declared filterable at memory-creation time
  (`{ key, type: STRING | STRINGLIST | NUMBER }`), maximum 10 per memory resource.
- **Strict_Key**: An indexed key of type `STRING` treated as strictly-consistent (deterministic),
  maximum 3 per strategy.
- **System_Timestamp_Key**: The always-filterable keys `x-amz-agentcore-memory-createdAt` and
  `x-amz-agentcore-memory-updatedAt`, filterable without any declared indexed key.
- **Filter_Cap**: The AWS hard limit of 5 metadata filters per query, combined with AND logic.
- **Metadata_Config**: The `MetadataConfig` object added to `PluginConfig` (fields: `enabled`,
  `indexedKeys`, `schemaByStrategy`, `strictKeys`, `defaultRecallFilters`, `dropUnindexedFilters`).
- **Dropped_Filter**: A candidate filter excluded from the final list, recorded with a reason
  (over cap, not indexed, invalid operator/value).
- **Feature_Disabled**: The state where `Metadata_Config.enabled` is `false`.

## Requirements

### Requirement 1: Attach structured (free / LLM-inferred) metadata on write

**User Story:** As a memory author, I want to attach structured attributes to stored records, so that
those records can later be filtered precisely within their namespace.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Store_Tool receives an optional `metadata`
   object of structured attributes, THE Metadata_Filter_Module SHALL merge the supplied attributes with
   the base metadata (category, scope, source, tags, userId) via `buildRecordMetadata`.
2. WHEN `buildRecordMetadata` processes a supplied attribute whose key is not a known indexed key or
   schema-defined key, THE Metadata_Filter_Module SHALL exclude that key from the returned metadata and
   log a warning identifying the dropped key.
3. WHEN `buildRecordMetadata` processes an attribute whose value is an array, THE Metadata_Filter_Module
   SHALL serialize the value to a string so that the result conforms to the event-metadata
   `Record<string,string>` shape.
4. THE Metadata_Filter_Module SHALL return metadata in which every key is either a base key, a
   configured Strict_Key, or a known indexed or schema-defined key.
5. IF `buildRecordMetadata` receives a value for a key that defines `allowedValues` and the value is not
   a member of that `allowedValues` set, THEN THE Metadata_Filter_Module SHALL exclude that key from the
   returned metadata and log a warning, and SHALL retain all other valid keys.

### Requirement 2: Attach strictly-consistent (deterministic) metadata on write

**User Story:** As a memory author, I want to attach deterministic classifier values to records, so that
strictly-consistent extraction groups records by the exact value I supplied.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Store_Tool receives an optional `strictMetadata`
   object, THE Metadata_Filter_Module SHALL copy each strict value verbatim into the returned metadata
   for every key that is a configured Strict_Key.
2. THE Metadata_Filter_Module SHALL apply no transformation to a value written under a Strict_Key, such
   that the stored value equals the value supplied at write time.
3. IF `buildRecordMetadata` receives a strict value whose key is not a configured Strict_Key, THEN THE
   Metadata_Filter_Module SHALL exclude that key from the returned metadata and log a warning.

### Requirement 3: Auto-capture hook attaches deterministic keys

**User Story:** As an operator, I want the auto-capture hook to attach configured deterministic keys to
captured events, so that strictly-consistent grouping works during extraction.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Auto_Capture_Hook creates a memory event, THE
   Auto_Capture_Hook SHALL attach the values configured in `Metadata_Config.strictKeys` as event
   metadata.
2. WHERE `Metadata_Config.enabled` is `false`, WHEN the Auto_Capture_Hook creates a memory event, THE
   Auto_Capture_Hook SHALL attach only the metadata it attaches today.

### Requirement 4: Apply metadata filters on semantic recall

**User Story:** As a caller, I want to supply metadata filters to recall, so that semantic results are
pre-filtered to only records matching my attributes.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Recall_Tool receives an optional `filters` array,
   THE Recall_Tool SHALL construct the wire filters via `buildFilters` before calling the AgentCore_Client.
2. WHEN the AgentCore_Client executes `retrieveMemoryRecords` with a non-empty `metadataFilters` list,
   THE AgentCore_Client SHALL place the filters under `searchCriteria.metadataFilters` in the emitted
   `RetrieveMemoryRecordsCommand`.
3. WHEN a recall returns records, THE Recall_Tool SHALL return only records that satisfy every applied
   filter among the semantic top-K results.
4. WHEN one or more candidate filters are dropped during construction, THE Recall_Tool SHALL filter
   results against only the remaining valid filters and SHALL include the Dropped_Filter list with
   reasons in the tool `details` payload.

### Requirement 5: Apply metadata filters on non-semantic search

**User Story:** As a caller, I want to supply metadata filters to search, so that a non-semantic listing
returns only records matching my attributes.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Search_Tool receives an optional `filters` array,
   THE Search_Tool SHALL construct the wire filters via `buildFilters` before calling the AgentCore_Client.
2. WHEN the AgentCore_Client executes `listMemoryRecords` with a non-empty `metadataFilters` list, THE
   AgentCore_Client SHALL place the filters as the top-level `metadataFilters` parameter in the emitted
   `ListMemoryRecordsCommand`.
3. WHEN a search returns records, THE Search_Tool SHALL return only records that satisfy every supplied
   filter, and SHALL preserve existing `nextToken` pagination behavior.

### Requirement 6: Enforce the maximum 5-filter AND cap

**User Story:** As a caller, I want the plugin to enforce the AWS 5-filter limit deterministically, so
that over-supplying filters never produces a malformed request.

#### Acceptance Criteria

1. THE Metadata_Filter_Module SHALL return a `filters` list whose length is at most 5 for every call to
   `buildFilters`.
2. WHEN the combined count of default, user, and timestamp candidate filters exceeds 5, THE
   Metadata_Filter_Module SHALL retain the first 5 filters in the order default filters, then user
   filters, then timestamp filters.
3. WHEN candidate filters exceed 5, THE Metadata_Filter_Module SHALL record each filter beyond the fifth
   in the Dropped_Filter list with the reason `exceeds_max_5_filters`.

### Requirement 7: Normalize and validate operator/value combinations

**User Story:** As a caller, I want each filter's operator and value validated before any network call,
so that type mismatches are rejected locally rather than by AWS.

#### Acceptance Criteria

1. WHEN a Metadata_Filter_Input omits an operator, THE Metadata_Filter_Module SHALL infer `EXISTS` when
   no value is present and `EQUALS_TO` when a value is present.
2. IF a Metadata_Filter_Input specifies an operator outside the supported set (`EQUALS_TO`, `CONTAINS`,
   `EXISTS`, `NOT_EXISTS`, `GREATER_THAN`, `GREATER_THAN_OR_EQUALS`, `LESS_THAN`,
   `LESS_THAN_OR_EQUALS`, `BEFORE`, `AFTER`), THEN THE Metadata_Filter_Module SHALL drop the filter with
   the reason `unsupported_operator`.
3. WHEN the operator is `EXISTS` or `NOT_EXISTS`, THE Metadata_Filter_Module SHALL emit a Metadata_Filter
   with no `right` value.
4. IF the operator requires a value and the Metadata_Filter_Input omits the value, THEN THE
   Metadata_Filter_Module SHALL drop the filter with the reason `missing_value`.
5. IF the supplied value type is incompatible with the operator (for example a string with
   `GREATER_THAN`), THEN THE Metadata_Filter_Module SHALL drop the filter with the reason
   `operator_value_type_mismatch`.
6. WHEN coercing a compatible value, THE Metadata_Filter_Module SHALL emit `numberValue` for numeric
   comparison operators, `stringValue` for `EQUALS_TO`/`CONTAINS`, and `dateTimeValue` for
   `BEFORE`/`AFTER`.
7. IF a Metadata_Filter_Input has an empty key, THEN THE Metadata_Filter_Module SHALL drop the filter
   with the reason `empty_key`.

### Requirement 8: Support system timestamp filters with UTC normalization

**User Story:** As a caller, I want to bound results by creation time using convenience parameters, so
that I can retrieve records within a time window without knowing the system key names.

#### Acceptance Criteria

1. WHEN the caller supplies `createdAfter`, THE Metadata_Filter_Module SHALL emit a Metadata_Filter on
   the `x-amz-agentcore-memory-createdAt` System_Timestamp_Key with the `AFTER` operator.
2. WHEN the caller supplies `createdBefore`, THE Metadata_Filter_Module SHALL emit a Metadata_Filter on
   the `x-amz-agentcore-memory-createdAt` System_Timestamp_Key with the `BEFORE` operator.
3. WHEN the Metadata_Filter_Module emits a `dateTimeValue` from a `Date` or ISO string input, THE
   Metadata_Filter_Module SHALL serialize the value to UTC ISO-8601 format.
4. THE Metadata_Filter_Module SHALL treat System_Timestamp_Keys as filterable regardless of the
   configured indexed keys.

### Requirement 9: Deterministic filter construction and deduplication

**User Story:** As a developer, I want `buildFilters` to be deterministic, so that identical inputs
always produce the identical ordered filter list.

#### Acceptance Criteria

1. WHEN `buildFilters` receives a given `options` input, THE Metadata_Filter_Module SHALL produce an
   identical ordered `filters` list for every invocation with an equal input.
2. WHEN two candidate filters share the same metadata key, operator, and serialized value, THE
   Metadata_Filter_Module SHALL retain only the first occurrence and discard the duplicate.
3. THE Metadata_Filter_Module SHALL neither reorder surviving filters after deduplication nor mutate the
   caller's input objects.

### Requirement 10: Optional filterability validation against indexed keys

**User Story:** As an operator, I want filters on unknown keys handled per configuration, so that I can
choose between dropping them locally or letting AWS decide.

#### Acceptance Criteria

1. WHERE `Metadata_Config.indexedKeys` is non-empty AND `Metadata_Config.dropUnindexedFilters` is `true`,
   IF a filter references a key that is neither a declared Indexed_Key nor an always-filterable system
   key, THEN THE Metadata_Filter_Module SHALL drop the filter with the reason `key_not_indexed`.
2. WHERE `Metadata_Config.indexedKeys` is non-empty AND `Metadata_Config.dropUnindexedFilters` is
   `false`, WHEN a filter references a key that is not a declared Indexed_Key, THE Metadata_Filter_Module
   SHALL pass the filter through for AWS to evaluate.
3. IF a passed-through filter causes an AWS validation error during a per-namespace call, THEN THE
   Recall_Tool and Search_Tool SHALL isolate the failure to that namespace and return results from the
   unaffected namespaces.

### Requirement 11: Metadata configuration surface and resolution

**User Story:** As an operator, I want to declare metadata configuration through env and raw plugin
config, so that I can control filtering behavior without code changes.

#### Acceptance Criteria

1. THE Config_Resolver SHALL resolve a `Metadata_Config` object containing `enabled`, `indexedKeys`,
   `schemaByStrategy`, `strictKeys`, `defaultRecallFilters`, and `dropUnindexedFilters`.
2. WHEN `AGENTCORE_METADATA_ENABLED` is set, THE Config_Resolver SHALL resolve `Metadata_Config.enabled`
   from that environment variable.
3. WHEN `AGENTCORE_METADATA_INDEXED_KEYS` is set as a comma-separated list of `key:type` pairs, THE
   Config_Resolver SHALL parse it into the `indexedKeys` list.
4. WHEN `AGENTCORE_METADATA_STRICT_KEYS` is set as a comma-separated list, THE Config_Resolver SHALL
   parse it into the `strictKeys` list.
5. THE Config_Resolver SHALL resolve `schemaByStrategy` and `defaultRecallFilters` from the raw plugin
   config object only.
6. WHERE no metadata configuration is supplied, THE Config_Resolver SHALL default `Metadata_Config.enabled`
   to `false`.

### Requirement 12: Metadata configuration validation

**User Story:** As an operator, I want invalid metadata configuration detected without crashing, so that
misconfiguration fails safe instead of sending bad requests.

#### Acceptance Criteria

1. THE Metadata_Config_Validator SHALL return `valid` equal to `true` if and only if every configured
   validation rule holds, and SHALL otherwise return an `errors` list enumerating each violation.
2. IF `indexedKeys` contains more than 10 keys, THEN THE Metadata_Config_Validator SHALL report a
   validation error.
3. IF any Strict_Key is not present among the configured indexed keys or is not of type `STRING`, THEN
   THE Metadata_Config_Validator SHALL report a validation error.
4. IF any strategy schema defines more than 3 strict keys, or defines strict keys under the `SUMMARY`
   strategy, THEN THE Metadata_Config_Validator SHALL report a validation error.
5. IF any `allowedValues` set contains more than 10 entries, or any key does not match the required
   character set, THEN THE Metadata_Config_Validator SHALL report a validation error.
6. THE Metadata_Config_Validator SHALL return a result rather than raising an exception for any input.
7. IF the Metadata_Config_Validator reports the configuration as invalid at startup, THEN THE Plugin
   SHALL treat `Metadata_Config.enabled` as `false`, SHALL log the enumerated validation errors to
   notify the operator, and SHALL continue operating without filtering.

### Requirement 13: Startup validation of indexed keys against the provisioned memory resource

**User Story:** As an operator, I want the plugin to confirm the memory resource exposes the expected
indexed keys, so that I am warned about configuration drift without the plugin taking over provisioning.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `true`, WHEN the Plugin starts, THE Plugin SHALL retrieve the
   provisioned memory resource description and compare its declared indexed keys against
   `Metadata_Config.indexedKeys`.
2. IF an expected Indexed_Key is absent from the provisioned memory resource, THEN THE Plugin SHALL log a
   warning identifying the missing key and continue operating.
3. WHERE a read-only memory-description operation is required for startup validation, THE Plugin SHALL
   be permitted to call read-only memory operations to inspect the existing resource.
4. THE Plugin SHALL NOT call any memory-provisioning operation that creates or modifies the memory
   resource's indexed keys.

### Requirement 14: Backward compatibility when the feature is disabled

**User Story:** As an existing user, I want unchanged behavior when metadata filtering is off, so that
adopting the plugin update carries no risk.

#### Acceptance Criteria

1. WHERE `Metadata_Config.enabled` is `false`, WHEN `buildFilters` is invoked, THE Metadata_Filter_Module
   SHALL return an empty `filters` list.
2. WHERE `Metadata_Config.enabled` is `false`, WHEN `buildRecordMetadata` is invoked, THE
   Metadata_Filter_Module SHALL return metadata equal to the supplied base metadata.
3. WHEN the AgentCore_Client executes a read command with an empty `metadataFilters` list, THE
   AgentCore_Client SHALL emit a command identical to the pre-feature command for the same query and
   namespace.
4. WHEN a read command is emitted with no filters, THE Recall_Tool and Search_Tool SHALL return the same
   result set as the pre-feature behavior for the same query and namespace.

### Requirement 15: No privilege escalation

**User Story:** As a security reviewer, I want metadata filtering to be orthogonal to access control, so
that filters can never expand what a caller may read.

#### Acceptance Criteria

1. THE Recall_Tool and Search_Tool SHALL resolve authorized namespaces through `scopes.ts` before
   applying any metadata filter.
2. WHEN metadata filters are applied, THE Recall_Tool and Search_Tool SHALL return a subset of the
   records already authorized by the resolved namespaces.
3. THE Metadata_Filter_Module SHALL NOT alter namespace resolution or scope authorization.
4. IF namespace resolution fails or yields no authorized namespaces, THEN THE Recall_Tool and
   Search_Tool SHALL return an empty result set, preserving the subset relationship.

### Requirement 16: Graceful degradation and store-time error handling

**User Story:** As a caller, I want filtering and metadata errors handled gracefully, so that a single
bad filter or value never fails the whole operation.

#### Acceptance Criteria

1. IF filters are dropped during construction, THEN THE Recall_Tool and Search_Tool SHALL proceed using
   the remaining valid filters.
2. IF a store request supplies a metadata value rejected by `allowedValues`, THEN THE Store_Tool SHALL
   store the record without the rejected key rather than failing the store.
3. WHEN a metadata-related warning occurs on any read or write path, THE Plugin SHALL log the warning and
   continue the operation.
