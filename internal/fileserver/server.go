// Package fileserver implements the static-file HTTP server (port 8000).
// Entry point: Run(args []string) — called from the root dispatcher.
package fileserver

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

// ── Network helpers ───────────────────────────────────────────────

func getLocalIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		ErrorLogger.Printf("Could not determine LAN IP, falling back to 127.0.0.1: %v\n", err)
		return "127.0.0.1"
	}
	defer conn.Close()
	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String()
}

// ── Entry point ───────────────────────────────────────────────────

// Serve starts the file server and blocks until the context is cancelled.
func Serve(ctx context.Context, publicDir string, force bool) error {
	results := performStartupCheckup(publicDir)
	allPassed := printCheckupSummary(results)

	if !allPassed {
		if force {
			Logger.Println("⚠️  Errors detected but --force flag provided. Starting server anyway...")
			Logger.Println("")
		} else {
			return fmt.Errorf("checkup failures detected (use --force to override)")
		}
	} else {
		Logger.Println("✅ All checks passed. Starting server...")
		Logger.Println("")
	}

	gin.SetMode(gin.ReleaseMode)
	gin.DefaultWriter = Logger.Writer()
	gin.DefaultErrorWriter = ErrorLogger.Writer()
	r := gin.New()

	r.Use(LoggingMiddleware())
	r.Use(IdentityMiddleware())

	handler := FileHandler(publicDir)

	r.GET("/*filepath", handler)
	r.HEAD("/*filepath", handler)
	r.NoRoute(handler)

	addr := fmt.Sprintf("%s:%d", host, defaultPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: r,
	}

	go func() {
		<-ctx.Done()
		Logger.Println("Shutting down file server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			ErrorLogger.Printf("File server shutdown error: %v\n", err)
		}
	}()

	ip := getLocalIP()
	Logger.Printf("File Server: http://localhost:%d/ (LAN: http://%s:%d/)\n", defaultPort, ip, defaultPort)
	Logger.Printf("Web Root: %s\n", publicDir)

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("file server error: %w", err)
	}
	return nil
}

// Run is the entry point for the "serve" command.
func Run(args []string) {
	cli := parseArgs(args)

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Failed to get working directory:", err)
		os.Exit(1)
	}

	publicDir := filepath.Join(cwd, "public")
	if cli.publicDir != "" {
		publicDir = filepath.Join(cwd, cli.publicDir)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := Serve(ctx, publicDir, cli.force); err != nil {
		ErrorLogger.Printf("Error: %v\n", err)
		os.Exit(1)
	}
}
