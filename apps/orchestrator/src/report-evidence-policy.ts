import type { EvidenceBundle } from "./evidence-bundle.js";
import type { ResearchProfile, ResearchSourceMode } from "./research-profile.js";

export type ReportEvidenceStrategy =
  | "public_verified"
  | "private_bounded"
  | "mixed_evidence";

export interface ReportEvidencePolicy {
  strategy: ReportEvidenceStrategy;
  allowedPublicUrls: readonly string[];
  allowsPrivateAttribution: boolean;
  requiresPublicCitationForFact: boolean;
  forbidsExternalLinks: boolean;
  sourceDisclosure: "restricted";
}

export function deriveReportEvidencePolicy(input: {
  profile?: ResearchProfile;
  evidenceBundles?: readonly EvidenceBundle[];
}): ReportEvidencePolicy {
  const bundles = input.evidenceBundles ?? [];
  const publicUrls = uniqueHttpUrls(bundles.flatMap((bundle) =>
    bundle.sources.flatMap((source) =>
      source.visibility === "public" ? [source.url] : []
    )
  ));
  const hasPrivateSources = bundles.some((bundle) =>
    bundle.sources.some((source) => source.visibility === "private")
  );

  if (hasPrivateSources && publicUrls.length > 0) {
    return policy("mixed_evidence", publicUrls);
  }
  if (hasPrivateSources) return policy("private_bounded", []);
  if (publicUrls.length > 0) return policy("public_verified", publicUrls);

  return policy(strategyForProfile(input.profile), []);
}

export function strategyForProfile(
  profile: ResearchProfile | undefined,
): ReportEvidenceStrategy {
  if (!profile) return "public_verified";
  if (profile.mode === "synthesis") return "mixed_evidence";
  return strategyForSource(profile.source.mode, profile.source);
}

function strategyForSource(
  mode: ResearchSourceMode,
  source: ResearchProfile["source"],
): ReportEvidenceStrategy {
  if (mode === "local") return "private_bounded";
  if (mode === "hybrid") return "mixed_evidence";
  return "public_verified";
}

function policy(
  strategy: ReportEvidenceStrategy,
  allowedPublicUrls: readonly string[],
): ReportEvidencePolicy {
  return {
    strategy,
    allowedPublicUrls,
    allowsPrivateAttribution: strategy !== "public_verified",
    requiresPublicCitationForFact: strategy !== "private_bounded",
    forbidsExternalLinks: strategy === "private_bounded",
    sourceDisclosure: "restricted",
  };
}

function uniqueHttpUrls(values: readonly string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const canonical = canonicalHttpUrl(value);
    if (canonical && !result.has(canonical)) result.set(canonical, value);
  }
  return [...result.values()];
}

function canonicalHttpUrl(value: string): string {
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
