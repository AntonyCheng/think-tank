export interface RetrieverCapability {
  id: string;
  label: string;
  category: string;
  selectable: boolean;
  credentialRequired: boolean;
  timeoutMs: number;
}

export interface RuntimeSettings {
  openaiBaseUrl: string;
  aoPlannerModel: string;
  aoVerifierModel: string;
  gptrFastLlm: string;
  gptrSmartLlm: string;
  gptrEmbedding: string;
  gptrEmbeddingBaseUrl: string;
  retrievers: string[];
  retriever: string;
  concurrency: number;
  apiKeyConfigured: boolean;
  embeddingApiKeyConfigured: boolean;
  retrieverCapabilities: RetrieverCapability[];
  maxRetrievers: number;
}

export interface SettingsPreflightCheck {
  id: "model" | "embedding" | "retriever";
  label: string;
  status: "passed" | "failed";
  detail?: string;
}

export interface RuntimeSettingsSaveResult extends RuntimeSettings {
  checks: SettingsPreflightCheck[];
}

export type RuntimeSettingsUpdate = Omit<RuntimeSettings, "retriever" | "apiKeyConfigured" | "embeddingApiKeyConfigured" | "retrieverCapabilities" | "maxRetrievers"> & {
  apiKey?: string;
  embeddingApiKey?: string;
};
