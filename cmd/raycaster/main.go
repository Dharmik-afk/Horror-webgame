package main

import (
	"fmt"
	"os"

	"server/internal/fileserver"
	"server/internal/gameserver"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "serve":
		fileserver.Run(os.Args[2:])
	case "game":
		gameserver.Run(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %q\n", os.Args[1])
		fmt.Fprintln(os.Stderr)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Usage: raycaster <command> [args]")
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  serve [dir] [-f]   Static file server  (port 8000)")
	fmt.Fprintln(os.Stderr, "  game               Game / WebSocket server (port 9000)")
}
