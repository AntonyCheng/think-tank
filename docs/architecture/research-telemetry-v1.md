# Research Telemetry V1

## Purpose

Research Telemetry turns noisy researcher callbacks into a stable task view. A task contains AO steps; each step may create one or more Research Runs. The browser renders one mutable node per run instead of one node per raw callback. Each run node may be expanded to show its safe, deduplicated Research Activities.

## Data Flow

1. `GptrConnector` assigns `aoStepId`, `researchRunId`, `queuedAt`, and `startedAt`.
2. `ResearchTelemetryTracker` maps raw stages to user phases, deduplicates unchanged progress, and normalizes elapsed time, sources, deep progress, and cost.
3. `ResearchActivityProjector` allowlists safe raw stages and projects them into localized, deduplicated Research Activities.
4. `ResearchTaskManager` persists public `research.*` events and the current `researchTelemetry` snapshot.
5. The frontend updates the existing run node keyed by `researchRunId`; expanding it reveals that run's activity stream.

The public SSE event envelope supplies `taskId`; event data supplies `aoStepId` and `researchRunId`.

## Public Semantics

Phases are `preparing`, `planning`, `searching`, `collecting`, `analyzing`, `writing`, `finalizing`, and terminal states. V1 deliberately has no global percentage. Deep mode exposes only native absolute level, branch, and local query counters.

`research.activity` is a public progress event, not a diagnostic event. Its payload contains a safe activity kind, localized message, sequence, timestamp, and optional HTTP(S) source URL. Unknown stages are dropped. Per-run fingerprints suppress duplicates, and the public activity stream is capped at 250 events per run.

`elapsedMs` is execution time from connector start. `queueWaitMs` is concurrency-budget wait and is displayed separately. Task `totalElapsedMs` sums run execution durations; it is not wall-clock task duration.

Cost is always marked as an estimate reported by the research service. Zero is a valid reported value. Missing or invalid cost remains `unavailable`; totals include only reported runs and retain coverage through `reportedCostRuns`.

## Sources and Diagnostics

Observed source activities normalize HTTP(S) URLs and update the task's unique-source count while research is running. Completion reconciles final source URLs into the same set, so the count is monotonic and remains correct when a provider omits intermediate source callbacks.
Validated specified URLs emit `source.validation_started`, `source.materialized`, and bounded unavailable/filter milestones. Only `source.materialized` changes the live unique-source count; page text and network diagnostics never enter public events.

Raw callbacks never enter public SSE. They are sanitized and stored in `research_task_diagnostics`: secrets and internal prompt blocks are redacted, strings are capped at 4 KiB, and each task retains at most 1,999 detail records plus one overflow summary.

## Compatibility

All new snapshot fields and the SQLite diagnostics table are additive. The frontend still understands legacy `gptr.progress` and `gptr.completed` events so historical task databases remain readable.
