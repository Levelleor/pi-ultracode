/** Public host-capability registration API for Pi extension authors. */
export {
  HOST_CAPABILITIES_COLLECT_EVENT,
  WorkflowHostCapabilityRegistry,
  collectHostCapabilities,
  readUserHostCapabilityGrants,
  type WorkflowHostCapability,
  type WorkflowHostCapabilityContext,
  type HostCapabilityCollector,
} from "../src/workflow/host-capabilities.ts";
