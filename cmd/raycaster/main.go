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
	case "help", "--help":
		printUsage()
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %q\n", os.Args[1])
		fmt.Fprintln(os.Stderr)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("Useage : raycaster  <command> [arg]")
	fmt.Println("")
	fmt.Println("Commands:")
	fmt.Println("")
	fmt.Println("    serve [dir] [-f]   Static file server  (port 8000)")
	fmt.Println("           dir cusom directory  (default public/)")
	fmt.Println("           -f - force to run with errors")
	fmt.Println("    game               Game / WebSocket server (port 9000)")
}
