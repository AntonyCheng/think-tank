# Repository Guidelines

## Project Structure & Module Organization

- `apps/orchestrator/src/` contains the TypeScript API, AO workflow integration, GPTR connector, citation normalization, settings, and task lifecycle.
- `apps/orchestrator/test/` contains Node test-runner suites named `*.test.ts`.
- `apps/web/public/` is the dependency-light frontend (`index.html`, `app.js`, and `styles.css`) served by the API.
- `services/researcher/app/` contains the FastAPI GPTR adapter and document exporter; `services/researcher/test/` contains Pytest tests.
- `services/researcher/assets/fonts/` holds the licensed PDF font asset.
- `scripts/` contains acceptance tooling; executable tests and source code are the current behavioral reference.
- Generated workflows, exports, settings, logs, `.venv/`, and `node_modules/` are local artifacts and should not be committed.

## Build, Test, and Development Commands

- `npm install` installs Node workspace dependencies.
- `npm run api` starts the combined API and static frontend on port 3000; start the researcher service first.
- `.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir services/researcher --host 127.0.0.1 --port 8010` starts GPTR on Windows.
- `npm test` runs TypeScript tests.
- `npm run typecheck` checks strict TypeScript without emitting files.
- `npm run build` compiles the orchestrator.
- `npm run test:acceptance` runs the end-to-end contract checks.
- From `services/researcher`, run `..\..\.venv\Scripts\python.exe -m pytest test -q`.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript/JavaScript and four spaces in Python. Prefer small, typed modules, `camelCase` variables/functions, `PascalCase` types/classes, and kebab-case TypeScript filenames. Python uses `snake_case` and PEP 8 conventions. No formatter or linter is configured, so match adjacent code and keep `npm run typecheck` clean. Preserve UTF-8 for Chinese UI text and logs.

## Testing Guidelines

Add tests beside the relevant subsystem: `feature.test.ts` for Node and `test_feature.py` for Python. Cover API contracts, terminal task states, citations, export links, and failure paths. Changes to document export must pass the three-platform workflow in `.github/workflows/document-export-matrix.yml`.

## Commit & Pull Request Guidelines

This workspace snapshot contains no Git history, so no established commit convention can be inferred. Use short imperative subjects, optionally scoped, such as `export: embed CJK font in PDF`. Pull requests should explain behavior changes, list verification commands, link relevant issues, and include screenshots for frontend changes. Never commit `.env`, API keys, private endpoint credentials, generated reports, or logs.
