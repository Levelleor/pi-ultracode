/**
 * Opt-in host capabilities for workflow scripts.
 *
 * Providers run in the trusted Pi/SDK host, never in the workflow VM. A
 * capability is callable only when the provider registers it, the workflow
 * declares it, the project is trusted, and the host grants it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Value } from "typebox/value";
import { WorkflowAbortError, WorkflowPolicyError } from "./admission.ts";
import { type RunJournal, hashString, stableStringify } from "./journal.ts";
import { jsonSchemaToTypeBox } from "./json-schema.ts";
import {
  assertJsonByteLimit,
  assertWorkflowSchemaLimit,
  MAX_WORKFLOW_ARGS_BYTES,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "./value-limits.ts";

export const HOST_CAPABILITIES_COLLECT_EVENT = "ultracode:host-capabilities:collect";
const NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const MAX_TIMEOUT_MS = 600_000;

export interface WorkflowHostCapabilityContext {
  /** The workflow's target directory, validated by the runtime. */
  readonly cwd: string;
  /** The identity of the trusted repository/cwd target. */
  readonly targetIdentity: string;
  readonly signal: AbortSignal;
  /** Stable across resumes; providers may use it as an idempotency key. */
  readonly callId: string;
}

export interface WorkflowHostCapability {
  /** Namespace-qualified operation, e.g. "tests.run". */
  readonly name: string;
  /** Included in the immutable call identity. Increment when semantics change. */
  readonly version: string;
  /** Read calls can safely be retried after an interrupted invocation. */
  readonly effect: "read" | "write";
  readonly inputSchema?: unknown;
  /** Default 120 seconds. */
  readonly timeoutMs?: number;
  /** Return a JSON value or a Promise of one. */
  execute(input: unknown, context: WorkflowHostCapabilityContext): unknown;
}

/** No global registration: each workflow run receives its own snapshot. */
export class WorkflowHostCapabilityRegistry {
  private readonly definitions = new Map<string, WorkflowHostCapability>();

  register(definition: WorkflowHostCapability): void {
    validateHostCapability(definition);
    if (this.definitions.has(definition.name)) {
      throw new WorkflowPolicyError(`duplicate workflow host capability: ${definition.name}`);
    }
    this.definitions.set(definition.name, Object.freeze({ ...definition }));
  }

  snapshot(): readonly WorkflowHostCapability[] {
    return Object.freeze([...this.definitions.values()]);
  }
}

export function validateHostCapability(value: WorkflowHostCapability): void {
  if (!value || !isHostCapabilityName(value.name)) {
    throw new WorkflowPolicyError("host capability name must be namespaced, e.g. 'tests.run'");
  }
  if (typeof value.version !== "string" || !value.version.trim() || value.version.length > 64) {
    throw new WorkflowPolicyError(`host capability '${value.name}' requires a version`);
  }
  if (value.effect !== "read" && value.effect !== "write") {
    throw new WorkflowPolicyError(`host capability '${value.name}' requires read/write effect`);
  }
  if (typeof value.execute !== "function") {
    throw new WorkflowPolicyError(`host capability '${value.name}' requires execute()`);
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new WorkflowPolicyError(`host capability '${value.name}' has invalid timeoutMs`);
  }
  if (value.inputSchema !== undefined) assertWorkflowSchemaLimit(value.inputSchema);
}

export function isHostCapabilityName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 128 && NAME.test(name);
}

export function assertHostCapabilityInput(
  capability: WorkflowHostCapability,
  input: unknown,
): void {
  assertJsonByteLimit(input, `hostCall '${capability.name}' input`, MAX_WORKFLOW_ARGS_BYTES);
  if (
    capability.inputSchema !== undefined &&
    !Value.Check(jsonSchemaToTypeBox(capability.inputSchema), input)
  ) {
    throw new WorkflowPolicyError(`hostCall '${capability.name}' input does not match its schema`);
  }
}

export function assertHostCapabilityOutput(name: string, output: unknown): void {
  assertJsonByteLimit(output, `hostCall '${name}' result`, MAX_STRUCTURED_OUTPUT_BYTES);
}

export function assertHostCapabilityAllowed(
  name: string,
  declared: unknown,
  projectTrusted: boolean,
  grants: readonly string[],
): void {
  if (!projectTrusted) throw new WorkflowPolicyError("hostCall requires a trusted project");
  if (!Array.isArray(declared) || !declared.includes(name)) {
    throw new WorkflowPolicyError(`hostCall '${name}' was not declared in meta.hostCapabilities`);
  }
  if (!grants.includes(name)) {
    throw new WorkflowPolicyError(`hostCall '${name}' is not authorised by the host`);
  }
}

export interface HostCapabilityCollector {
  register(capability: WorkflowHostCapability): void;
}

/** Pi's event bus delivers listeners synchronously until their first await.
 * Late registrations are rejected and duplicate/invalid registrations fail
 * the collection, despite Pi's event bus swallowing listener exceptions.
 */
export function collectHostCapabilities(events: {
  emit(channel: string, payload: unknown): void;
}): readonly WorkflowHostCapability[] {
  const registry = new WorkflowHostCapabilityRegistry();
  const failures: unknown[] = [];
  let collecting = true;
  const collector: HostCapabilityCollector = {
    register(capability) {
      if (!collecting) throw new WorkflowPolicyError("host capability registration is closed");
      try {
        registry.register(capability);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
  };
  events.emit(HOST_CAPABILITIES_COLLECT_EVENT, collector);
  collecting = false;
  if (failures.length) throw failures[0];
  return registry.snapshot();
}

/** User-owned grants, never read from the repository or workflow metadata. */
export function readUserHostCapabilityGrants(
  file = path.join(os.homedir(), ".pi", "ultracode", "host-capabilities.json"),
): readonly string[] {
  if (!fs.existsSync(file)) return [];
  const contents: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!contents || typeof contents !== "object" || Array.isArray(contents)) {
    throw new WorkflowPolicyError("host capability grants must be an object");
  }
  const allow = (contents as { allow?: unknown }).allow;
  if (
    !Array.isArray(allow) ||
    allow.some((name) => !isHostCapabilityName(name)) ||
    new Set(allow).size !== allow.length
  ) {
    throw new WorkflowPolicyError(
      "host capability grants must contain an allow array of unique names",
    );
  }
  return Object.freeze([...allow]) as readonly string[];
}

export interface HostCapabilityCall {
  name: unknown;
  input: unknown;
  callPath: unknown;
  /** Metadata of the currently executing root or nested workflow. */
  declared: unknown;
}

export interface HostCapabilityExecution {
  readonly capabilities: ReadonlyMap<string, WorkflowHostCapability>;
  readonly grants: readonly string[];
  readonly cwd: string;
  readonly targetIdentity: string;
  readonly projectTrusted: boolean;
  readonly signal: AbortSignal;
  readonly journal?: RunJournal;
}

/**
 * Calls are authorised before any replay, so revocation takes effect on resume.
 * All mutating calls require a durable journal. Interrupted writes fail closed
 * rather than accidentally repeating an external side effect.
 */
export async function invokeHostCapability(
  request: HostCapabilityCall,
  environment: HostCapabilityExecution,
): Promise<unknown> {
  const { name, input, callPath, declared } = request;
  if (
    !isHostCapabilityName(name) ||
    typeof callPath !== "string" ||
    !callPath.startsWith("$/") ||
    callPath.length > 2048
  ) {
    throw new WorkflowPolicyError("invalid hostCall request");
  }
  assertHostCapabilityAllowed(name, declared, environment.projectTrusted, environment.grants);
  const capability = environment.capabilities.get(name);
  if (!capability) throw new WorkflowPolicyError(`hostCall '${name}' is not registered`);
  assertHostCapabilityInput(capability, input);
  if (capability.effect === "write" && !environment.journal) {
    throw new WorkflowPolicyError(`hostCall '${name}' writes require a durable run journal`);
  }
  if (environment.signal.aborted) throw new WorkflowAbortError();

  const key = hashString(
    stableStringify({
      callPath,
      name,
      input,
      version: capability.version,
      effect: capability.effect,
      target: environment.targetIdentity,
    }),
  );
  const previous = environment.journal?.lookupHost(callPath, key);
  if (previous?.completed) return previous.value;
  if (previous?.started && capability.effect === "write") {
    throw new WorkflowPolicyError(
      `hostCall '${name}' at ${callPath} was interrupted after invocation; reconcile the external effect before starting a new run`,
    );
  }
  environment.journal?.recordHostStart({
    callPath,
    key,
    name,
    effect: capability.effect,
  });
  const value = await runHostCapabilityBounded(capability, input, {
    cwd: environment.cwd,
    targetIdentity: environment.targetIdentity,
    signal: environment.signal,
    callId: key,
  });
  assertHostCapabilityOutput(name, value);
  environment.journal?.recordHostResult(callPath, key, value);
  return value;
}

async function runHostCapabilityBounded(
  capability: WorkflowHostCapability,
  input: unknown,
  context: WorkflowHostCapabilityContext,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      controller.abort();
      reject(new WorkflowAbortError());
    };
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new WorkflowPolicyError(`hostCall '${capability.name}' timed out`));
    }, capability.timeoutMs ?? 120_000);
  });
  context.signal.addEventListener("abort", abort, { once: true });
  const invocation = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new WorkflowAbortError();
    return capability.execute(input, {
      ...context,
      signal: controller.signal,
    });
  });
  try {
    if (context.signal.aborted) abort();
    return await Promise.race([invocation, cancelled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
  }
}
