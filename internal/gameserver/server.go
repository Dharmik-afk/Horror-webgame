package gameserver

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const port = 9000

// Run is called by the root dispatcher with os.Args[2:].
// Currently takes no meaningful arguments — reserved for future flags.
func Run(_ []string) {
	reg := NewRegistry()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", WSHandler(reg))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		fmt.Fprintf(w, `{"status":"ok","players":%d}`, reg.count())
	})

	// corsHandler wraps the mux to echo CORS headers for preflight
	// requests.  Required because browsers on :8000 treat :9000 as a
	// different origin and will send an OPTIONS preflight before the
	// WebSocket upgrade if custom headers are present.
	corsHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: corsHandler,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-quit
		fmt.Printf("\nReceived %s. Shutting down...\n", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "Forced shutdown:", err)
			os.Exit(1)
		}
		fmt.Println("Game server stopped.")
		os.Exit(0)
	}()

	fmt.Printf("Game server  :  ws://localhost:%d/ws\n", port)
	fmt.Printf("Health check :  http://localhost:%d/health\n", port)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "ListenAndServe:", err)
		os.Exit(1)
	}
}
