import assert from "node:assert/strict";
import test from "node:test";
import { findReportVersionSnapshot, type ReportDocumentVersion } from "../src/domain/report";

const version = (number: number, markdown: string): ReportDocumentVersion => ({
  taskId: "task-1",
  version: number,
  markdown,
  createdAt: `2026-08-${String(number).padStart(2, "0")}T00:00:00.000Z`,
});

test("uses the current document version snapshot as the saved comparison target", () => {
  const versions = [version(5, "正式版本内容"), version(4, "上一版内容"), version(1, "初始内容")];

  assert.equal(findReportVersionSnapshot(versions, 5)?.markdown, "正式版本内容");
  assert.notEqual(findReportVersionSnapshot(versions, 5)?.markdown, versions.at(-1)?.markdown);
});

test("does not fabricate a saved snapshot when the version history is incomplete", () => {
  assert.equal(findReportVersionSnapshot([version(1, "初始内容")], 5), undefined);
});
