import {
  AGENT_COGNITION_VERSION,
  AgentCognitionValidationError,
  COGNITION_MAX_BLOCK_REFS_PER_SECTION,
  COGNITION_MAX_BLOCK_REFS_TOTAL,
  COGNITION_MAX_CONTEXT_RULES,
  COGNITION_MAX_ID_BYTES,
  COGNITION_MAX_LIST_BYTES,
  COGNITION_MAX_LIST_ITEMS,
  COGNITION_MAX_PREDICATE_DEPTH,
  COGNITION_MAX_PREDICATE_NODES,
  COGNITION_MAX_SOURCE_BLOCKS,
  COGNITION_MAX_STRING_BYTES,
  COGNITION_MAX_TASK_TEMPLATES,
  type CognitionActivationPointV1,
  type CognitionActivationResultV1,
  type CognitionActivationRootsV1,
  type CognitionActivationStateV1,
  type CognitionCompletionResultV1,
  type CognitionEvaluationContextV1,
  type CognitionFrozenSourceRevisionsV1,
  type CognitionGenerationType,
  type CognitionGraphV1,
  type CognitionLoomBlockRefV1,
  type CognitionPhase,
  type CognitionPolicyRefsV1,
  type CognitionPredicateOperator,
  type CognitionPredicateV1,
  type CognitionScalar,
  type CognitionSourceBlockV1,
  type CognitionSourceSnapshotV1,
  type CognitionTaskTransition,
  type CognitionTaskTransitionResultV1,
  type CognitionValue,
  type ContextActivationRuleV1,
  type FrozenCognitionGraphV1,
  type TaskTemplateV1,
  type CognitionWorkspaceCasV1,
} from "../types/agent-cognition";

const UTF8_ENCODER = new TextEncoder();
const OBJECT_PROTO = Object.prototype;

type PlainRecord = Record<string, unknown>;

type ParseBudget = {
  predicateNodes: number;
  listBytes: number;
};

const GENERATION_TYPES: readonly CognitionGenerationType[] = [
  "normal",
  "continue",
  "regenerate",
  "swipe",
];
const PHASES: readonly CognitionPhase[] = [
  "ASSEMBLE",
  "WORK",
  "COMPLETE",
  "RENDER",
  "PREPARE_COMMIT",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_FAILED",
  "EXHAUSTED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
];
const TASK_TRANSITIONS: readonly CognitionTaskTransition[] = [
  "pending",
  "active",
  "blocked",
  "submitted",
  "accepted",
  "done",
];
const PREDICATE_KINDS = [
  "all",
  "any",
  "not",
  "generation_type",
  "phase",
  "preset_variable",
  "participant_fact",
  "tool_available",
  "task_transition",
] as const;
const PREDICATE_OPERATORS = ["equals", "in", "includes", "present"] as const;

function fail(code: AgentCognitionValidationError["code"], path: string, message: string): never {
  throw new AgentCognitionValidationError(code, path, message);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === OBJECT_PROTO || proto === null;
}

function record(value: unknown, path: string): PlainRecord {
  if (!isPlainRecord(value)) fail("invalid_type", path, "must be a plain object");
  return value;
}

function exactKeys(value: PlainRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("unknown_key", `${path}.${key}`, "unknown key");
  }
}

function has(value: PlainRecord, key: string): boolean {
  return OBJECT_PROTO.hasOwnProperty.call(value, key);
}

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/** UTF-8 byte order, never locale-sensitive Unicode collation. */
export function compareCognitionUtf8(a: string, b: string): number {
  const left = UTF8_ENCODER.encode(a);
  const right = UTF8_ENCODER.encode(b);
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.byteLength === right.byteLength ? 0 : left.byteLength < right.byteLength ? -1 : 1;
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function containsForbiddenMarkup(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

function ensureSafeText(value: unknown, path: string, maxBytes = COGNITION_MAX_STRING_BYTES): string {
  if (typeof value !== "string") fail("invalid_type", path, "must be a string");
  if (utf8Bytes(value) > maxBytes) fail("limit_exceeded", path, `must be at most ${maxBytes} UTF-8 bytes`);
  if (containsForbiddenMarkup(value)) fail("invalid_value", path, "macros are not allowed");
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)) {
      fail("invalid_value", path, "contains a control character");
    }
  }
  return value;
}

function ensureId(value: unknown, path: string): string {
  const result = ensureSafeText(value, path, COGNITION_MAX_ID_BYTES);
  if (result.length === 0) fail("invalid_value", path, "must not be empty");
  for (const character of result) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f) fail("invalid_value", path, "must not contain whitespace");
  }
  return result;
}

function ensureBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid_type", path, "must be a boolean");
  return value;
}

function ensureRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid_type", path, "must be a non-negative safe integer");
  }
  return value;
}

function ensureEnum<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail("invalid_value", path, "contains an unsupported value");
  }
  return value as T;
}

function ensureArray(value: unknown, path: string, maxItems = COGNITION_MAX_LIST_ITEMS): unknown[] {
  if (!Array.isArray(value)) fail("invalid_type", path, "must be an array");
  if (value.length > maxItems) fail("limit_exceeded", path, `must contain at most ${maxItems} items`);
  return value;
}

function accountListBytes(budget: ParseBudget, value: string, path: string): void {
  budget.listBytes += utf8Bytes(value);
  if (budget.listBytes > COGNITION_MAX_LIST_BYTES) {
    fail("limit_exceeded", path, `list strings must total at most ${COGNITION_MAX_LIST_BYTES} UTF-8 bytes`);
  }
}

function ensureScalar(value: unknown, path: string, budget?: ParseBudget): CognitionScalar {
  if (typeof value === "string") {
    const text = ensureSafeText(value, path);
    if (budget) accountListBytes(budget, text, path);
    return text;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_value", path, "must be finite");
    return value;
  }
  if (typeof value === "boolean") return value;
  fail("invalid_type", path, "must be a string, finite number, or boolean");
}

function parseValue(value: unknown, path: string, budget: ParseBudget): CognitionValue {
  if (!Array.isArray(value)) return ensureScalar(value, path);
  const values = ensureArray(value, path);
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (typeof item !== "string") fail("invalid_type", `${path}[${index}]`, "array values must be strings");
    const text = ensureSafeText(item, `${path}[${index}]`);
    accountListBytes(budget, text, `${path}[${index}]`);
    result.push(text);
  }
  return result;
}

function parseScalarList(value: unknown, path: string, budget: ParseBudget): CognitionScalar[] {
  const values = ensureArray(value, path);
  if (values.length === 0) fail("invalid_value", path, "must not be empty");
  const result: CognitionScalar[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const parsed = ensureScalar(values[index], `${path}[${index}]`, budget);
    const key = valueKey(parsed);
    if (seen.has(key)) fail("invalid_value", `${path}[${index}]`, "duplicate value");
    seen.add(key);
    result.push(parsed);
  }
  result.sort((left, right) => compareCognitionUtf8(valueKey(left), valueKey(right)));
  return result;
}

function textKey(value: string): string {
  return `${utf8Bytes(value)}:${value}`;
}

function valueKey(value: CognitionValue): string {
  if (Array.isArray(value)) return `array:${value.length}:${value.map((item) => textKey(item)).join("")}`;
  if (typeof value === "string") return `string:${textKey(value)}`;
  if (typeof value === "number") {
    const number = String(value);
    return `number:${textKey(number)}`;
  }
  return `boolean:${value ? "1" : "0"}`;
}
function isCognitionScalar(value: CognitionValue): value is CognitionScalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarEqual(left: CognitionScalar, right: CognitionScalar): boolean {
  return typeof left === typeof right && left === right;
}

function valueEqual(left: CognitionValue, right: CognitionValue): boolean {
  if (!isCognitionScalar(left) || !isCognitionScalar(right)) {
    if (isCognitionScalar(left) || isCognitionScalar(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  return scalarEqual(left, right);
}

function stablePredicateKey(predicate: CognitionPredicateV1): string {
  switch (predicate.kind) {
    case "all":
      return `all:${predicate.children.length}:${predicate.children.map((child) => textKey(stablePredicateKey(child))).join("")}`;
    case "any":
      return `any:${predicate.children.length}:${predicate.children.map((child) => textKey(stablePredicateKey(child))).join("")}`;
    case "not":
      return `not:${textKey(stablePredicateKey(predicate.child))}`;
    case "generation_type":
      return `generation_type:${textKey(predicate.value)}`;
    case "phase":
      return `phase:${textKey(predicate.value)}`;
    case "preset_variable":
    case "participant_fact": {
      const value = "value" in predicate
        ? valueKey(predicate.value)
        : "values" in predicate
          ? `list:${predicate.values.length}:${predicate.values.map(valueKey).map(textKey).join("")}`
          : "";
      return `${predicate.kind}:${textKey(predicate.name)}:${textKey(predicate.operator)}:${value}`;
    }
    case "tool_available":
      return `tool_available:${textKey(predicate.toolId)}:${predicate.available ? "1" : "0"}`;
    case "task_transition":
      return `task_transition:${textKey(predicate.taskId)}:${textKey(predicate.transition)}`;
  }
}
function parsePredicateOperator(value: unknown, path: string): CognitionPredicateOperator {
  return ensureEnum(value, PREDICATE_OPERATORS, path);
}
function parseVariablePredicate(
  value: PlainRecord,
  path: string,
  kind: "preset_variable" | "participant_fact",
  budget: ParseBudget,
): CognitionPredicateV1 {
  exactKeys(value, ["kind", "name", "operator", "value", "values"], path);
  ensureEnum(value.kind, [kind], `${path}.kind`);
  const name = ensureId(value.name, `${path}.name`);
  const operator = parsePredicateOperator(value.operator, `${path}.operator`);
  if (operator === "present") {
    if (has(value, "value") || has(value, "values")) fail("unknown_key", path, "present predicates do not take a value");
    return { kind, name, operator } as CognitionPredicateV1;
  }
  if (operator === "in") {
    if (!has(value, "values") || has(value, "value")) fail("invalid_value", path, "in predicates require values only");
    return { kind, name, operator, values: parseScalarList(value.values, `${path}.values`, budget) } as CognitionPredicateV1;
  }
  if (!has(value, "value") || has(value, "values")) fail("invalid_value", path, `${operator} predicates require value only`);
  const parsed = operator === "equals"
    ? parseValue(value.value, `${path}.value`, budget)
    : ensureScalar(value.value, `${path}.value`, budget);
  return { kind, name, operator, value: parsed } as CognitionPredicateV1;
}

function parsePredicate(value: unknown, path: string, budget: ParseBudget, depth: number): CognitionPredicateV1 {
  if (depth > COGNITION_MAX_PREDICATE_DEPTH) {
    fail("limit_exceeded", path, `predicate depth must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
  }
  budget.predicateNodes += 1;
  if (budget.predicateNodes > COGNITION_MAX_PREDICATE_NODES) {
    fail("limit_exceeded", path, `predicate nodes must total at most ${COGNITION_MAX_PREDICATE_NODES}`);
  }
  const object = record(value, path);
  const kind = ensureEnum(object.kind, PREDICATE_KINDS, `${path}.kind`);
  switch (kind) {
    case "all":
    case "any": {
      exactKeys(object, ["kind", "children"], path);
      const children = ensureArray(object.children, `${path}.children`);
      const parsed = children.map((child, index) => parsePredicate(child, `${path}.children[${index}]`, budget, depth + 1));
      parsed.sort((left, right) => compareCognitionUtf8(stablePredicateKey(left), stablePredicateKey(right)));
      return { kind, children: parsed };
    }
    case "not": {
      exactKeys(object, ["kind", "child"], path);
      return { kind, child: parsePredicate(object.child, `${path}.child`, budget, depth + 1) };
    }
    case "generation_type":
      exactKeys(object, ["kind", "value"], path);
      return { kind, value: ensureEnum(object.value, GENERATION_TYPES, `${path}.value`) };
    case "phase":
      exactKeys(object, ["kind", "value"], path);
      return { kind, value: ensureEnum(object.value, PHASES, `${path}.value`) };
    case "preset_variable":
      return parseVariablePredicate(object, path, "preset_variable", budget);
    case "participant_fact":
      return parseVariablePredicate(object, path, "participant_fact", budget);
    case "tool_available":
      exactKeys(object, ["kind", "toolId", "available"], path);
      return {
        kind,
        toolId: ensureId(object.toolId, `${path}.toolId`),
        available: ensureBoolean(object.available, `${path}.available`),
      };
    case "task_transition":
      exactKeys(object, ["kind", "taskId", "transition"], path);
      return {
        kind,
        taskId: ensureId(object.taskId, `${path}.taskId`),
        transition: ensureEnum(object.transition, TASK_TRANSITIONS, `${path}.transition`),
      };
  }
}

/** Parse and canonicalize a closed predicate AST. */
export function parseCognitionPredicate(value: unknown): CognitionPredicateV1 {
  return parsePredicate(value, "predicate", { predicateNodes: 0, listBytes: 0 }, 1);
}

function parseBlockRef(value: unknown, path: string, budget: ParseBudget): CognitionLoomBlockRefV1 {
  const object = record(value, path);
  exactKeys(object, ["blockId", "expectedPresetRevision", "expectedBlockRevision"], path);
  const blockId = ensureId(object.blockId, `${path}.blockId`);
  accountListBytes(budget, blockId, `${path}.blockId`);
  return {
    blockId,
    expectedPresetRevision: ensureRevision(object.expectedPresetRevision, `${path}.expectedPresetRevision`),
    expectedBlockRevision: ensureRevision(object.expectedBlockRevision, `${path}.expectedBlockRevision`),
  };
}

function parseBlockRefs(value: unknown, path: string, budget: ParseBudget): CognitionLoomBlockRefV1[] {
  const values = ensureArray(value, path, COGNITION_MAX_BLOCK_REFS_PER_SECTION);
  const result: CognitionLoomBlockRefV1[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const ref = parseBlockRef(values[index], `${path}[${index}]`, budget);
    if (seen.has(ref.blockId)) fail("duplicate_id", `${path}[${index}].blockId`, "duplicate block reference");
    seen.add(ref.blockId);
    result.push(ref);
  }
  return result;
}

/** Version-suffixed aliases for wire validators. */
export const parseCognitionPredicateV1 = parseCognitionPredicate;
export const validateCognitionPredicateV1 = parseCognitionPredicate;

/** Explicit validation alias used by ingress callers. */
export const validateCognitionPredicate = parseCognitionPredicate;

function parsePolicyRefsWithBudget(value: unknown, budget: ParseBudget): CognitionPolicyRefsV1 {
  const object = record(value, "policies");
  exactKeys(object, ["workPolicy", "workspaceUsage", "completionCriteria", "renderPolicy"], "policies");
  const result = {
    workPolicy: parseBlockRefs(object.workPolicy, "policies.workPolicy", budget),
    workspaceUsage: parseBlockRefs(object.workspaceUsage, "policies.workspaceUsage", budget),
    completionCriteria: parseBlockRefs(object.completionCriteria, "policies.completionCriteria", budget),
    renderPolicy: parseBlockRefs(object.renderPolicy, "policies.renderPolicy", budget),
  } satisfies CognitionPolicyRefsV1;
  const total = result.workPolicy.length + result.workspaceUsage.length + result.completionCriteria.length + result.renderPolicy.length;
  if (total > COGNITION_MAX_BLOCK_REFS_TOTAL) fail("limit_exceeded", "policies", `block references must total at most ${COGNITION_MAX_BLOCK_REFS_TOTAL}`);
  return result;
}

/** Parse the four ordered Loom block-reference sections. */
export function parseCognitionPolicyRefs(value: unknown): CognitionPolicyRefsV1 {
  return parsePolicyRefsWithBudget(value, { predicateNodes: 0, listBytes: 0 });
}

function parseDependencies(value: unknown, path: string, budget: ParseBudget): string[] {
  if (value === undefined) return [];
  const values = ensureArray(value, path);
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const dependency = ensureId(values[index], `${path}[${index}]`);
    accountListBytes(budget, dependency, `${path}[${index}]`);
    if (seen.has(dependency)) fail("duplicate_id", `${path}[${index}]`, "duplicate dependency");
    seen.add(dependency);
    result.push(dependency);
  }
  result.sort(compareCognitionUtf8);
  return result;
}

function parseOptionalPredicate(value: PlainRecord, path: string, budget: ParseBudget): CognitionPredicateV1 | undefined {
  return has(value, "activation") ? parsePredicate(value.activation, `${path}.activation`, budget, 1) : undefined;
}

function parseTask(value: unknown, path: string, budget: ParseBudget): TaskTemplateV1 {
  const object = record(value, path);
  exactKeys(object, ["id", "required", "dependencies", "activation", "label", "description"], path);
  const result: TaskTemplateV1 = {
    id: ensureId(object.id, `${path}.id`),
    required: ensureBoolean(object.required, `${path}.required`),
    dependencies: parseDependencies(object.dependencies, `${path}.dependencies`, budget),
  };
  const activation = parseOptionalPredicate(object, path, budget);
  if (activation !== undefined) (result as { activation: CognitionPredicateV1 }).activation = activation;
  if (has(object, "label")) (result as { label: string }).label = ensureSafeText(object.label, `${path}.label`);
  if (has(object, "description")) (result as { description: string }).description = ensureSafeText(object.description, `${path}.description`);
  return result;
}
function parseContextRule(value: unknown, path: string, budget: ParseBudget): ContextActivationRuleV1 {
  const object = record(value, path);
  exactKeys(object, ["id", "packId", "revisionId", "required", "dependencies", "activation"], path);
  const result: ContextActivationRuleV1 = {
    id: ensureId(object.id, `${path}.id`),
    packId: ensureId(object.packId, `${path}.packId`),
    revisionId: ensureId(object.revisionId, `${path}.revisionId`),
    required: ensureBoolean(object.required, `${path}.required`),
    dependencies: parseDependencies(object.dependencies, `${path}.dependencies`, budget),
  };
  const activation = parseOptionalPredicate(object, path, budget);
  if (activation !== undefined) (result as { activation: CognitionPredicateV1 }).activation = activation;
  return result;
}

/** Standalone strict parser for editor/import validation. */
export function parseTaskTemplate(value: unknown): TaskTemplateV1 {
  return parseTask(value, "template", { predicateNodes: 0, listBytes: 0 });
}

/** Standalone strict parser for context-library activation rules. */
export function parseContextActivationRule(value: unknown): ContextActivationRuleV1 {
  return parseContextRule(value, "contextRule", { predicateNodes: 0, listBytes: 0 });
}

/** Parse the complete authored graph with one shared cap budget. */
export function parseCognitionGraph(value: unknown): CognitionGraphV1 {
  const object = record(value, "graph");
  exactKeys(object, ["version", "policies", "templates", "contextRules"], "graph");
  if (object.version !== AGENT_COGNITION_VERSION) fail("invalid_value", "graph.version", "unsupported cognition version");
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const templatesRaw = ensureArray(object.templates, "graph.templates", COGNITION_MAX_TASK_TEMPLATES);
  const contextRaw = ensureArray(object.contextRules, "graph.contextRules", COGNITION_MAX_CONTEXT_RULES);
  const templates = templatesRaw.map((item, index) => parseTask(item, `graph.templates[${index}]`, budget));
  const contextRules = contextRaw.map((item, index) => parseContextRule(item, `graph.contextRules[${index}]`, budget));
  assertUniqueIds(templates.map((item) => item.id), "graph.templates");
  assertUniqueIds(contextRules.map((item) => item.id), "graph.contextRules");
  templates.sort((left, right) => compareCognitionUtf8(left.id, right.id));
  contextRules.sort((left, right) => compareCognitionUtf8(left.id, right.id));
  return {
    version: AGENT_COGNITION_VERSION,
    policies: parsePolicyRefsWithBudget(object.policies, budget),
    templates,
    contextRules,
  };
}

function assertUniqueIds(ids: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail("duplicate_id", path, `duplicate id ${id}`);
    seen.add(id);
  }
}

/** Parse a source snapshot supplied by the host before isolate execution. */
export function parseCognitionSourceSnapshot(value: unknown): CognitionSourceSnapshotV1 {
  const object = record(value, "source");
  exactKeys(object, ["presetRevision", "blocks"], "source");
  const blocksRaw = ensureArray(object.blocks, "source.blocks", COGNITION_MAX_SOURCE_BLOCKS);
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const blocks: CognitionSourceBlockV1[] = blocksRaw.map((item, index) => {
    const block = record(item, `source.blocks[${index}]`);
    exactKeys(block, ["blockId", "revision", "promptOrder"], `source.blocks[${index}]`);
    const blockId = ensureId(block.blockId, `source.blocks[${index}].blockId`);
    accountListBytes(budget, blockId, `source.blocks[${index}].blockId`);
    return {
      blockId,
      revision: ensureRevision(block.revision, `source.blocks[${index}].revision`),
      promptOrder: ensureRevision(block.promptOrder, `source.blocks[${index}].promptOrder`),
    };
  });
  assertUniqueIds(blocks.map((item) => item.blockId), "source.blocks");
  assertUniqueIds(blocks.map((item) => String(item.promptOrder)), "source.blocks.promptOrder");
  blocks.sort((left, right) => compareNumber(left.promptOrder, right.promptOrder) || compareCognitionUtf8(left.blockId, right.blockId));
  return { presetRevision: ensureRevision(object.presetRevision, "source.presetRevision"), blocks };
}

function parseEvaluationRecord(value: unknown, path: string, budget: ParseBudget): Record<string, CognitionValue> {
  const object = record(value, path);
  const result: Record<string, CognitionValue> = Object.create(null);
  const keys = Object.keys(object).sort(compareCognitionUtf8);
  for (const key of keys) {
    const id = ensureId(key, `${path}.${key}`);
    accountListBytes(budget, id, `${path}.${key}`);
    result[id] = parseValue(object[key], `${path}.${key}`, budget);
  }
  return result;
}

/** Parse/freeze the serializable snapshot consumed by predicate evaluation. */
export function parseCognitionEvaluationContext(value: unknown): CognitionEvaluationContextV1 {
  const object = record(value, "context");
  exactKeys(object, ["generationType", "phase", "presetVariables", "participantFacts", "availableTools", "taskTransitions"], "context");
  const budget: ParseBudget = { predicateNodes: 0, listBytes: 0 };
  const toolsRaw = ensureArray(object.availableTools, "context.availableTools");
  const tools: string[] = [];
  const seenTools = new Set<string>();
  for (let index = 0; index < toolsRaw.length; index += 1) {
    const tool = ensureId(toolsRaw[index], `context.availableTools[${index}]`);
    accountListBytes(budget, tool, `context.availableTools[${index}]`);
    if (seenTools.has(tool)) fail("duplicate_id", `context.availableTools[${index}]`, "duplicate tool id");
    seenTools.add(tool);
    tools.push(tool);
  }
  tools.sort(compareCognitionUtf8);
  const transitionsObject = record(object.taskTransitions, "context.taskTransitions");
  const transitionKeys = Object.keys(transitionsObject).sort(compareCognitionUtf8);
  if (transitionKeys.length > COGNITION_MAX_LIST_ITEMS) {
    fail("limit_exceeded", "context.taskTransitions", `must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);
  }
  const taskTransitions: Record<string, CognitionTaskTransition> = Object.create(null);
  for (const key of transitionKeys) {
    const taskId = ensureId(key, `context.taskTransitions.${key}`);
    accountListBytes(budget, taskId, `context.taskTransitions.${key}`);
    taskTransitions[taskId] = ensureEnum(transitionsObject[key], TASK_TRANSITIONS, `context.taskTransitions.${key}`);
  }
  return deepFreeze({
    generationType: ensureEnum(object.generationType, GENERATION_TYPES, "context.generationType"),
    phase: ensureEnum(object.phase, PHASES, "context.phase"),
    presetVariables: parseEvaluationRecord(object.presetVariables, "context.presetVariables", budget),
    participantFacts: parseEvaluationRecord(object.participantFacts, "context.participantFacts", budget),
    availableTools: tools,
    taskTransitions,
  });
}

function dependencyClosure(
  ids: readonly string[],
  dependencies: ReadonlyMap<string, readonly string[]>,
  path: string,
): Readonly<Record<string, readonly string[]>> {
  const known = new Set(ids);
  const state = new Map<string, 0 | 1 | 2>();
  const closure = new Map<string, string[]>();
  const visit = (id: string): string[] => {
    const current = state.get(id);
    if (current === 1) fail("cycle", `${path}.${id}`, "dependency cycle");
    if (current === 2) return closure.get(id) ?? [];
    if (!known.has(id)) fail("missing_reference", `${path}.${id}`, "dependency references a missing node");
    state.set(id, 1);
    const values = new Set<string>();
    for (const dependency of dependencies.get(id) ?? []) {
      if (!known.has(dependency)) fail("missing_reference", `${path}.${id}`, `missing dependency ${dependency}`);
      values.add(dependency);
      for (const nested of visit(dependency)) values.add(nested);
    }
    const sorted = [...values].sort(compareCognitionUtf8);
    state.set(id, 2);
    closure.set(id, sorted);
    return sorted;
  };
  for (const id of ids) visit(id);
  const result: Record<string, readonly string[]> = Object.create(null);
  for (const id of [...ids].sort(compareCognitionUtf8)) result[id] = closure.get(id) ?? [];
  return result;
}

function normalizePolicyRefs(
  policies: CognitionPolicyRefsV1,
  source: CognitionSourceSnapshotV1,
): { policies: CognitionPolicyRefsV1; blockRevisions: CognitionFrozenSourceRevisionsV1["blockRevisions"] } {
  const sourceById = new Map(source.blocks.map((block) => [block.blockId, block] as const));
  const selected = new Map<string, number>();
  const normalize = (refs: readonly CognitionLoomBlockRefV1[], path: string): CognitionLoomBlockRefV1[] => {
    const result: Array<CognitionLoomBlockRefV1 & { promptOrder: number }> = [];
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const block = sourceById.get(ref.blockId);
      if (!block) fail("missing_reference", `${path}[${index}].blockId`, "Loom block is missing from the source snapshot");
      if (ref.expectedPresetRevision !== source.presetRevision) {
        fail("revision_mismatch", `${path}[${index}].expectedPresetRevision`, "preset revision does not match the frozen source");
      }
      if (ref.expectedBlockRevision !== block.revision) {
        fail("revision_mismatch", `${path}[${index}].expectedBlockRevision`, "block revision does not match the frozen source");
      }
      selected.set(ref.blockId, block.revision);
      result.push({ ...ref, promptOrder: block.promptOrder });
    }
    result.sort((left, right) => compareNumber(left.promptOrder, right.promptOrder) || compareCognitionUtf8(left.blockId, right.blockId));
    return result.map(({ promptOrder: _promptOrder, ...ref }) => ref);
  };
  const normalized = {
    workPolicy: normalize(policies.workPolicy, "policies.workPolicy"),
    workspaceUsage: normalize(policies.workspaceUsage, "policies.workspaceUsage"),
    completionCriteria: normalize(policies.completionCriteria, "policies.completionCriteria"),
    renderPolicy: normalize(policies.renderPolicy, "policies.renderPolicy"),
  } satisfies CognitionPolicyRefsV1;
  const blockRevisions = [...selected.entries()]
    .map(([blockId, revision]) => ({ blockId, revision }))
    .sort((left, right) => compareCognitionUtf8(left.blockId, right.blockId));
  return { policies: normalized, blockRevisions };
}

/**
 * Validate dependencies and expected source revisions, then deep-freeze the
 * graph.  The returned graph is the only graph accepted by activation helpers.
 */
export function freezeCognitionGraph(
  graphValue: unknown,
  sourceValue: unknown,
): FrozenCognitionGraphV1 {
  const graph = parseCognitionGraph(graphValue);
  const source = parseCognitionSourceSnapshot(sourceValue);
  const templateIds = graph.templates.map((template) => template.id);
  const contextIds = graph.contextRules.map((rule) => rule.id);
  const templateDependencies = new Map(graph.templates.map((template) => [template.id, template.dependencies ?? []] as const));
  const contextDependencies = new Map(graph.contextRules.map((rule) => [rule.id, rule.dependencies ?? []] as const));
  const templateDependencyClosure = dependencyClosure(templateIds, templateDependencies, "graph.templates");
  const contextDependencyClosure = dependencyClosure(contextIds, contextDependencies, "graph.contextRules");
  const requiredTemplateIds = graph.templates.filter((template) => template.required).map((template) => template.id);
  const requiredContextIds = graph.contextRules.filter((rule) => rule.required).map((rule) => rule.id);
  const requiredTemplateSet = new Set<string>();
  for (const id of requiredTemplateIds) {
    requiredTemplateSet.add(id);
    for (const dependency of templateDependencyClosure[id] ?? []) requiredTemplateSet.add(dependency);
  }
  const requiredContextSet = new Set<string>();
  for (const id of requiredContextIds) {
    requiredContextSet.add(id);
    for (const dependency of contextDependencyClosure[id] ?? []) requiredContextSet.add(dependency);
  }
  const normalized = normalizePolicyRefs(graph.policies, source);
  const frozen: FrozenCognitionGraphV1 = {
    version: AGENT_COGNITION_VERSION,
    policies: normalized.policies,
    templates: graph.templates,
    contextRules: graph.contextRules,
    sourceRevisions: {
      presetRevision: source.presetRevision,
      blockRevisions: normalized.blockRevisions,
    },
    templateDependencyClosure,
    contextDependencyClosure,
    requiredTemplateClosure: [...requiredTemplateSet].sort(compareCognitionUtf8),
    requiredContextClosure: [...requiredContextSet].sort(compareCognitionUtf8),
  };
  return deepFreeze(frozen);
}
export const freezeCognitionGraphV1 = freezeCognitionGraph;
export interface AgentCognitionLoaderV1 {
  readonly config: unknown;
  readonly contextRules: readonly unknown[];
  readonly taskTemplates: readonly unknown[];
  readonly selections: readonly unknown[];
}

export interface AgentCognitionPhasePolicyV1 {
  readonly work: readonly CognitionLoomBlockRefV1[];
  readonly render: readonly CognitionLoomBlockRefV1[];
}

export interface FrozenAgentCognitionV1 {
  readonly graph: FrozenCognitionGraphV1;
  readonly source: CognitionSourceSnapshotV1;
  readonly contextPackSelections: readonly {
    readonly packId: string;
    readonly revisionId: string;
    readonly digest: string;
    readonly required: boolean;
  }[];
  readonly phasePolicy: AgentCognitionPhasePolicyV1;
}

const EMPTY_COGNITION_POLICY: CognitionPolicyRefsV1 = Object.freeze({
  workPolicy: Object.freeze([]),
  workspaceUsage: Object.freeze([]),
  completionCriteria: Object.freeze([]),
  renderPolicy: Object.freeze([]),
});

function parseAgentContextSelections(value: unknown): FrozenAgentCognitionV1["contextPackSelections"] {
  if (!Array.isArray(value)) fail("invalid_type", "loader.selections", "must be an array");
  const seen = new Set<string>();
  const selections = value.map((entry, index) => {
    const object = record(entry, `loader.selections[${index}]`);
    exactKeys(object, ["packId", "revisionId", "digest", "required"], `loader.selections[${index}]`);
    const packId = ensureId(object.packId, `loader.selections[${index}].packId`);
    const revisionId = ensureId(object.revisionId, `loader.selections[${index}].revisionId`);
    const digest = ensureSafeText(object.digest, `loader.selections[${index}].digest`, 128);
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) fail("invalid_value", `loader.selections[${index}].digest`, "must be a SHA-256 digest");
    const required = ensureBoolean(object.required, `loader.selections[${index}].required`);
    const key = `${packId}\u0000${revisionId}`;
    if (seen.has(key)) fail("duplicate_id", `loader.selections[${index}]`, "duplicate context pack selection");
    seen.add(key);
    return Object.freeze({ packId, revisionId, digest: digest.toLowerCase(), required });
  });
  selections.sort((left, right) => compareCognitionUtf8(left.packId, right.packId) || compareCognitionUtf8(left.revisionId, right.revisionId));
  return Object.freeze(selections);
}

function parseAgentPhasePolicy(value: unknown, source: CognitionSourceSnapshotV1): AgentCognitionPhasePolicyV1 {
  if (value === undefined || value === null) return Object.freeze({ work: Object.freeze([]), render: Object.freeze([]) });
  const object = record(value, "config.phasePolicy");
  exactKeys(object, ["work", "render"], "config.phasePolicy");
  const parsed = parseCognitionPolicyRefs({
    workPolicy: object.work,
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: object.render,
  });
  const frozen = freezeCognitionGraph({
    version: AGENT_COGNITION_VERSION,
    policies: parsed,
    templates: [],
    contextRules: [],
  }, source);
  return Object.freeze({
    work: Object.freeze([...frozen.policies.workPolicy]),
    render: Object.freeze([...frozen.policies.renderPolicy]),
  });
}

/**
 * Convert the authenticated normalized loader output into the sole frozen
 * cognition authority consumed by Agentic assembly/runtime. This function is
 * pure: it performs no DB/Spindle reads and never fills missing authored data.
 */
export function freezeAgentCognitionV1(
  loader: AgentCognitionLoaderV1,
  sourceValue: unknown,
): FrozenAgentCognitionV1 | null {
  if (!loader || typeof loader !== "object" || Array.isArray(loader)) fail("invalid_type", "loader", "must be an object");
  if (!Array.isArray(loader.contextRules)) fail("invalid_type", "loader.contextRules", "must be an array");
  if (!Array.isArray(loader.taskTemplates)) fail("invalid_type", "loader.taskTemplates", "must be an array");
  if (!Array.isArray(loader.selections)) fail("invalid_type", "loader.selections", "must be an array");
  const source = parseCognitionSourceSnapshot(sourceValue);
  const config = loader.config === null || loader.config === undefined ? {} : record(loader.config, "loader.config");
  const cognitionPolicy = config.cognitionPolicy === undefined ? EMPTY_COGNITION_POLICY : parseCognitionPolicyRefs(config.cognitionPolicy);
  const phasePolicy = parseAgentPhasePolicy(config.phasePolicy, source);
  const selections = parseAgentContextSelections(loader.selections);
  const hasContextPolicy = config.contextPolicy !== undefined
    && isPlainRecord(config.contextPolicy)
    && Array.isArray(config.contextPolicy.packIds)
    && config.contextPolicy.packIds.length > 0;
  const hasCognitionPolicy = Object.values(cognitionPolicy).some((refs) => refs.length > 0);
  const hasPhasePolicy = phasePolicy.work.length > 0 || phasePolicy.render.length > 0;
  const hasPolicy = hasCognitionPolicy || hasContextPolicy || loader.contextRules.length > 0 || loader.taskTemplates.length > 0 || selections.length > 0 || hasPhasePolicy;
  if (!hasPolicy) return null;
  const graph = freezeCognitionGraph({
    version: AGENT_COGNITION_VERSION,
    policies: cognitionPolicy,
    templates: loader.taskTemplates,
    contextRules: loader.contextRules,
  }, source);
  return Object.freeze({ graph, source, contextPackSelections: selections, phasePolicy });
}


function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseActivationState(value: CognitionActivationStateV1, graph: FrozenCognitionGraphV1): CognitionActivationStateV1 {
  const object = record(value, "state");
  exactKeys(object, ["version", "workspaceRevision", "activatedTemplateIds", "activatedContextRuleIds", "requiredTemplateIds", "requiredContextRuleIds"], "state");
  if (object.version !== AGENT_COGNITION_VERSION) fail("invalid_state", "state.version", "unsupported cognition version");
  const workspaceRevision = ensureRevision(object.workspaceRevision, "state.workspaceRevision");
  const parseIds = (raw: unknown, path: string, known: ReadonlySet<string>): string[] => {
    const values = ensureArray(raw, path, COGNITION_MAX_TASK_TEMPLATES);
    const result: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < values.length; index += 1) {
      const id = ensureId(values[index], `${path}[${index}]`);
      if (seen.has(id)) fail("invalid_state", `${path}[${index}]`, "duplicate id");
      if (!known.has(id)) fail("invalid_state", `${path}[${index}]`, "unknown graph id");
      seen.add(id);
      result.push(id);
    }
    result.sort(compareCognitionUtf8);
    return result;
  };
  const templateIds = new Set(graph.templates.map((template) => template.id));
  const contextIds = new Set(graph.contextRules.map((rule) => rule.id));
  const activatedTemplateIds = parseIds(object.activatedTemplateIds, "state.activatedTemplateIds", templateIds);
  const activatedContextRuleIds = parseIds(object.activatedContextRuleIds, "state.activatedContextRuleIds", contextIds);
  const requiredTemplateIds = parseIds(object.requiredTemplateIds, "state.requiredTemplateIds", templateIds);
  const requiredContextRuleIds = parseIds(object.requiredContextRuleIds, "state.requiredContextRuleIds", contextIds);
  for (const id of requiredTemplateIds) if (!activatedTemplateIds.includes(id)) fail("invalid_state", "state.requiredTemplateIds", "required task is not activated");
  for (const id of requiredContextRuleIds) if (!activatedContextRuleIds.includes(id)) fail("invalid_state", "state.requiredContextRuleIds", "required context rule is not activated");
  const activatedTemplateSet = new Set(activatedTemplateIds);
  const activatedContextSet = new Set(activatedContextRuleIds);
  for (const id of activatedTemplateIds) {
    for (const dependency of graph.templateDependencyClosure[id] ?? []) {
      if (!activatedTemplateSet.has(dependency)) fail("invalid_state", "state.activatedTemplateIds", "activated task is missing a dependency");
    }
  }
  for (const id of activatedContextRuleIds) {
    for (const dependency of graph.contextDependencyClosure[id] ?? []) {
      if (!activatedContextSet.has(dependency)) fail("invalid_state", "state.activatedContextRuleIds", "activated context rule is missing a dependency");
    }
  }
  const requiredTemplateSet = new Set(requiredTemplateIds);
  const requiredContextSet = new Set(requiredContextRuleIds);
  for (const id of requiredTemplateIds) {
    for (const dependency of graph.templateDependencyClosure[id] ?? []) {
      if (!requiredTemplateSet.has(dependency)) fail("invalid_state", "state.requiredTemplateIds", "required task is missing a dependency");
    }
  }
  for (const id of requiredContextRuleIds) {
    for (const dependency of graph.contextDependencyClosure[id] ?? []) {
      if (!requiredContextSet.has(dependency)) fail("invalid_state", "state.requiredContextRuleIds", "required context rule is missing a dependency");
    }
  }
  const inducedRequiredTemplates = activateIds(
    [],
    graph.templates.filter((template) => template.required && activatedTemplateSet.has(template.id)).map((template) => template.id),
    graph.templateDependencyClosure,
  );
  const inducedRequiredContexts = activateIds(
    [],
    graph.contextRules.filter((rule) => rule.required && activatedContextSet.has(rule.id)).map((rule) => rule.id),
    graph.contextDependencyClosure,
  );
  if (
    inducedRequiredTemplates.length !== requiredTemplateIds.length ||
    inducedRequiredTemplates.some((id, index) => id !== requiredTemplateIds[index])
  ) {
    fail("required_closure_invalid", "state.requiredTemplateIds", "required tasks do not match activated authored required closure");
  }
  if (
    inducedRequiredContexts.length !== requiredContextRuleIds.length ||
    inducedRequiredContexts.some((id, index) => id !== requiredContextRuleIds[index])
  ) {
    fail("required_closure_invalid", "state.requiredContextRuleIds", "required context rules do not match activated authored required closure");
  }
  return deepFreeze({
    version: AGENT_COGNITION_VERSION,
    workspaceRevision,
    activatedTemplateIds,
    activatedContextRuleIds,
    requiredTemplateIds,
    requiredContextRuleIds,
  });
}

function evaluationContext(value: CognitionEvaluationContextV1): CognitionEvaluationContextV1 {
  return parseCognitionEvaluationContext(value);
}

function evaluateVariablePredicate(
  predicate: Extract<CognitionPredicateV1, { kind: "preset_variable" | "participant_fact" }>,
  values: Readonly<Record<string, CognitionValue>>,
): boolean {
  const present = OBJECT_PROTO.hasOwnProperty.call(values, predicate.name);
  if (predicate.operator === "present") return present;
  if (!present) return false;
  const actual = values[predicate.name];
  if (predicate.operator === "equals") return valueEqual(actual, predicate.value);
  if (predicate.operator === "in") {
    if (!isCognitionScalar(actual)) return actual.some((item) => predicate.values.some((expected) => scalarEqual(item, expected)));
    return predicate.values.some((expected) => scalarEqual(actual, expected));
  }
  return !isCognitionScalar(actual) && actual.some((item) => scalarEqual(item, predicate.value));
}

/** Pure, closed AST evaluator.  It has no clock, randomness, regex, macros, DB, or callbacks. */
export function evaluateCognitionPredicate(
  predicateValue: unknown,
  contextValue: CognitionEvaluationContextV1,
): boolean {
  const predicate = parseCognitionPredicate(predicateValue);
  const context = evaluationContext(contextValue);
  const evaluate = (node: CognitionPredicateV1): boolean => {
    switch (node.kind) {
      case "all":
        for (const child of node.children) if (!evaluate(child)) return false;
        return true;
      case "any":
        for (const child of node.children) if (evaluate(child)) return true;
        return false;
      case "not":
        return !evaluate(node.child);
      case "generation_type":
        return context.generationType === node.value;
      case "phase":
        return context.phase === node.value;
      case "preset_variable":
        return evaluateVariablePredicate(node, context.presetVariables);
      case "participant_fact":
        return evaluateVariablePredicate(node, context.participantFacts);
      case "tool_available":
        return context.availableTools.includes(node.toolId) === node.available;
      case "task_transition":
        return context.taskTransitions[node.taskId] === node.transition;
    }
  };
  return evaluate(predicate);
}
export const evaluateCognitionPredicateV1 = evaluateCognitionPredicate;

function createEmptyActivationState(): CognitionActivationStateV1 {
  return {
    version: AGENT_COGNITION_VERSION,
    workspaceRevision: 0,
    activatedTemplateIds: [],
    activatedContextRuleIds: [],
    requiredTemplateIds: [],
    requiredContextRuleIds: [],
  };
}

/** Create an empty append-only state for the frozen graph. */
export function createCognitionActivationState(
  graph: FrozenCognitionGraphV1,
  workspaceRevision = 0,
): CognitionActivationStateV1 {
  const state = parseActivationState({ ...createEmptyActivationState(), workspaceRevision }, graph);
  return state;
}

function activateIds(
  existing: readonly string[],
  direct: readonly string[],
  closure: Readonly<Record<string, readonly string[]>>,
): string[] {
  const result = new Set(existing);
  for (const id of direct) {
    result.add(id);
    for (const dependency of closure[id] ?? []) result.add(dependency);
  }
  return [...result].sort(compareCognitionUtf8);
}

function difference(after: readonly string[], before: readonly string[]): string[] {
  const previous = new Set(before);
  return after.filter((id) => !previous.has(id));
}
function activateAtPointInternal(
  graph: FrozenCognitionGraphV1,
  stateValue: CognitionActivationStateV1,
  contextValue: CognitionEvaluationContextV1,
  point: CognitionActivationPointV1,
  roots?: CognitionActivationRootsV1,
): CognitionActivationResultV1 {
  const state = parseActivationState(stateValue, graph);
  const context = evaluationContext(contextValue);
  const templateRoots = roots === undefined ? undefined : new Set(roots.templateIds);
  const contextRoots = roots === undefined ? undefined : new Set(roots.contextRuleIds);
  const directTemplates = graph.templates
    .filter((template) => !state.activatedTemplateIds.includes(template.id))
    .filter((template) => templateRoots === undefined || templateRoots.has(template.id))
    .filter((template) => template.activation === undefined || evaluateCognitionPredicate(template.activation, context))
    .map((template) => template.id)
    .sort(compareCognitionUtf8);
  const directContext = graph.contextRules
    .filter((rule) => !state.activatedContextRuleIds.includes(rule.id))
    .filter((rule) => contextRoots === undefined || contextRoots.has(rule.id))
    .filter((rule) => rule.activation === undefined || evaluateCognitionPredicate(rule.activation, context))
    .map((rule) => rule.id)
    .sort(compareCognitionUtf8);
  const activatedTemplateIds = activateIds(state.activatedTemplateIds, directTemplates, graph.templateDependencyClosure);
  const activatedContextRuleIds = activateIds(state.activatedContextRuleIds, directContext, graph.contextDependencyClosure);
  const requiredTemplateRoots = graph.templates.filter((template) => template.required && activatedTemplateIds.includes(template.id)).map((template) => template.id);
  const requiredContextRoots = graph.contextRules.filter((rule) => rule.required && activatedContextRuleIds.includes(rule.id)).map((rule) => rule.id);
  const requiredTemplateIds = activateIds([], requiredTemplateRoots, graph.templateDependencyClosure);
  const requiredContextRuleIds = activateIds([], requiredContextRoots, graph.contextDependencyClosure);
  const nextState = deepFreeze({
    version: AGENT_COGNITION_VERSION,
    workspaceRevision: state.workspaceRevision,
    activatedTemplateIds,
    activatedContextRuleIds,
    requiredTemplateIds,
    requiredContextRuleIds,
  });
  return {
    point,
    state: nextState,
    newlyActivatedTemplateIds: difference(activatedTemplateIds, state.activatedTemplateIds),
    newlyActivatedContextRuleIds: difference(activatedContextRuleIds, state.activatedContextRuleIds),
    newlyRequiredTemplateIds: difference(requiredTemplateIds, state.requiredTemplateIds),
    newlyRequiredContextRuleIds: difference(requiredContextRuleIds, state.requiredContextRuleIds),
  };
}

/** Evaluate append-only activation at initial creation, phase entry, or a task transition. */
export function activateCognitionAtPoint(
  graph: FrozenCognitionGraphV1,
  state: CognitionActivationStateV1,
  context: CognitionEvaluationContextV1,
  point: CognitionActivationPointV1,
  roots?: CognitionActivationRootsV1,
): CognitionActivationResultV1 {
  return activateAtPointInternal(graph, state, context, point, roots);
}

/** Alias used by workspace services that call the operation "activate". */
export const activateCognition = activateCognitionAtPoint;

/**
 * Run bounded activation to a fixed point before completion.  Required tasks
 * newly activated by this pass are returned as blockers until accepted/done.
 */
export function completeCognitionFixedPoint(
  graph: FrozenCognitionGraphV1,
  state: CognitionActivationStateV1,
  context: CognitionEvaluationContextV1,
  roots?: CognitionActivationRootsV1,
): CognitionCompletionResultV1 {
  let current = activateAtPointInternal(graph, state, context, "completion_fixed_point", roots);
  let iterations = 1;
  // One extra pass proves stability after the final activation.  The number
  // of state-changing passes remains bounded by the frozen graph node count.
  const maxIterations = Math.max(1, graph.templates.length + graph.contextRules.length + 1);
  while (current.newlyActivatedTemplateIds.length > 0 || current.newlyActivatedContextRuleIds.length > 0) {
    if (iterations >= maxIterations) fail("fixed_point_limit_exceeded", "completion", "activation did not reach a bounded fixed point");
    iterations += 1;
    current = activateAtPointInternal(graph, current.state, context, "completion_fixed_point", roots);
  }
  const transitions = context.taskTransitions;
  const blockingRequiredTaskIds = current.state.requiredTemplateIds
    .filter((taskId) => transitions[taskId] !== "accepted" && transitions[taskId] !== "done")
    .sort(compareCognitionUtf8);
  return {
    ...current,
    newlyActivatedTemplateIds: difference(current.state.activatedTemplateIds, state.activatedTemplateIds),
    newlyActivatedContextRuleIds: difference(current.state.activatedContextRuleIds, state.activatedContextRuleIds),
    newlyRequiredTemplateIds: difference(current.state.requiredTemplateIds, state.requiredTemplateIds),
    newlyRequiredContextRuleIds: difference(current.state.requiredContextRuleIds, state.requiredContextRuleIds),
    fixedPointIterations: iterations,
    blockingRequiredTaskIds,
    canComplete: blockingRequiredTaskIds.length === 0,
    state: current.state,
  };
}

/** Alias for callers that name the operation "run completion activation". */
export const runCognitionCompletionFixedPoint = completeCognitionFixedPoint;

/**
 * Apply a named workspace task transition and cognition activation in one CAS.
 * The workspace service owns the transaction; this function supplies its one
 * updater and never performs a second read/write after commit.
 */
export function applyCognitionTaskTransitionInCas(
  graph: FrozenCognitionGraphV1,
  state: CognitionActivationStateV1,
  context: CognitionEvaluationContextV1,
  taskIdValue: string,
  transitionValue: CognitionTaskTransition,
  cas: CognitionWorkspaceCasV1,
): CognitionTaskTransitionResultV1 {
  const taskId = ensureId(taskIdValue, "taskId");
  const transition = ensureEnum(transitionValue, TASK_TRANSITIONS, "transition");
  const initialState = parseActivationState(state, graph);
  const parsedContext = parseCognitionEvaluationContext(context);
  let activation: CognitionActivationResultV1 | undefined;
  const committed = cas.commit(initialState.workspaceRevision, (current) => {
    const currentState = parseActivationState(current, graph);
    const nextTransitions: Record<string, CognitionTaskTransition> = Object.create(null);
    for (const [existingTaskId, existingTransition] of Object.entries(parsedContext.taskTransitions)) {
      nextTransitions[existingTaskId] = existingTransition;
    }
    nextTransitions[taskId] = transition;
    activation = activateAtPointInternal(
      graph,
      currentState,
      { ...parsedContext, taskTransitions: nextTransitions },
      "task_transition",
    );
    return {
      ...activation.state,
      workspaceRevision: currentState.workspaceRevision + 1,
    };
  });
  if (!activation) fail("cas_conflict", "cas", "workspace CAS did not invoke its updater");
  const committedState = parseActivationState(committed, graph);
  return {
    taskId,
    transition,
    state: committedState,
    activation: { ...activation, state: committedState },
  };
}

/** Alias used by workspace services that call the operation "transition". */
export const transitionTaskWithCognition = applyCognitionTaskTransitionInCas;

/** Expose the closed enums for route/editor validators without mutable arrays. */
export const COGNITION_GENERATION_TYPES = Object.freeze([...GENERATION_TYPES]);
export const COGNITION_PHASES = Object.freeze([...PHASES]);
export const COGNITION_TASK_TRANSITIONS = Object.freeze([...TASK_TRANSITIONS]);
