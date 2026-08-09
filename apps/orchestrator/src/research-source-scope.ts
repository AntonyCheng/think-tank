import {
  ResearchProfileError,
  type ResearchSourcePolicy,
  type WebSearchPolicy,
} from "./research-profile.js";

export function assertSourceScopeWithinTask(
  taskSource: ResearchSourcePolicy,
  stepSource: ResearchSourcePolicy,
): void {
  if (taskSource.mode === "web" && stepSource.mode !== "web") {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.mode",
      "An AO step cannot introduce specified sources for a Web task.",
    );
  }

  if (taskSource.mode === "urls" && stepSource.mode !== "urls") {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.mode",
      "An AO step cannot replace task-granted URLs with pure Web search.",
    );
  }

  if (taskSource.mode === "local" && stepSource.mode !== "local") {
    throw new ResearchProfileError("profile_capability_disabled", "$.source.mode", "An AO step cannot introduce Web or other sources for a local-document task.");
  }
  if (taskSource.mode === "hybrid" && stepSource.mode !== "hybrid") {
    throw new ResearchProfileError("profile_capability_disabled", "$.source.mode", "An AO step cannot replace a hybrid task source grant.");
  }
  if (
    (taskSource.mode === "local" || taskSource.mode === "hybrid") &&
    (stepSource.mode === "local" || stepSource.mode === "hybrid") &&
    stepSource.documentIds.some((id) => !taskSource.documentIds.includes(id))
  ) {
    throw new ResearchProfileError("profile_capability_disabled", "$.source.documentIds", "An AO step cannot add documents outside the task source grant.");
  }

  if (taskSource.mode === "urls" && stepSource.mode === "urls") {
    const grantedUrls = new Set(taskSource.urls.map(canonicalScopeUrl));
    if (
      stepSource.urls.some(
        (url) => !grantedUrls.has(canonicalScopeUrl(url)),
      )
) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.source.urls",
        "An AO step cannot add URLs outside the task source grant.",
      );
    }
  }

  const taskWeb = webPolicyFrom(taskSource);
  const stepWeb = webPolicyFrom(stepSource);
  if (
    taskWeb
    && stepWeb
    && stepWeb.retrievers.some(
      (retriever) => !taskWeb.retrievers.includes(retriever),
    )
  ) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.retrievers",
      "An AO step cannot add retrievers outside the task source grant.",
    );
  }
  if (taskWeb?.includeDomains && stepWeb) {
    const stepDomains = stepWeb?.includeDomains ?? [];
    if (
      stepDomains.length === 0 ||
      stepDomains.some(
        (domain) =>
          !taskWeb.includeDomains?.some(
            (granted) => domainWithin(domain, granted),
          ),
      )
    ) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.source.includeDomains",
        "An AO step cannot broaden the task domain allowlist.",
      );
    }
  }

  if (taskWeb?.excludeDomains && stepWeb) {
    const stepDomains = stepWeb?.excludeDomains ?? [];
    if (
      taskWeb.excludeDomains.some(
        (blocked) =>
          !stepDomains.some(
            (stepBlocked) => domainWithin(blocked, stepBlocked),
          ),
      )
    ) {
      throw new ResearchProfileError(
        "profile_capability_disabled",
        "$.source.excludeDomains",
        "An AO step cannot remove task-level excluded domains.",
      );
    }
  }

  if (
    taskSource.mode === "urls" &&
    taskSource.web === undefined &&
    stepSource.mode === "urls" &&
    stepSource.web !== undefined
  ) {
    throw new ResearchProfileError(
      "profile_capability_disabled",
      "$.source.web",
      "An AO step cannot enable Web search for a URL-only task.",
    );
  }
}

function webPolicyFrom(
  source: ResearchSourcePolicy,
): WebSearchPolicy | undefined {
  if (source.mode === "web") return source;
  return "web" in source ? source.web : undefined;
}

function domainWithin(domain: string, granted: string): boolean {
  return domain === granted || domain.endsWith(`.${granted}`);
}

function canonicalScopeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}
