# Report Editor Plan

## Product Goal

Turn a completed research report into an evidence-aware editing workspace.
AO and GPTR produce the initial report only. The editor is a separate module
for precise AI-assisted changes, optional web supplementation, and durable
editing conversations.

The governing rule is: the user selects the scope, and the system can only
write inside that scope. A request to revise the first paragraph must not
change any other report prose.

## Scope And Boundaries

- Available only after a research task reaches `completed` or
  `completed_with_warnings`.
- The initial research report remains an immutable baseline.
- The current report is an editable version derived from that baseline.
- AI editing does not invoke AO orchestration or the GPTR research workflow.
- Web search is an explicit user action. It reuses configured retriever and
  source-quality policies through a lightweight, separate search interface.
- Search results never alter a report automatically.
- New externally sourced claims require the user to select sources and confirm
  their use before the selected report scope is changed.

## User Experience

1. Open a completed report and enter a dedicated full-screen editing
   workbench.
2. The left pane is a persistent ChatGPT-style conversation. The right pane
   is the rendered report and remains independently scrollable.
3. The active scope is visible above the composer: one block, contiguous
   blocks, or the whole document. With no selection, the scope is explicitly
   `whole_document`.
4. The user can use natural language without knowing internal block IDs. The
   AI acknowledges the interpreted scope, reports progress, and asks for
   clarification when the requested scope is ambiguous.
5. The AI returns a human-readable summary and an auditable replacement
   proposal. The report shows a diff before the user applies or rejects it.
6. Applying a proposal produces a single reversible operation. Rejected
   proposals and their summaries remain in the conversation.
7. For supplementary facts, choose "search the web", review result cards,
   select sources, then ask the AI to revise the active scope using those
   sources.
8. Export uses the current confirmed report version. Users can inspect or
   restore earlier versions.

## Core Data Model

Keep this data separate from `ResearchTaskSnapshot` so research execution data
is never overwritten by editorial work.

- `report_documents`: task ID, immutable baseline Markdown, current Markdown,
  current version, timestamps.
- `report_blocks`: document version, stable block ID, source range, plain-text
  fingerprint. This enables exact scope checks.
- `report_conversations`: task ID, document ID, optional scope identity,
  creation time, last activity time.
- `report_messages`: conversation ID, role, user instruction or AI response,
  message kind (`user`, `progress`, `assistant`, `summary`, `proposal`, or
  `operation`), selection snapshot, model metadata, timestamps.
- `report_edit_operations`: document version before and after, target block or
  range, original-content hash, replacement content, accepted/rejected state,
  linked conversation message, timestamps.
- `report_search_sessions` and `report_search_results`: query, scope, selected
  sources, source metadata, captured time, and the edit operation that adopted
  a source.

Conversation history is a first-class record: every user instruction, AI
response, selected source, accepted replacement, rejected replacement, undo,
and restore action is retained and can be viewed in context of its report
scope and document version.

## Technical Guardrails

- A selection contains `documentVersion`, `blockId`, offsets, exact original
  text, and an original-content hash.
- The edit API accepts a replacement only for the explicit scope. A whole
  document replacement is valid only when the user is in
  `whole_document` scope; the model cannot silently broaden a local scope.
- Applying an edit verifies the current document version and original hash. A
  stale selection returns a conflict instead of overwriting newer work.
- Context surrounding a selection may be supplied to the model read-only, but
  only the selection is writable.
- The source list is structured document metadata. Adding a verified source
  may update that list after explicit user confirmation; it must not modify
  unrelated prose.
- Undo creates a new recorded operation rather than deleting audit history.
- Report export resolves the current confirmed document version, while the
  initial research report remains available for comparison and restoration.

## Delivery Order

### 1. Document Foundation (Completed)

- Add document and version persistence.
- Parse current Markdown into stable editable blocks.
- Render edit mode with block selection and read-only baseline comparison.
- Keep existing report viewing, citations, history, and export behavior intact.

### 2. Scoped AI Editing And Conversation History (Foundation Completed)

- Add the report-editor model connector, separate from AO and GPTR.
- Add scoped conversations and durable message storage.
- Implement paragraph-level replacement, inline preview, accept/reject, and
  version/hash conflict detection.
- Add operation history and undo for accepted edits.
- Present editing as a two-pane workspace: persistent conversation on the
  left and rendered report on the right.
- Support explicit single-block, contiguous multi-block, and whole-document
  scopes. A missing selection means whole-document scope; every scope still
  produces a reviewable replacement before application.

### 3. Conversational Editing Workbench (Completed)

- Replace the embedded report-card layout with an independent full-screen
  editor shell.
- Keep the conversation composer fixed at the bottom of the left pane and
  keep report rendering and scrolling isolated in the right pane.
- Add assistant states: scope acknowledgement, progress, completed summary,
  preview, and operation result.
- Summarize every accepted edit with changed scope, changed block count,
  preserved citations, and unchanged regions.
- Let the AI resolve natural-language references such as "第一段" into the
  current report scope, but require clarification for ambiguous references.
- Keep internal patch/operation structures hidden from the user; expose only
  natural-language responses and visual diffs.
- Persist all conversational states and reconnect safely after a refresh.
- Use a dependency-light custom shell first. Evaluate `assistant-ui` or
  Vercel AI SDK UI for chat behavior, but do not let a chat component own
  report mutation. Evaluate Tiptap/ProseMirror or Milkdown only when precise
  text-range editing is implemented.

### 4. Text-Range Editing (Completed)

- Support text selections within one block, then contiguous multi-block
  selections.
- Preserve Markdown formatting and citation markers when applying a range
  replacement.
- Reject ambiguous selections that cannot be mapped safely to source Markdown.

### 5. Web Supplementation (Completed)

- Expose a lightweight search endpoint using the configured retriever catalog
  and source-access policy.
- Persist result metadata and user source selections.
- Permit selected sources to ground an edit only after confirmation.
- Add valid citations and source-list entries without changing unrelated prose.

### 6. Version Review And Export (Completed)

- Show document versions, scoped conversations, edit operations, and source
  adoption history together.
- Restore a prior version through a recorded operation.
- Make all export formats use the selected confirmed version.

## Acceptance Checks

- Editing the first paragraph leaves every other prose block byte-for-byte
  unchanged.
- A stale AI response cannot overwrite an intervening user edit.
- A search query by itself produces no report change.
- An adopted source is traceable from its result, conversation messages, edit
  operation, inline citation, and source-list entry.
- Rejected suggestions remain in conversation history but do not change the
  document.
- Each accepted edit produces a user-visible completion summary and an
  operation record that can be traced back to its conversation message.
- A progress or assistant response can be replayed after refreshing the
  report without duplicating the underlying edit operation.
- Undo and restore retain a complete, chronological audit trail.
- Opening the report from history restores the current edited version and its
  conversations, not only the original research output.

## Deliberate Non-Goals For The First Release

- No automatic whole-report rewriting.
- No background web research or silent source adoption.
- No edits to running, queued, or failed research tasks.
- No deletion of editorial audit records from the normal UI.
