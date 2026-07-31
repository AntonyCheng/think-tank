import { readFile, rename, writeFile } from "node:fs/promises";

export async function replaceEnvironmentValue(
  filePath: string,
  name: string,
  value: string,
): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
    throw new Error("Environment variable name is invalid.");
  }
  if (!value.trim() || /[\r\n]/u.test(value)) {
    throw new Error("API Key must be a non-empty single-line value.");
  }

  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !isMissingFile(error)) throw error;
  }

  const line = `${name}=${JSON.stringify(value.trim())}`;
  const expression = new RegExp(`^\\s*${name}\\s*=.*$`, "mu");
  const next = expression.test(current)
    ? current.replace(expression, line)
    : `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`;
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, next, "utf8");
  await rename(temporary, filePath);
}

function isMissingFile(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
