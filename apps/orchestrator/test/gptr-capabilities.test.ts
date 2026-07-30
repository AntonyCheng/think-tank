import assert from "node:assert/strict";
import test from "node:test";

import {
  CachedResearchCapabilityProvider,
  HttpResearchCapabilityProvider,
} from "../src/gptr-capabilities.js";

test("reads the researcher retriever capability catalog", async () => {
  const provider = new HttpResearchCapabilityProvider(
    async (input) => {
      assert.equal(
        String(input),
        "http://researcher.example/capabilities",
      );
      return new Response(JSON.stringify({
        schemaVersion: 1,
        retrievers: [
          {
            id: "duckduckgo",
            label: "DuckDuckGo",
            category: "web",
            selectable: true,
            credentialRequired: false,
            timeoutMs: 20000,
          },
          {
            id: "openalex",
            label: "OpenAlex",
            category: "academic",
            selectable: true,
            credentialRequired: false,
            timeoutMs: 20000,
          },
        ],
        maxRetrievers: 2,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const catalog = await provider.getCatalog(
    "http://researcher.example",
    5_000,
  );

  assert.deepEqual(
    catalog.retrievers.map((item) => item.id),
    ["duckduckgo", "openalex"],
  );
  assert.equal(catalog.maxRetrievers, 2);
  assert.ok(Object.isFrozen(catalog));
});

test("rejects an unknown researcher retriever capability", async () => {
  const provider = new HttpResearchCapabilityProvider(
    async () => new Response(JSON.stringify({
      schemaVersion: 1,
      retrievers: [{
        id: "invented",
        label: "Invented",
        category: "web",
        selectable: true,
        credentialRequired: false,
        timeoutMs: 20000,
      }],
      maxRetrievers: 1,
    })),
  );

  await assert.rejects(
    provider.getCatalog("http://researcher.example", 5_000),
    /unknown retriever/u,
  );
});

test("caches the most recent successful capability catalog", async () => {
  let calls = 0;
  let now = 1_000;
  const cached = new CachedResearchCapabilityProvider(
    {
      async getCatalog() {
        calls += 1;
        return {
          schemaVersion: 1,
          retrievers: [],
          maxRetrievers: 0,
        };
      },
    },
    30_000,
    () => now,
  );

  await cached.getCatalog("http://researcher.example", 5_000);
  now += 10_000;
  await cached.getCatalog("http://researcher.example", 5_000);

  assert.equal(calls, 1);

  now += 30_000;
  await cached.getCatalog("http://researcher.example", 5_000);
  assert.equal(calls, 2);
});
