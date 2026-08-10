import { createHash } from "node:crypto";

import { parseReportBlocks, type ReportBlock } from "./report-document-store.js";

export interface ReportEditorSource {
  title: string;
  url: string;
  referenceId?: string | number;
}

export interface ReportCitationAudit {
  version: number;
  checkedAt: string;
  mode: "baseline" | "edited";
  summary: string;
  totalLinks: number;
  verifiedLinks: number;
  changedBlocks: number;
  numericClaimParagraphs: number;
  citedNumericClaimParagraphs: number;
  citationCoverage: number | null;
  warnings: string[];
}

export interface ReportCitationAuditInput {
  markdown: string;
  baselineMarkdown: string;
  version: number;
  sources: readonly ReportEditorSource[];
}

const MARKDOWN_LINK = /(?<!!)!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/giu;
const REFERENCE_MARKER = /\[(\d{1,4})\]/gu;
const NUMERIC_CLAIM = /(?:\d[\d,.]*\s*(?:%|‰)|\d[\d,.]*\s*(?:万|亿|千)?(?:美元|元|人|吨|公里|百分点)|\d{4}\s*年|\d{1,2}\s*月|\d{1,2}\s*日)/u;

export function auditReportCitations(input: ReportCitationAuditInput): ReportCitationAudit {
  const verifiedUrls = new Set(input.sources.map((source) => canonicalUrl(source.url)).filter(Boolean));
  const references = new Map(
    input.sources
      .flatMap((source, index) => {
        const referenceId = source.referenceId ?? index + 1;
        const url = canonicalUrl(source.url);
        return url ? [[String(referenceId), url] as const] : [];
      }),
  );
  const links = extractLinks(input.markdown);
  const verifiedLinks = links.filter((url) => verifiedUrls.has(canonicalUrl(url))).length;
  const mode = input.markdown === input.baselineMarkdown ? "baseline" : "edited";
  const changedBlocks = mode === "baseline"
    ? []
    : changedContentBlocks(input.markdown, input.baselineMarkdown);
  const numericClaimBlocks = changedBlocks.filter((block) => NUMERIC_CLAIM.test(block.text));
  const citedNumericClaimBlocks = numericClaimBlocks.filter((block) =>
    blockHasVerifiedCitation(block.markdown, verifiedUrls, references),
  );
  const citationCoverage = numericClaimBlocks.length
    ? citedNumericClaimBlocks.length / numericClaimBlocks.length
    : null;
  const warnings: string[] = [];
  if (links.length > verifiedLinks) {
    warnings.push(`报告中有 ${links.length - verifiedLinks} 个链接未匹配到已验证来源。`);
  }
  if (mode === "edited" && citationCoverage !== null && citationCoverage < 0.75) {
    warnings.push(
      `本次编辑涉及 ${numericClaimBlocks.length} 个含数据内容块，其中 ${citedNumericClaimBlocks.length} 个已关联已验证来源。`,
    );
  }
  return {
    version: input.version,
    checkedAt: new Date().toISOString(),
    mode,
    summary: auditSummary(mode, links.length, verifiedLinks, changedBlocks.length, numericClaimBlocks.length, citedNumericClaimBlocks.length),
    totalLinks: links.length,
    verifiedLinks,
    changedBlocks: changedBlocks.length,
    numericClaimParagraphs: numericClaimBlocks.length,
    citedNumericClaimParagraphs: citedNumericClaimBlocks.length,
    citationCoverage,
    warnings,
  };
}

export function canonicalReportSource(url: string): string {
  return canonicalUrl(url);
}

export function reportContentFingerprint(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex");
}

function changedContentBlocks(markdown: string, baselineMarkdown: string): ReportBlock[] {
  const baseline = new Set(
    parseReportBlocks(baselineMarkdown)
      .filter(isAuditableContentBlock)
      .map((block) => `${block.kind}:${block.markdown}`),
  );
  return parseReportBlocks(markdown)
    .filter(isAuditableContentBlock)
    .filter((block) => !baseline.has(`${block.kind}:${block.markdown}`));
}

function isAuditableContentBlock(block: ReportBlock): boolean {
  return block.kind === "paragraph" || block.kind === "list" || block.kind === "quote" || block.kind === "table";
}

function blockHasVerifiedCitation(
  markdown: string,
  verifiedUrls: ReadonlySet<string>,
  references: ReadonlyMap<string, string>,
): boolean {
  if (extractLinks(markdown).some((url) => verifiedUrls.has(canonicalUrl(url)))) return true;
  return [...markdown.matchAll(REFERENCE_MARKER)].some((match) => {
    const sourceUrl = references.get(match[1] ?? "");
    return Boolean(sourceUrl && verifiedUrls.has(sourceUrl));
  });
}

function extractLinks(markdown: string): string[] {
  return [...markdown.matchAll(MARKDOWN_LINK)].map((match) => match[1] ?? "");
}

function auditSummary(
  mode: "baseline" | "edited",
  totalLinks: number,
  verifiedLinks: number,
  changedBlocks: number,
  numericBlocks: number,
  citedNumericBlocks: number,
): string {
  if (mode === "baseline") {
    return `初始报告：已验证链接 ${verifiedLinks}/${totalLinks}。编辑器会在保存修改后仅检查变更内容。`;
  }
  if (!numericBlocks) {
    return `编辑影响：已变更 ${changedBlocks} 个内容块，未检测到需要来源校验的数据性内容。`;
  }
  return `编辑影响：已变更 ${changedBlocks} 个内容块；数据性内容的已验证来源关联为 ${citedNumericBlocks}/${numericBlocks}。`;
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return "";
  }
}
