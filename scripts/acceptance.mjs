import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
const pythonCandidates = process.platform === "win32"
  ? [resolve(root, ".venv", "Scripts", "python.exe")]
  : [resolve(root, ".venv", "bin", "python")];
const python = pythonCandidates.find(existsSync);

if (!python) {
  throw new Error(
    "Project .venv was not found. Create it before running acceptance.",
  );
}
if (!npmCli) {
  throw new Error("Run acceptance through: npm run test:acceptance");
}

run(process.execPath, [npmCli, "test"]);
run(process.execPath, [npmCli, "run", "typecheck"]);
run(process.execPath, [npmCli, "run", "build"]);

const pythonPathEntries = [resolve(root, "services", "researcher")];
if (process.platform === "win32") {
  pythonPathEntries.push(resolve(root, ".venv", "Lib", "site-packages"));
}
const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  PYTHONPATH: [...pythonPathEntries, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(delimiter),
};
const pytestTempRoot = resolve(root, ".think-tank", "test-tmp");
mkdirSync(pytestTempRoot, { recursive: true });

run(
  python,
  [
    "-m",
    "pytest",
    "services/researcher/test",
    "-q",
    "--basetemp",
    resolve(pytestTempRoot, "pytest"),
  ],
  pythonEnv,
);

process.stdout.write("\nAutomated V1 acceptance passed.\n");

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
