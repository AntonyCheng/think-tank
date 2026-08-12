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
  retrieverCapabilities: RetrieverCapability[];
  maxRetrievers: number;
}

export type RuntimeSettingsUpdate = Omit<RuntimeSettings, "retriever" | "apiKeyConfigured" | "retrieverCapabilities" | "maxRetrievers"> & {
  apiKey?: string;
};
