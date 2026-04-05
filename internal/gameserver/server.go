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

// Serve starts the game server and blocks until the context is cancelled.
func Serve(ctx context.Context) error {
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

	go func() {
		<-ctx.Done()
		Logger.Println("Shutting down game server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			ErrorLogger.Printf("Game server shutdown error: %v\n", err)
		}
	}()

	Logger.Printf("Game Server: ws://localhost:%d/ws (Health: http://localhost:%d/health)\n", port, port)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("game server error: %w", err)
	}
	return nil
}

// Run is the entry point for the "game" command.
func Run(_ []string) {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := Serve(ctx); err != nil {
		ErrorLogger.Printf("Error: %v\n", err)
		os.Exit(1)
	}
}
