# File Server

The static file server lives in `internal/fileserver/` and serves the `public/` directory over HTTP. It uses the Gin framework in release mode with a custom logging middleware and hand-rolled file serving logic — it does **not** use `http.FileServer` or Gin's static file helpers.

## Endpoints

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET`  | `/*` | Serves files from the public directory. `/` resolves to `/index.html`. |
| `HEAD` | `/*` | Returns headers only (Content-Length, Content-Type, Last-Modified). |

All other HTTP methods return `405 Method Not Allowed` with an `Allow: GET, HEAD` header.

## CLI Usage

```
raycaster serve [dir] [-f|--force]
```

- **`dir`** (optional) — path to the public directory, relative to CWD. Defaults to `public/`.
- **`-f` / `--force`** — start the server even if startup health checks fail.

## Request Processing Pipeline

1. **Logging Middleware** (`middleware.go`) — records client IP, timestamp, method, path, colour-coded status, and response time in milliseconds.
2. **Method Guard** — rejects non-GET/HEAD with 405.
3. **URL Parsing** (`parseRequestPath`) — strips query strings, decodes percent-encoding, enforces a 2048-character URI limit.
4. **Path Resolution** (`safeResolve`) — joins the request path to the public root, runs `filepath.Clean()`, and validates the result stays within the public directory to prevent path traversal. Control characters (`\x00–\x1f`) are rejected outright.
5. **File Serving** (`serveFile` → `serveFileContents`) — stats the resolved path, handles directories by looking for `index.html`, and streams the file with proper headers.

## Caching Strategy

| File Type | Cache-Control Header | Behaviour |
|-----------|---------------------|-----------|
| `.html`   | `no-cache, must-revalidate` | Browser keeps a local copy but always revalidates with a conditional request. |
| All other | `public, max-age=0, must-revalidate` | Same revalidation, but explicitly allows shared caches (CDN/proxy). |

**Conditional GET** is supported via `If-Modified-Since` / `Last-Modified`. The server returns `304 Not Modified` when the file hasn't changed, avoiding full re-downloads.

## Range Request Support

The server supports single-range `bytes=` requests for partial content delivery:
- `bytes=0-499` — first 500 bytes
- `bytes=500-` — everything from byte 500 onward
- `bytes=-500` — last 500 bytes

Invalid ranges return `416 Range Not Satisfiable` with the correct `Content-Range: bytes */size` header.

## Startup Health Checks

Before binding the port, the server runs four checks (`checkup.go`):

1. **Public directory exists** and is readable
2. **`index.html` exists** and is a regular file
3. **Simulated GET `/`** — resolves the path, stats and reads one byte
4. **MIME type detection** — verifies `.html` maps to `text/html`

If any check fails, the server exits with a diagnostic summary unless `--force` is provided.

## MIME Type Coverage

Supported extensions: `.html`, `.js`, `.mjs`, `.css`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`. Unrecognised extensions fall back to `application/octet-stream`.

## Error Responses

All errors are returned as minimal HTML pages with `Cache-Control: no-store` to prevent browsers or proxies from caching error states. Supported status codes: 400, 403, 404, 405, 414, 416, 500.
