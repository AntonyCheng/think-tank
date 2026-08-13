import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replaceEnvironmentValues } from "../src/environment-file.js";

test("normalizes mixed dotenv line endings when replacing values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "think-tank-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "runtime.env");
  await writeFile(
    filePath,
    "OPENAI_BASE_URL=http://models.example/v1\rOPENAI_API_KEY=old\r\nMODEL=planner\n",
    "utf8",
  );

  await replaceEnvironmentValues(filePath, {
    OPENAI_API_KEY: "replacement-secret",
  });

  assert.equal(
    await readFile(filePath, "utf8"),
    "OPENAI_BASE_URL=http://models.example/v1\n"
      + 'OPENAI_API_KEY="replacement-secret"\n'
      + "MODEL=planner\n",
  );
});
