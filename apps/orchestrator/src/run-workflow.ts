import { agentsDirForLanguage, runWorkflowFile } from "./ao-runtime.js";
import { createRuntimeConnector } from "./runtime-connector.js";
import { settingsFromEnv } from "./settings.js";
import { createTaskTemporalContext } from "./task-temporal-context.js";

const workflowPath = process.argv[2];
if (!workflowPath) {
  throw new Error("Usage: run-workflow.ts <workflow.yaml>");
}

const settings = settingsFromEnv();
const temporalContext = createTaskTemporalContext(
  new Date(),
  settings.timeZone,
);
const connector = createRuntimeConnector(
  settings,
  {
    onResearchEvent: (event) => {
      process.stdout.write(
        `${event.timestamp} GPTR ${event.type}\n`,
      );
    },
    onResearchComplete: (sourceCount, cost) => {
      process.stdout.write(
        `GPTR completed: ${sourceCount} source URLs, cost ${String(cost)}\n`,
      );
    },
  },
  undefined,
  temporalContext,
);

const result = await runWorkflowFile(workflowPath, {
  connector,
  agentsDir: agentsDirForLanguage("zh"),
  concurrency: settings.concurrency,
  verify: Boolean(settings.verifierModel),
  onEvent: (event) => {
    const verification = event.verification
      ? ` acceptance=${event.verification.pass ? "passed" : "failed"}${event.verification.reworked ? ",reworked" : ""}`
      : "";
    process.stdout.write(
      `${event.timestamp} ${event.type} ${event.stepId} (${event.status})${verification}\n`,
    );
  },
});

if (!result.success) {
  throw new Error("AO workflow failed.");
}

process.stdout.write(`\n${result.steps.at(-1)?.output ?? ""}\n`);
