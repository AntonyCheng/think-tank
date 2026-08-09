import type { ResearchResponse } from "./contracts.js";
import type { ReportEvidencePolicy } from "./report-evidence-policy.js";

export interface VerifiedCitation {
  id: number;
  title: string;
  url: string;
}

export interface CitationNormalization {
  markdown: string;
  citations: VerifiedCitation[];
  warnings: string[];
  numericClaimParagraphs: number;
  citedNumericClaimParagraphs: number;
  bodyLinkCount: number;
  verifiedBodyLinkCount: number;
}

export interface ObservedSource {
  title: string;
  url: string;
}

const MARKDOWN_LINK =
  /(?<!!)\[((?:\\.|[^\]\\\n])*)\]\((https?:\/\/[^)\s]+)\)/giu;
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu;
const NUMERIC_CLAIM =
  /(?:\d[\d,.]*\s*%|\d[\d,.]*\s*(?:万|亿|元|美元|年|个|项|倍|点|人|家|次|%))/u;

export function collectObservedSources(
  response: Pick<ResearchResponse, "sourceUrls" | "sources">,
): ObservedSource[] {
  const titles = new Map<string, string>();
  for (const source of response.sources) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    const url = firstHttpUrl(record.url, record.href, record.link);
    const title = firstText(record.title, record.name);
    if (url && title) titles.set(canonicalUrl(url), title);
  }

  const observed = new Map<string, ObservedSource>();
  for (const candidate of [
    ...response.sourceUrls,
    ...response.sources.flatMap((source) => {
      if (!source || typeof source !== "object") return [];
      const record = source as Record<string, unknown>;
      const url = firstHttpUrl(record.url, record.href, record.link);
      return url ? [url] : [];
    }),
  ]) {
    const key = canonicalUrl(candidate);
    if (!key || observed.has(key)) continue;
    observed.set(key, {
      url: candidate,
      title: titles.get(key) ?? hostnameTitle(candidate),
    });
  }
  return [...observed.values()];
}

export function normalizeFinalCitations(
  markdown: string,
  observedSources: readonly ObservedSource[],
  reportPolicy?: ReportEvidencePolicy,
): CitationNormalization {
  const body = sanitizeReportLinks(
    stripReferenceSections(markdown),
    observedSources,
    reportPolicy,
  );
  const formatted = formatBodyCitations(body, observedSources);
  const preserveSemanticLinks = reportPolicy?.strategy === "mixed_evidence";
  const normalizedBody = preserveSemanticLinks ? body : formatted.markdown;
  const citations = formatted.citations;
  const citationsByUrl = new Map(
    citations.map((citation) => [canonicalUrl(citation.url), citation]),
  );
  const paragraphs = normalizedBody
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) =>
      paragraph &&
      !paragraph.startsWith("#") &&
      !paragraph.startsWith("```")
    );
  const numericParagraphs = paragraphs.filter((paragraph) =>
    NUMERIC_CLAIM.test(paragraph)
  );
  const citedNumericParagraphs = numericParagraphs.filter((paragraph) =>
    [...paragraph.matchAll(MARKDOWN_LINK)].some((match) =>
      citationsByUrl.has(canonicalUrl(match[2] ?? ""))
    )
  );

  const warnings: string[] = [];
  if (observedSources.length > 0 && citations.length === 0) {
    warnings.push("引用校验：最终报告未保留任何可验证的句内来源链接。");
  }
  if (numericParagraphs.length > citedNumericParagraphs.length) {
    warnings.push(
      `引用校验：${numericParagraphs.length - citedNumericParagraphs.length} 个含数据段落缺少已验证来源。`,
    );
  }
  if (formatted.unknownUrls.size > 0) {
    warnings.push(
      `引用校验：${formatted.unknownUrls.size} 个报告链接不在本次检索来源中。`,
    );
  }

  const sections = [
    normalizedBody,
    preserveSemanticLinks ? "" : referenceSection(citations),
  ].filter(
    Boolean,
  );

  return {
    markdown: sections.join("\n\n"),
    citations,
    warnings,
    numericClaimParagraphs: numericParagraphs.length,
    citedNumericClaimParagraphs: citedNumericParagraphs.length,
    bodyLinkCount: formatted.bodyUrls.size,
    verifiedBodyLinkCount: citations.length,
  };
}

export function formatCitationReport(
  markdown: string,
  sources: readonly ObservedSource[],
): string {
  const body = stripReferenceSections(markdown);
  const formatted = formatBodyCitations(body, sources);
  return [formatted.markdown, referenceSection(formatted.citations)]
    .filter(Boolean)
    .join("\n\n");
}

function sanitizeReportLinks(
  markdown: string,
  observedSources: readonly ObservedSource[],
  reportPolicy: ReportEvidencePolicy | undefined,
): string {
  if (!reportPolicy) return markdown;
  const observed = new Set(
    observedSources.map((source) => canonicalUrl(source.url)).filter(Boolean),
  );
  const declared = new Set(
    reportPolicy.allowedPublicUrls.map(canonicalUrl).filter(Boolean),
  );
  const allowed = declared.size === 0
    ? observed
    : new Set([...observed].filter((url) => declared.has(url)));
  const hasHttpUrl = /https?:\/\/[^\s)<]+/iu;
  const hasInternalDisclosure = /(?:document:|127\.0\.0\.1|localhost|\.venv[\\/])/iu;
  const lines = markdown.split("\n").filter((line) => {
    const urls = [...line.matchAll(/https?:\/\/[^\s)<]+/giu)]
      .map((match) => canonicalUrl(match[0] ?? ""))
      .filter(Boolean);
    if (reportPolicy.forbidsExternalLinks && (urls.length > 0 || hasInternalDisclosure.test(line))) {
      return false;
    }
    if (urls.length === 0) return true;
    return urls.every((url) => allowed.has(url));
  });
  const sanitized = lines.join("\n").trim();
  if (reportPolicy.forbidsExternalLinks) {
    if (hasPrivateBodyContent(sanitized)) return sanitized;
    return [
      sanitized,
      "现有受限资料不足以支持可公开核验的事实结论。",
    ].filter(Boolean).join("\n\n");
  }
  if (sanitized && !hasHttpUrl.test(sanitized)) return sanitized;
  return sanitized;
}

function hasPrivateBodyContent(markdown: string): boolean {
  return markdown.split("\n").some((line) => {
    const value = line.trim();
    return value.length > 0 && !value.startsWith("#");
  });
}

export function humanizeCitationLinks(
  markdown: string,
  sources: readonly ObservedSource[],
): string {
  return formatCitationReport(markdown, sources);
}

function formatBodyCitations(
  markdown: string,
  sources: readonly ObservedSource[],
): {
  markdown: string;
  citations: VerifiedCitation[];
  unknownUrls: Set<string>;
  bodyUrls: Set<string>;
} {
  const allowed = new Map(
    sources.map((source) => [canonicalUrl(source.url), source]),
  );
  const citationsByUrl = new Map<string, VerifiedCitation>();
  const unknownUrls = new Set<string>();
  const bodyUrls = new Set<string>();
  let normalized = markdown.replace(
    MARKDOWN_LINK,
    (
      original,
      label: string,
      url: string,
      offset: number,
      value: string,
    ) => {
      const key = canonicalUrl(url);
      if (key) bodyUrls.add(key);
      const source = allowed.get(key);
      if (!source) {
        unknownUrls.add(url);
        return original;
      }
      let citation = citationsByUrl.get(key);
      if (!citation) {
        citation = {
          id: citationsByUrl.size + 1,
          title: source.title.trim() || urlDisplayName(source.url),
          url: source.url,
        };
        citationsByUrl.set(key, citation);
      }
      const marker = numberedCitationLink(citation);
      const plainLabel = unescapeMarkdownLinkLabel(label);
      const isSemanticTableLink = isMarkdownTableRowAt(value, offset) &&
        !isCitationMarkerLabel(plainLabel) &&
        !isSourceTitleLabel(plainLabel, source);
      return isSemanticTableLink ? `${original}${marker}` : marker;
    },
  );

  const citations = [...citationsByUrl.values()];
  for (const citation of citations) {
    const marker = numberedCitationLink(citation);
    normalized = normalized.replace(
      new RegExp(
        `${escapeRegularExpression(marker)}(?:\\s*${escapeRegularExpression(marker)})+`,
        "gu",
      ),
      marker,
    );
  }

  return {
    markdown: normalized.trim(),
    citations,
    unknownUrls,
    bodyUrls,
  };
}

function referenceSection(citations: readonly VerifiedCitation[]): string {
  if (citations.length === 0) return "";
  const entries = citations.flatMap((citation) => [
    `[${citation.id}] [${
      escapeMarkdownLinkLabel(conciseSourceTitle(citation))
    }](${citation.url})  `,
    `    ${citation.url}`,
    "",
  ]);
  return ["## 参考来源", "", ...entries].join("\n").trim();
}

function stripReferenceSections(markdown: string): string {
  const headings = [...markdown.matchAll(MARKDOWN_HEADING)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    level: match[1]?.length ?? 6,
    label: match[2] ?? "",
  }));
  const removals: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading || !isReferenceHeadingLabel(heading.label)) continue;
    const nextPeer = headings
      .slice(index + 1)
      .find((candidate) => candidate.level <= heading.level);
    removals.push({
      start: heading.start,
      end: nextPeer?.start ?? markdown.length,
    });
  }

  if (removals.length === 0) return stripTrailingReferenceSection(markdown);
  let cursor = 0;
  const retained: string[] = [];
  for (const removal of removals) {
    if (removal.start < cursor) continue;
    retained.push(markdown.slice(cursor, removal.start));
    cursor = removal.end;
  }
  retained.push(markdown.slice(cursor));
  return stripTrailingReferenceSection(retained.join("").trim());
}

function stripTrailingReferenceSection(markdown: string): string {
  const trailingReference = new RegExp(
    String.raw`\n#{1,6}\s*(?:\u53c2\u8003\u6765\u6e90|\u53c2\u8003\u6587\u732e|\u5df2\u9a8c\u8bc1\u6765\u6e90|references?|sources?)\s*\n[\s\S]*$`,
    "iu",
  );
  return markdown.replace(trailingReference, "").trim();
}

function isReferenceHeadingLabel(value: string): boolean {
  const plainLabel = value.replace(/[*_`]/gu, "").trim().toLowerCase();
  if (
    /^(?:references?|sources?)(?:\s*[（(](?:references?|sources?)[）)])?$/u
      .test(plainLabel) ||
    ["\u53c2\u8003\u6765\u6e90", "\u53c2\u8003\u6587\u732e", "\u5df2\u9a8c\u8bc1\u6765\u6e90"].includes(plainLabel)
  ) {
    return true;
  }
  const label = value
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .replace(/[*_`]/gu, "")
    .trim()
    .replace(
      /^[（(]\s*(?:\d+|[一二三四五六七八九十百]+|[ivxlcdm]+)\s*[）)]\s*/iu,
      "",
    )
    .replace(
      /^(?:第\s*)?(?:\d+|[一二三四五六七八九十百]+|[ivxlcdm]+)(?:\s*[章节])?\s*(?:[、.．:：)）-]\s*)?/iu,
      "",
    )
    .trim();
  return /^(?:参考(?:文献|来源)?|已验证来源|references?|sources?)(?:\s*[（(](?:references?|sources?)[）)])?$/iu
    .test(label);
}

function firstHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") return value;
    } catch {
      // Ignore malformed upstream source records.
    }
  }
  return undefined;
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && Boolean(value.trim())
  )?.trim();
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return "";
  }
}

function hostnameTitle(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function isCitationMarkerLabel(value: string): boolean {
  return /^(?:\^\d+|\[\d+\]|\d+)$/u.test(value.trim());
}

function isSourceTitleLabel(
  label: string,
  source: ObservedSource,
): boolean {
  const normalized = normalizedLabel(label);
  return [
    source.title,
    conciseSourceTitle(source),
    urlDisplayName(source.url),
    hostnameTitle(source.url),
  ].some((candidate) => normalizedLabel(candidate) === normalized);
}

function numberedCitationLink(citation: Pick<VerifiedCitation, "id" | "url">) {
  return `[\\[${citation.id}\\]](${citation.url})`;
}

function unescapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\(.)/gu, "$1");
}

function normalizedLabel(value: string): string {
  return unescapeMarkdownLinkLabel(value)
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function isMarkdownTableRowAt(markdown: string, offset: number): boolean {
  const start = markdown.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextBreak = markdown.indexOf("\n", offset);
  const end = nextBreak >= 0 ? nextBreak : markdown.length;
  return /^\s*\|/u.test(markdown.slice(start, end));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function conciseSourceTitle(source: ObservedSource): string {
  const title = source.title.replace(/\s+/gu, " ").trim();
  const github = title.match(
    /^GitHub\s*-\s*([^:]+?)(?:\s*:\s*.*)?\s*·\s*GitHub$/iu,
  );
  if (github?.[1]) {
    return `${github[1].trim()} · GitHub`;
  }
  if (title.length <= 80) return title;
  return urlDisplayName(source.url);
}

function urlDisplayName(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./iu, "");
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    if (hostname.toLowerCase() === "github.com" && segments.length >= 2) {
      return `${segments[0]}/${segments[1]} · GitHub`;
    }
    return segments.length > 0
      ? `${hostname} · ${segments.slice(0, 2).join("/")}`
      : hostname;
  } catch {
    return value;
  }
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/\[/gu, "\\[")
    .replace(/\]/gu, "\\]")
    .replace(/\|/gu, "\\|");
}
