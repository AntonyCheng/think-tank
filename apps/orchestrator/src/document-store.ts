import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

export interface StoredDocument {
  documentId: string;
  taskId: string;
  displayName: string;
  mediaType:
    | "application/pdf"
    | "application/msword"
    | "application/vnd.ms-excel"
    | "application/vnd.ms-powerpoint"
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    | "text/csv"
    | "text/plain"
    | "text/markdown";
  byteSize: number;
  sha256: string;
  locator: string;
  status: "ready";
}

export interface DocumentStoreLimits {
  maxBytes: number;
  maxTaskBytes: number;
  maxCount: number;
}

const defaultLimits: DocumentStoreLimits = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxTaskBytes: 100 * 1024 * 1024,
  maxCount: 20,
});

export class TaskDocumentStore {
  readonly #root: string;
  readonly #limits: DocumentStoreLimits;

  constructor(
    root = process.env.LOCAL_DOCUMENTS_ROOT ??
      resolve(".think-tank", "documents"),
    limits: DocumentStoreLimits = limitsFromEnvironment(process.env),
  ) {
    this.#root = resolve(root);
    this.#limits = { ...limits };
  }

  async save(
    taskId: string,
    displayName: string,
    content: Buffer,
  ): Promise<StoredDocument> {
    assertIdentifier(taskId, "task");
    const name = validDisplayName(displayName);
    if (content.length > this.#limits.maxBytes) {
      throw new Error("document exceeds the per-file size limit");
    }
    const existing = await this.list(taskId);
    if (existing.length >= this.#limits.maxCount) {
      throw new Error("task has reached the document count limit");
    }
    if (
      existing.reduce((total, record) => total + record.byteSize, 0) +
        content.length > this.#limits.maxTaskBytes
    ) {
      throw new Error("documents exceed the task size limit");
    }

    const mediaType = documentType(name, content);
    const documentId = `doc_${randomUUID().replaceAll("-", "")}`;
    const taskRoot = this.#taskRoot(taskId);
    const directory = resolve(taskRoot, documentId);
    assertContained(taskRoot, directory);
    await mkdir(taskRoot, { recursive: true });
    await mkdir(directory);

    try {
      const record: StoredDocument = {
        documentId,
        taskId,
        displayName: name,
        mediaType,
        byteSize: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        locator: `document:${documentId}`,
        status: "ready",
      };
      const temporary = resolve(directory, "upload.tmp");
      await writeFile(temporary, content, { flag: "wx" });
      await rename(
        temporary,
        resolve(directory, `content.${storageExtension(mediaType)}`),
      );
      await writeFile(
        resolve(directory, "record.json"),
        JSON.stringify(record),
        "utf8",
      );
      return record;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async list(taskId: string): Promise<StoredDocument[]> {
    assertIdentifier(taskId, "task");
    const taskRoot = this.#taskRoot(taskId);
    let entries;
    try {
      entries = await readdir(taskRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const candidate = JSON.parse(
              await readFile(
                resolve(taskRoot, entry.name, "record.json"),
                "utf8",
              ),
            ) as StoredDocument;
            return candidate.taskId === taskId &&
                candidate.documentId === entry.name
              ? candidate
              : undefined;
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is StoredDocument => Boolean(record))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
  }

  async copyTask(sourceTaskId: string, targetTaskId: string): Promise<Map<string, string>> {
    assertIdentifier(sourceTaskId, "source task");
    assertIdentifier(targetTaskId, "target task");
    const copiedIds = new Map<string, string>();
    const sourceDocuments = await this.list(sourceTaskId);
    try {
      for (const document of sourceDocuments) {
        const content = await readFile(resolve(
          this.#taskRoot(sourceTaskId),
          document.documentId,
          `content.${storageExtension(document.mediaType)}`,
        ));
        const copied = await this.save(targetTaskId, document.displayName, content);
        copiedIds.set(document.documentId, copied.documentId);
      }
      return copiedIds;
    } catch (error) {
      await this.deleteTask(targetTaskId);
      throw error;
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    assertIdentifier(taskId, "task");
    await rm(this.#taskRoot(taskId), { recursive: true, force: true });
  }

  #taskRoot(taskId: string): string {
    const taskRoot = resolve(this.#root, taskId);
    assertContained(this.#root, taskRoot);
    return taskRoot;
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error(`invalid ${label} id`);
  }
}

function validDisplayName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name !== basename(name) ||
    name.length > 180 ||
    /[\u0000-\u001f]/u.test(name)
  ) {
    throw new Error("invalid document name");
  }
  return name;
}

function assertContained(parent: string, child: string): void {
  const candidate = relative(parent, child);
  if (!candidate || candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new Error("invalid document path");
  }
}

const OOXML_MEDIA_TYPES: Record<string, StoredDocument["mediaType"]> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const OLE2_MEDIA_TYPES: Record<string, StoredDocument["mediaType"]> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
};

const STORAGE_EXTENSIONS: Record<StoredDocument["mediaType"], string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
};

function documentType(
  name: string,
  content: Buffer,
): StoredDocument["mediaType"] {
  const suffix = name.toLowerCase().slice(name.lastIndexOf("."));
  if (
    suffix === ".pdf" &&
    content.subarray(0, 5).toString("ascii") === "%PDF-"
  ) {
    return "application/pdf";
  }
  if (
    suffix in OLE2_MEDIA_TYPES &&
    content
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) {
    return OLE2_MEDIA_TYPES[suffix]!;
  }
  if (
    suffix in OOXML_MEDIA_TYPES &&
    content
      .subarray(0, 4)
      .equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    return OOXML_MEDIA_TYPES[suffix]!;
  }
  if ([".txt", ".md", ".markdown", ".csv"].includes(suffix) && !content.includes(0)) {
    if (suffix === ".csv") return "text/csv";
    return suffix === ".txt" ? "text/plain" : "text/markdown";
  }
  throw new Error("document type is not allowed");
}

function storageExtension(mediaType: StoredDocument["mediaType"]): string {
  return STORAGE_EXTENSIONS[mediaType];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function limitsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): DocumentStoreLimits {
  return {
    maxBytes: positiveInteger(
      environment.LOCAL_DOCUMENT_MAX_BYTES,
      defaultLimits.maxBytes,
    ),
    maxTaskBytes: positiveInteger(
      environment.LOCAL_DOCUMENT_TASK_MAX_BYTES,
      defaultLimits.maxTaskBytes,
    ),
    maxCount: positiveInteger(
      environment.LOCAL_DOCUMENT_MAX_COUNT,
      defaultLimits.maxCount,
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("document limit configuration must be a positive integer");
  }
  return parsed;
}
