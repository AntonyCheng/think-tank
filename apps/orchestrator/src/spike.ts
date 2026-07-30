import { runResearchTopic } from "./research-runner.js";

const topic = process.argv.slice(2).join(" ").trim();
if (!topic) {
  throw new Error('Usage: npm run spike -- "research topic"');
}

const result = await runResearchTopic(topic, {
  onEvent: (event) => {
    if (event.type === "workflow.composed") {
      process.stdout.write(`AO workflow: ${event.workflowPath}\n`);
      for (const warning of event.warnings) {
        process.stderr.write(`AO warning: ${warning}\n`);
      }
      return;
    }
    if (event.type === "gptr.completed") {
      process.stdout.write(
        `GPTR completed: ${event.sourceCount} source URLs, cost ${String(event.cost)}\n`,
      );
      return;
    }
    if (event.type === "gptr.progress") {
      process.stdout.write(
        `${event.timestamp} GPTR ${event.stage}: ${event.message}\n`,
      );
      return;
    }
    if (event.type === "gptr.rework_rejected") {
      process.stderr.write(
        `${event.timestamp} GPTR rework rejected: ${event.message}\n`,
      );
      return;
    }
    if (event.type === "evidence.bundle.recorded") {
      process.stdout.write(
        `${event.timestamp} evidence ${event.bundle.aoStepId}: ${event.bundle.sources.length} sources\n`,
      );
      return;
    }
    if ("progress" in event) {
      process.stdout.write(
        `${event.timestamp} research ${event.progress.aoStepId}: ${event.progress.phase} (${event.progress.state})\n`,
      );
      return;
    }
    if ("activity" in event) {
      process.stdout.write(
        `${event.timestamp} research activity ${event.activity.aoStepId}: ${event.activity.message}\n`,
      );
      return;
    }
    if ("diagnostic" in event) {
      return;
    }
    const verification = event.verification
      ? ` acceptance=${event.verification.pass ? "passed" : "failed"}${event.verification.reworked ? ",reworked" : ""}`
      : "";
    process.stdout.write(
      `${event.timestamp} ${event.type} ${event.stepId} (${event.status})${verification}\n`,
    );
  },
});

process.stdout.write(`\n${result.output}\n`);
