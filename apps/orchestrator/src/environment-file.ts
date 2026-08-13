import { readFile, rename, writeFile } from "node:fs/promises";

export async function replaceEnvironmentValue(
  filePath: string,
  name: string,
  value: string,
): Promise<void> {
  await replaceEnvironmentValues(filePath, { [name]: value });
}

export async function replaceEnvironmentValues(
  filePath: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const entries = Object.entries(values);
  if (!entries.length) return;
  for (const [name, value] of entries) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error("Environment variable name is invalid.");
    }
    if (!value.trim() || /[\r\n]/u.test(value)) {
      throw new Error("API Key must be a non-empty single-line value.");
    }
  }

  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !isMissingFile(error)) throw error;
  }

  let next = current;
  for (const [name, value] of entries) {
    const line = `${name}=${JSON.stringify(value.trim())}`;
    const expression = new RegExp(`^\\s*${name}\\s*=.*$`, "mu");
    next = expression.test(next)
      ? next.replace(expression, line)
      : `${next}${next && !next.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, filePath);
}

function isMissingFile(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
