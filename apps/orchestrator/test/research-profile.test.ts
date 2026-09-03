import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ResearchProfileError,
  resolveResearchProfile,
  type ResearchCapabilities,
  type ResearchProfileDefaults,
} from "../src/research-profile.js";
import {
  currentResearchProfileEnvironment,
} from "../src/research-profile-runtime.js";

interface FixtureCase {
  name: string;
  environment: string;
  input: unknown;
  expected?: unknown;
  error?: {
    code: string;
    path: string;
  };
}

interface FixtureEnvironment {
  defaults: ResearchProfileDefaults;
  capabilities: ResearchCapabilities;
}

interface FixtureFile {
  environments: Record<string, FixtureEnvironment>;
  cases: FixtureCase[];
}

const fixtures = JSON.parse(
  readFileSync(
    new URL(
      "../../../contracts/research-profile/v1/cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as FixtureFile;

for (const fixture of fixtures.cases) {
  test(`ResearchProfile: ${fixture.name}`, () => {
    const environment = fixtures.environments[fixture.environment];
    assert.ok(environment, `unknown fixture environment ${fixture.environment}`);

    if (fixture.expected !== undefined) {
      const result = resolveResearchProfile(
        fixture.input,
        environment.defaults,
        environment.capabilities,
      );
      assert.deepEqual(result, fixture.expected);
      assert.equal(isDeeplyFrozen(result), true);
      return;
    }

    assert.throws(
      () =>
        resolveResearchProfile(
          fixture.input,
          environment.defaults,
          environment.capabilities,
        ),
      (error: unknown) => {
        assert.ok(error instanceof ResearchProfileError);
        assert.equal(error.code, fixture.error?.code);
        assert.equal(error.path, fixture.error?.path);
        return true;
      },
    );
  });
}

test("current deployment accepts standard URL sources and domain filters", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");
  const profile = resolveResearchProfile(
    {
      source: {
        mode: "urls",
        urls: ["https://example.com/report"],
        web: {
          retrievers: ["duckduckgo"],
          includeDomains: ["example.com"],
        },
      },
    },
    environment.defaults,
    environment.capabilities,
  );

  assert.equal(profile.source.mode, "urls");
  assert.deepEqual(environment.capabilities.sourceModes, ["web", "urls", "local", "hybrid"]);
  assert.equal(environment.capabilities.domainFilters, true);
});

test("current deployment exposes the ready multi-retriever set", () => {
  const environment = currentResearchProfileEnvironment(
    ["duckduckgo", "openalex"],
    undefined,
    2,
  );

  const profile = resolveResearchProfile(
    {
      source: {
        mode: "web",
        retrievers: ["duckduckgo", "openalex"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );

  assert.deepEqual(profile.source, {
    mode: "web",
    retrievers: ["duckduckgo", "openalex"],
  });
  assert.deepEqual(
    environment.capabilities.retrievers,
    ["duckduckgo", "openalex"],
  );
  assert.equal(environment.capabilities.maxRetrievers, 2);
});

test("current deployment accepts URL sources for deep research", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");

  const profile = resolveResearchProfile(
    {
      mode: "deep",
      deep: {
        breadth: 2,
        depth: 2,
        concurrency: 2,
      },
      source: {
        mode: "urls",
        urls: ["https://example.com/report"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );

  assert.equal(profile.mode, "deep");
  assert.equal(profile.source.mode, "urls");
});

test("current deployment accepts strict domain filters for deep research", () => {
  const environment = currentResearchProfileEnvironment("duckduckgo");

  const profile = resolveResearchProfile(
    {
      mode: "deep",
      deep: {
        breadth: 2,
        depth: 2,
        concurrency: 2,
      },
      source: {
        mode: "web",
        retrievers: ["duckduckgo"],
        includeDomains: ["example.com"],
      },
    },
    environment.defaults,
    environment.capabilities,
  );

  assert.equal(profile.mode, "deep");
  assert.deepEqual(
    profile.source.mode === "web" ? profile.source.includeDomains : [],
    ["example.com"],
  );
});

function isDeeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeeplyFrozen);
}
