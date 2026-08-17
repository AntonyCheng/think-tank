import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RuntimeSettingsStore,
  SqliteRuntimeSettingsPersistence,
} from "../src/settings-store.js";

const baseEnv = {
  OPENAI_API_KEY: "secret",
  OPENAI_BASE_URL: "https://models.example/v1",
  AO_PLANNER_MODEL: "planner",
  AO_VERIFIER_MODEL: "",
  GPTR_FAST_LLM: "fast",
  GPTR_SMART_LLM: "smart",
  GPTR_EMBEDDING: "m3e",
  GPTR_EMBEDDING_BASE_URL: "https://embedding.example/v1",
  GPTR_EMBEDDING_API_KEY: "embedding-secret",
  RETRIEVER: "duckduckgo",
  AO_CONCURRENCY: "2",
};

test("updates deployment settings without exposing the API key", () => {
  const store = new RuntimeSettingsStore(baseEnv);

  const updated = store.update({
    retriever: "tavily",
    concurrency: 3,
    gptrEmbeddingBaseUrl: "https://new-embedding.example/v1",
  });

  assert.equal(updated.retriever, "tavily");
  assert.equal(updated.concurrency, 3);
  assert.equal(
    updated.gptrEmbeddingBaseUrl,
    "https://new-embedding.example/v1",
  );
  assert.equal(updated.apiKeyConfigured, true);
  assert.equal(updated.embeddingApiKeyConfigured, true);
  assert.equal("apiKey" in updated, false);
  assert.equal("embeddingApiKey" in updated, false);
  assert.equal(store.getRuntimeSettings().planner.api_key, "secret");
  assert.equal(
    store.getRuntimeSettings().gptrEmbeddingApiKey,
    "embedding-secret",
  );
});

test("returns bare GPTR model names while preserving runtime provider prefixes", () => {
  const store = new RuntimeSettingsStore(baseEnv);

  const publicSettings = store.getPublicSettings();
  assert.equal(publicSettings.gptrFastLlm, "fast");
  assert.equal(publicSettings.gptrSmartLlm, "smart");
  assert.equal(publicSettings.gptrEmbedding, "m3e");

  store.update({ gptrFastLlm: "fast-v2", gptrEmbedding: "m3e-v2" });
  const runtime = store.getRuntimeSettings();
  assert.equal(runtime.gptrFastLlm, "openai:fast-v2");
  assert.equal(runtime.gptrEmbedding, "custom:m3e-v2");
});

test("stores an optional fallback model provider without exposing its API key", () => {
  const store = new RuntimeSettingsStore(baseEnv);
  store.setFallbackApiKey("fallback-secret");
  const updated = store.update({
    fallbackEnabled: true,
    fallbackOpenaiBaseUrl: "https://backup.example/v1",
    fallbackAoPlannerModel: "backup-planner",
    fallbackAoVerifierModel: "backup-verifier",
    fallbackGptrFastLlm: "backup-fast",
    fallbackGptrSmartLlm: "backup-smart",
  });

  assert.equal(updated.fallbackEnabled, true);
  assert.equal(updated.fallbackApiKeyConfigured, true);
  assert.equal("fallbackApiKey" in updated, false);
  assert.deepEqual(store.getRuntimeSettings().fallback, {
    baseUrl: "https://backup.example/v1",
    apiKey: "fallback-secret",
    plannerModel: "backup-planner",
    verifierModel: "backup-verifier",
    fastLlm: "openai:backup-fast",
    smartLlm: "openai:backup-smart",
  });
});

test("updates the default multi-retriever grant", () => {
  const store = new RuntimeSettingsStore(baseEnv);

  const updated = store.update({
    retrievers: ["duckduckgo", "openalex"],
  });

  assert.deepEqual(updated.retrievers, ["duckduckgo", "openalex"]);
  assert.equal(updated.retriever, "duckduckgo");
  assert.deepEqual(
    store.getRuntimeSettings().retrievers,
    ["duckduckgo", "openalex"],
  );
});

test("persists editable model settings and encrypted keys in SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "think-tank-settings-"));
  const database = new DatabaseSync(join(directory, "settings.sqlite"));
  try {
    const first = new RuntimeSettingsStore(
      baseEnv,
      undefined,
      new SqliteRuntimeSettingsPersistence(database, "service-secret"),
    );
    first.setApiKey("replacement-secret");
    first.setEmbeddingApiKey("replacement-embedding-secret");
    first.setRetrieverApiKeys({ tavily: "replacement-tavily-secret" });
    first.update({
      aoPlannerModel: "planner-v2",
      retrievers: ["duckduckgo", "openalex"],
    });

    const raw = database.prepare(`
      SELECT settings_json, secrets_ciphertext FROM runtime_settings WHERE id = 1
    `).get() as { settings_json: string; secrets_ciphertext: string };
    assert.match(raw.settings_json, /planner-v2/);
    assert.doesNotMatch(raw.secrets_ciphertext, /replacement-secret/);
    assert.doesNotMatch(raw.secrets_ciphertext, /replacement-tavily-secret/);

    const second = new RuntimeSettingsStore(
      baseEnv,
      undefined,
      new SqliteRuntimeSettingsPersistence(database, "service-secret"),
    );
    assert.equal(second.getRuntimeSettings().planner.model, "planner-v2");
    assert.equal(second.getRuntimeSettings().planner.api_key, "replacement-secret");
    assert.equal(
      second.getRuntimeSettings().gptrEmbeddingApiKey,
      "replacement-embedding-secret",
    );
    assert.equal(
      second.getRuntimeSettings().retrieverApiKeys.tavily,
      "replacement-tavily-secret",
    );
    assert.deepEqual(
      second.getPublicSettings().configuredRetrieverCredentials,
      ["tavily"],
    );
    assert.deepEqual(second.getRuntimeSettings().retrievers, [
      "duckduckgo",
      "openalex",
    ]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("imports legacy file settings before creating the database record", () => {
  const directory = mkdtempSync(join(tmpdir(), "think-tank-settings-import-"));
  const database = new DatabaseSync(join(directory, "settings.sqlite"));
  const legacyPath = join(directory, "settings.json");
  try {
    writeFileSync(legacyPath, JSON.stringify({
      aoPlannerModel: "legacy-planner",
      concurrency: 3,
    }), "utf8");
    const store = new RuntimeSettingsStore(
      baseEnv,
      legacyPath,
      new SqliteRuntimeSettingsPersistence(database, "service-secret"),
    );
    assert.equal(store.getRuntimeSettings().planner.model, "legacy-planner");
    assert.equal(store.getRuntimeSettings().concurrency, 3);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
