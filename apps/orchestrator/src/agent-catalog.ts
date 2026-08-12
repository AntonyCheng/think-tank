import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface AgentCatalogEntry {
  id: string;
  name: string;
  emoji: string;
}

const catalogCache = new Map<string, Promise<readonly AgentCatalogEntry[]>>();

export function loadAgentCatalog(agentsDir: string): Promise<readonly AgentCatalogEntry[]> {
  const root = resolve(agentsDir);
  const cached = catalogCache.get(root);
  if (cached) return cached;
  const catalog = readAgentCatalog(root);
  catalogCache.set(root, catalog);
  return catalog;
}

async function readAgentCatalog(agentsDir: string): Promise<readonly AgentCatalogEntry[]> {
  const files = await markdownFiles(agentsDir);
  const entries = await Promise.all(files.map(async (path) => {
    const source = await readFile(path, "utf8");
    const fields = frontmatterFields(source);
    if (!fields.name || !fields.emoji) return undefined;
    return Object.freeze({
      id: relative(agentsDir, path).replace(/\\/gu, "/").replace(/\.md$/u, ""),
      name: fields.name,
      emoji: fields.emoji,
    });
  }));
  return Object.freeze(entries.filter((entry): entry is AgentCatalogEntry => Boolean(entry)).sort((left, right) => left.id.localeCompare(right.id)));
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  }));
  return nested.flat();
}

function frontmatterFields(source: string): { name?: string; emoji?: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)?.[1];
  if (!frontmatter) return {};
  return { name: valueFor(frontmatter, "name"), emoji: valueFor(frontmatter, "emoji") };
}

function valueFor(frontmatter: string, field: string): string | undefined {
  const value = new RegExp(`^${field}:\\s*(.*?)\\s*$`, "mu").exec(frontmatter)?.[1]?.trim();
  return value || undefined;
}
