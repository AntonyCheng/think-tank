import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSourceScopeWithinTask,
} from "../src/research-source-scope.js";
import { ResearchProfileError } from "../src/research-profile.js";

test("AO cannot enable web search for a URL-only task", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "urls",
          urls: ["https://example.com/report"],
        },
        {
          mode: "urls",
          urls: ["https://example.com/report"],
          web: {
            retrievers: ["duckduckgo"],
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.web");
      return true;
    },
  );
});

test("AO cannot replace a URL-only task with pure Web search", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "urls",
          urls: ["https://example.com/report"],
        },
        {
          mode: "web",
          retrievers: ["duckduckgo"],
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.mode");
      return true;
    },
  );
});

test("AO may close Web supplementation for a URL plus Web task", () => {
  assert.doesNotThrow(() =>
    assertSourceScopeWithinTask(
      {
        mode: "urls",
        urls: ["https://example.com/report"],
        web: {
          retrievers: ["duckduckgo"],
          includeDomains: ["example.com"],
          excludeDomains: ["ads.example.com"],
        },
      },
      {
        mode: "urls",
        urls: ["https://example.com/report"],
      },
    )
  );
});

test("AO cannot add a URL outside the task source grant", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "urls",
          urls: ["https://example.com/report"],
        },
        {
          mode: "urls",
          urls: [
            "https://example.com/report",
            "https://outside.example.net/report",
          ],
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.urls");
      return true;
    },
  );
});

test("AO source grant treats equivalent canonical URLs as the same URL", () => {
  assert.doesNotThrow(() =>
    assertSourceScopeWithinTask(
      {
        mode: "urls",
        urls: ["HTTPS://Example.COM:443/report"],
      },
      {
        mode: "urls",
        urls: ["https://example.com/report"],
      },
    )
  );
});

test("AO cannot broaden the task domain allowlist", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "web",
          retrievers: ["duckduckgo"],
          includeDomains: ["example.com"],
        },
        {
          mode: "web",
          retrievers: ["duckduckgo"],
          includeDomains: ["example.com", "outside.example.net"],
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.includeDomains");
      return true;
    },
  );
});

test("AO cannot invent specified URLs for a Web task", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "web",
          retrievers: ["duckduckgo"],
        },
        {
          mode: "urls",
          urls: ["https://example.com/invented"],
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.mode");
      return true;
    },
  );
});

test("AO cannot remove task-level excluded domains", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "web",
          retrievers: ["duckduckgo"],
          excludeDomains: ["blocked.example"],
        },
        {
          mode: "web",
          retrievers: ["duckduckgo"],
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof ResearchProfileError);
      assert.equal(error.code, "profile_capability_disabled");
      assert.equal(error.path, "$.source.excludeDomains");
      return true;
    },
  );
});

test("AO may narrow the task retriever grant", () => {
  assert.doesNotThrow(() =>
    assertSourceScopeWithinTask(
      {
        mode: "web",
        retrievers: ["duckduckgo", "openalex"],
      },
      {
        mode: "web",
        retrievers: ["openalex"],
      },
    ),
  );
});

test("AO cannot add a retriever outside the task source grant", () => {
  assert.throws(
    () =>
      assertSourceScopeWithinTask(
        {
          mode: "web",
          retrievers: ["duckduckgo"],
        },
        {
          mode: "web",
          retrievers: ["duckduckgo", "openalex"],
        },
      ),
    (error: unknown) =>
      error instanceof ResearchProfileError
      && error.code === "profile_capability_disabled"
      && error.path === "$.source.retrievers",
  );
});
