# Server Architecture Overview

The server is a Go application providing two independent services behind a single CLI binary (`raycaster`). It follows the standard Go project layout with `cmd/` for the entry point and `internal/` for unexported packages.

## Project Layout

```
cmd/
└── raycaster/
    └── main.go              CLI dispatcher — routes subcommands to internal packages
internal/
├── fileserver/              Static file server (Gin + stdlib)
│   ├── config.go            Constants, MIME types, CLI arg parsing
│   ├── errors.go            HTTP error type, constructors, error response rendering
│   ├── handler.go           Path resolution, range requests, cache headers, file serving
│   ├── middleware.go        Gin request logging middleware
│   ├── checkup.go           Startup health checks (directory, index.html, MIME, path sim)
│   └── server.go            Run() entry point, Gin router setup, graceful shutdown
└── gameserver/              WebSocket game server (gorilla/websocket + stdlib)
    ├── model.go             Wire protocol types (PlayerState, messages), ID generation
    ├── registry.go          Thread-safe client registry and state store
    ├── handler.go           WebSocket upgrader, per-client reader/writer goroutines
    └── server.go            Run() entry point, HTTP mux, graceful shutdown
```

## CLI Dispatcher

The `cmd/raycaster/main.go` entry point uses a simple `os.Args` switch to route subcommands:

- **`raycaster serve [dir] [-f]`** — launches the static file server on port 8000
- **`raycaster game`** — launches the WebSocket game server on port 9000

Both subcommands run independently and bind to separate ports. They can be started simultaneously in separate terminals for full local development.

## Design Principles

1. **Separation of Concerns**
   Each file in `internal/` contains a single cohesive responsibility — config, errors, handlers, middleware, and server lifecycle are never mixed.
2. **Internal Visibility**
   All server packages live under `internal/`, preventing external consumers from importing them. Only the CLI binary in `cmd/` wires them together.
3. **Graceful Shutdown**
   Both servers listen for `SIGINT`/`SIGTERM` and execute `http.Server.Shutdown()` with a 10-second timeout, allowing in-flight requests and WebSocket connections to drain cleanly.
4. **Zero External State**
   The game server holds all player state in-memory via a thread-safe `Registry`. The file server is purely stateless — it reads files from disk on every request.
