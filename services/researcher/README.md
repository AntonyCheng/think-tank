# Researcher service

This service is always run with the repository-root virtual environment.

## Start on Windows

```powershell
.\.venv\Scripts\python.exe -m pip install -r services\researcher\requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app `
  --app-dir services\researcher `
  --host 127.0.0.1 `
  --port 8010
```

## Start on Linux or macOS

```bash
./.venv/bin/python -m pip install -r services/researcher/requirements.txt
./.venv/bin/python -m uvicorn app.main:app \
  --app-dir services/researcher \
  --host 127.0.0.1 \
  --port 8010
```

## Isolated research workers

The FastAPI process never changes model or retriever environment variables for
an individual request. Each GPTR run uses a separate Python `spawn` process,
which keeps concurrent AO expert steps from sharing model endpoints, API keys,
embedding settings, or retrievers. Events and the final result return to the
parent over an internal process queue, so `/research/stream` remains NDJSON.

`GPTR_WORKER_CONCURRENCY` limits simultaneous GPTR processes and defaults to
`2`. Keep it aligned with available memory and `AO_CONCURRENCY`; extra requests
wait without starting another process. Request cancellation and application
shutdown terminate and reap active workers.
