# Workflow host capabilities

Host capabilities let a trusted Pi extension or standalone SDK host provide discrete
functions to deterministic Ultracode workflow scripts. They do not expose
`require`, `process`, `child_process`, sockets or filesystem globals in the VM.

## Registration from another Pi extension

Listen for `ultracode:host-capabilities:collect` and register synchronously:

```typescript
pi.events.on("ultracode:host-capabilities:collect", (collector) => {
  collector.register({
    name: "tests.run",
    version: "1",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { suite: { type: "string" } },
      required: ["suite"],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    async execute(input, { cwd, signal, targetIdentity, callId }) {
      return runTests(input.suite, { cwd, signal, targetIdentity, callId });
    },
  });
});
```

Do not await before registering. Pi's event bus does not await async listeners.
The collector rejects late registrations. Invalid or duplicate definitions fail
the workflow, even if Pi's event bus catches the listener's exception.

Each capability is versioned and explicitly marked `read` or `write`.
Only bounded JSON may cross the boundary. `inputSchema` uses the existing
restricted workflow JSON Schema subset.

## Workflow usage and user grants

The workflow declares its requested operations:

```javascript
export const meta = {
  name: "tests",
  description: "Verify a change",
  hostCapabilities: ["tests.run"],
};

const result = await hostCall("tests.run", { suite: "unit" });
return result.exitCode === 0;
```

The user must grant exactly that capability name in
`~/.pi/ultracode/host-capabilities.json`:

```json
{ "allow": ["tests.run"] }
```

This file is not loaded from the project directory. Only trusted projects
can call capabilities. Grants are checked before replay, so removing a grant
also prevents resuming a previously authorised call.

## Standalone SDK hosts

```typescript
import { runWorkflow } from "pi-ultracode";
import type { WorkflowHostCapability } from "pi-ultracode/host";

const hostCapabilities: WorkflowHostCapability[] = [
  {
    name: "tests.run",
    version: "1",
    effect: "read",
    execute: async (input, { cwd, signal }) => ({ exitCode: 0 }),
  },
];

await runWorkflow(source, {
  cwd: projectDirectory,
  projectTrusted: true,
  hostCapabilities,
  hostCapabilityGrants: ["tests.run"],
});
```

The host owns the grant decision. The public registry is scoped to each
workflow run and does not modify process-global state.

## Resume and side effects

The workflow parser instruments `hostCall` with a stable call path, as it does
for `agent`. A journal record binds the call path to its provider name, version,
effect, arguments and target identity. The host writes an intent _before_
invoking the provider, then persists its bounded JSON result.

- Completed calls return the previously recorded value when resumed, without
  invoking the provider again.
- A read-only call interrupted before completion may be rerun.
- A write call interrupted after its intent was written is blocked on resume,
  even if the previous attempt returned an error. Manually reconcile the
  external effect and start a new run. Host write calls without a journal are
  rejected.
- Providers receive a stable `callId` as a possible idempotency key.

Cancellation and timeout signal an `AbortSignal`, but a malicious or broken
provider may ignore it. Providers run with Pi's host privileges, not in the
workflow VM, so installation and registration must be trusted. The registry
does not claim to secure a deliberately malicious host extension.

No capabilities are registered or granted in a default installation, so
existing workflows retain their original behaviour and restrictions.
