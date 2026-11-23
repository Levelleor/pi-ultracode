import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkflowHostCapabilityRegistry,
  collectHostCapabilities,
  readUserHostCapabilityGrants,
  type WorkflowHostCapability,
} from "../src/workflow/host-capabilities.ts";
import { parseWorkflowScript } from "../src/workflow/parser.ts";
import { resolveRepositoryContext } from "../src/workflow/repository-context.ts";
import { RunJournal, hashString } from "../src/workflow/journal.ts";
import { runWorkflow } from "../src/workflow/runtime.ts";

const name = "tests.echo";
const script = `export const meta = {
  name: "host_test", description: "Host capability test",
  hostCapabilities: ["tests.echo"]
};
return await hostCall("tests.echo", { value: 42 });`;

function capability(
  execute: WorkflowHostCapability["execute"],
  effect: WorkflowHostCapability["effect"] = "read",
): WorkflowHostCapability {
  return {
    name,
    version: "1",
    effect,
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: {
        value: { type: "number" },
      },
      additionalProperties: false,
    },
    execute,
  };
}

async function withProject<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-host-cap-"));
  try {
    return await run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function options(cwd: string, handler: WorkflowHostCapability, grant = true) {
  return {
    cwd,
    projectTrusted: true,
    hostCapabilities: [handler],
    hostCapabilityGrants: grant ? [name] : [],
  };
}

test("hostCall is instrumented like other awaitable orchestration calls", () => {
  const parsed = parseWorkflowScript(script);
  assert.match(parsed.body, /__ultracodeHostCall\("hostCall:[a-z0-9]+","tests.echo"/);
  assert.deepEqual(parsed.meta.hostCapabilities, [name]);
  for (const invalid of [["tests.echo", "tests.echo"], ["bad"], ["tests.echo", 1]]) {
    assert.throws(
      () =>
        parseWorkflowScript(`export const meta = {
        name: "invalid", description: "x", hostCapabilities: ${JSON.stringify(invalid)}
      }; return 1;`),
      /meta.hostCapabilities/,
    );
  }
});

test("registry rejects duplicate names and dangerous declarations", () => {
  const registry = new WorkflowHostCapabilityRegistry();
  registry.register(capability(() => ({ ok: true })));
  assert.equal(registry.snapshot().length, 1);
  assert.throws(() => registry.register(capability(() => null)), /duplicate/);
  assert.throws(
    () => registry.register({ ...capability(() => null), name: "process.exit" + "__" }),
    /namespaced/,
  );
  assert.throws(
    () => registry.register({ ...capability(() => null), effect: "shell" as "read" }),
    /effect/,
  );
});

test("Pi event-based discovery captures synchronous contributors and rejects duplicates", () => {
  const event = {
    emit(_channel: string, collector: unknown) {
      const register = (collector as { register: (c: WorkflowHostCapability) => void }).register;
      register(capability(() => 1));
    },
  };
  assert.equal(collectHostCapabilities(event).length, 1);
  const collision = {
    emit(_channel: string, collector: unknown) {
      const register = (collector as { register: (c: WorkflowHostCapability) => void }).register;
      register(capability(() => 1));
      // Pi's event bus swallows errors. The collector must still fail closed.
      try {
        register(capability(() => 2));
      } catch {
        /* intentional */
      }
    },
  };
  assert.throws(() => collectHostCapabilities(collision), /duplicate/);
});

test("grants come only from a user-owned file; missing config denies all", async () => {
  await withProject(async (cwd) => {
    const file = path.join(cwd, "host-capabilities.json");
    assert.deepEqual(readUserHostCapabilityGrants(file), []);
    fs.writeFileSync(file, JSON.stringify({ allow: [name] }));
    assert.deepEqual(readUserHostCapabilityGrants(file), [name]);
    fs.writeFileSync(file, JSON.stringify({ allow: [name, name] }));
    assert.throws(() => readUserHostCapabilityGrants(file), /unique/);
  });
});

test("authorised hostCall returns bounded JSON without an agent", async () => {
  await withProject(async (cwd) => {
    let calls = 0;
    const result = await runWorkflow(
      script,
      options(
        cwd,
        capability((input) => {
          calls++;
          return { value: (input as { value: number }).value, exitCode: 0 };
        }),
      ),
    );
    assert.equal(result.result && (result.result as { exitCode: number }).exitCode, 0);
    assert.equal(calls, 1);
    assert.equal(result.agentCount, 0);
  });
});

test("declaration, project trust, user grant and provider registration are separate gates", async () => {
  await withProject(async (cwd) => {
    const registered = capability(() => ({ exitCode: 0 }));
    await assert.rejects(runWorkflow(script, options(cwd, registered, false)), /authorised/);
    await assert.rejects(
      runWorkflow(script, {
        ...options(cwd, registered),
        projectTrusted: false,
      }),
      /trusted project/,
    );
    await assert.rejects(
      runWorkflow(script, {
        ...options(cwd, registered),
        hostCapabilities: [],
      }),
      /not registered/,
    );
    const undeclared = script.replace('hostCapabilities: ["tests.echo"]', "hostCapabilities: []");
    await assert.rejects(runWorkflow(undeclared, options(cwd, registered)), /not declared/);
  });
});

test("validates request schema and rejects non-JSON results", async () => {
  await withProject(async (cwd) => {
    const invalidInput = script.replace("{ value: 42 }", '{ value: "wrong" }');
    await assert.rejects(
      runWorkflow(
        invalidInput,
        options(
          cwd,
          capability(() => null),
        ),
      ),
      /input.*schema/,
    );
    await assert.rejects(
      runWorkflow(
        script,
        options(
          cwd,
          capability(() => undefined),
        ),
      ),
      /hostCall.*result/,
    );
    await assert.rejects(
      runWorkflow(
        script,
        options(
          cwd,
          capability(() => ({ fn: () => 1 })),
        ),
      ),
      /hostCall.*result/,
    );
  });
});

test("workflow scripts retain their process, require and eval restrictions", () => {
  for (const body of ["process.cwd()", "globalThis.process", "require('fs')", "eval('1')"]) {
    const source = `export const meta = { name: "sandbox", description: "x" }; return ${body};`;
    if (body.startsWith("process") || body.startsWith("globalThis")) {
      assert.throws(() => parseWorkflowScript(source), /process|globalThis/);
    } else {
      assert.doesNotThrow(() => parseWorkflowScript(source));
    }
  }
});

test("journalled reads and completed writes replay without invoking providers again", async () => {
  await withProject(async (cwd) => {
    for (const effect of ["read", "write"] as const) {
      const dir = path.join(cwd, effect);
      const header = {
        type: "run" as const,
        runId: "host-test",
        name: "host_test",
        scriptHash: hashString(script),
        projectTrusted: true,
        targetIdentity: resolveRepositoryContext(cwd).identity,
        startedAt: 0,
      };
      let calls = 0;
      const provider = capability(() => ({ number: ++calls }), effect);
      const journal = RunJournal.create(dir, header);
      await runWorkflow(script, { ...options(cwd, provider), journal });
      journal.close();
      const resumed = RunJournal.resume(dir, "host-test", { ...header, startedAt: 1 });
      const replay = await runWorkflow(script, { ...options(cwd, provider), journal: resumed });
      assert.equal((replay.result as { number: number }).number, 1);
      assert.equal(calls, 1);
      resumed.close();
    }
  });
});

test("interrupted writes fail closed rather than executing twice on resume", async () => {
  await withProject(async (cwd) => {
    const dir = path.join(cwd, "write");
    const header = {
      type: "run" as const,
      runId: "host-test",
      name: "host_test",
      scriptHash: hashString(script),
      projectTrusted: true,
      targetIdentity: resolveRepositoryContext(cwd).identity,
      startedAt: 0,
    };
    let calls = 0;
    const provider = capability(() => {
      calls++;
      throw new Error("External service failed after accepting the request");
    }, "write");
    const journal = RunJournal.create(dir, header);
    await assert.rejects(
      runWorkflow(script, { ...options(cwd, provider), journal }),
      /External service/,
    );
    journal.close();
    const resumed = RunJournal.resume(dir, "host-test", { ...header, startedAt: 1 });
    await assert.rejects(
      runWorkflow(script, { ...options(cwd, provider), journal: resumed }),
      /interrupted/,
    );
    assert.equal(calls, 1);
    resumed.close();
  });
});

test("write capabilities require durable journals and deny revocation on resume", async () => {
  await withProject(async (cwd) => {
    await assert.rejects(
      runWorkflow(
        script,
        options(
          cwd,
          capability(() => 1, "write"),
        ),
      ),
      /durable/,
    );
    const dir = path.join(cwd, "read");
    const header = {
      type: "run" as const,
      runId: "host-test",
      name: "host_test",
      scriptHash: hashString(script),
      projectTrusted: true,
      targetIdentity: resolveRepositoryContext(cwd).identity,
      startedAt: 0,
    };
    const provider = capability(() => ({ ok: true }));
    const journal = RunJournal.create(dir, header);
    await runWorkflow(script, { ...options(cwd, provider), journal });
    journal.close();
    const resumed = RunJournal.resume(dir, "host-test", { ...header, startedAt: 1 });
    await assert.rejects(
      runWorkflow(script, {
        ...options(cwd, provider, false),
        journal: resumed,
      }),
      /authorised/,
    );
    resumed.close();
  });
});
