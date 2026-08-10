import { createHash } from "node:crypto";

export interface ReportEditorSource {
  title: string;
  url: string;
}

export interface ReportCitationAudit {
  version: number;
  checkedAt: string;
  totalLinks: number;
  verifiedLinks: number;
  numericClaimParagraphs: number;
  citedNumericClaimParagraphs: number;
  citationCoverage: number | null;
  warnings: string[];
}

const MARKDOWN_LINK = /(?<!!)!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/giu;
const NUMERIC_CLAIM = /(?:\d[\d,.]*\s*%|\d[\d,.]*\s*(?:万|亿|美元|元|年|月|日|百分点|人|倍))/u;

export function auditReportCitations(
  markdown: string,
  version: number,
  sources: readonly ReportEditorSource[],
): ReportCitationAudit {
  const verifiedUrls = new Set(sources.map((source) => canonicalUrl(source.url)).filter(Boolean));
  const links = [...markdown.matchAll(MARKDOWN_LINK)].map((match) => match[1] ?? "");
  const verifiedLinks = links.filter((url) => verifiedUrls.has(canonicalUrl(url))).length;
  const paragraphs = markdown.split(/\n\s*\n/gu).map((value) => value.trim()).filter((value) => value && !value.startsWith("#") && !value.startsWith("```"));
  const numericParagraphs = paragraphs.filter((paragraph) => NUMERIC_CLAIM.test(paragraph));
  const citedNumericClaimParagraphs = numericParagraphs.filter((paragraph) =>
    [...paragraph.matchAll(MARKDOWN_LINK)].some((match) => verifiedUrls.has(canonicalUrl(match[1] ?? ""))),
  ).length;
  const citationCoverage = numericParagraphs.length
    ? citedNumericClaimParagraphs / numericParagraphs.length
    : null;
  const warnings: string[] = [];
  if (links.length > verifiedLinks) {
    warnings.push(`${links.length - verifiedLinks} 个链接未在本报告已采用的来源中核验。`);
  }
  if (citationCoverage !== null && citationCoverage < 0.75) {
    warnings.push(`含数据段落的已验证引用覆盖率为 ${(citationCoverage * 100).toFixed(1)}%，低于 75%。`);
  }
  if (numericParagraphs.length > 0 && verifiedUrls.size === 0) {
    warnings.push("报告包含数据性表述，但尚未采用可核验的公开来源。");
  }
  return {
    version,
    checkedAt: new Date().toISOString(),
    totalLinks: links.length,
    verifiedLinks,
    numericClaimParagraphs: numericParagraphs.length,
    citedNumericClaimParagraphs,
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
