//go:build !windows && !darwin

package main

import (
	"os"
	"os/exec"
)

func chromiumCandidates() []string {
	return []string{
		"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
		"microsoft-edge", "microsoft-edge-stable", "brave-browser", "vivaldi",
		"/snap/bin/chromium",
	}
}

func prepareCmd(cmd *exec.Cmd) {
	cmd.Stdout, cmd.Stderr = nil, nil
}

func openDefaultBrowser(url string) {
	for _, c := range []string{"xdg-open", "gio", "sensible-browser", "firefox"} {
		if p, err := exec.LookPath(c); err == nil {
			args := []string{url}
			if c == "gio" {
				args = []string{"open", url}
			}
			if exec.Command(p, args...).Start() == nil {
				return
			}
		}
	}
}

func showErrorDialog(title, msg string) {
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return
	}
	if p, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command(p, "--error", "--title="+title, "--text="+msg).Run()
	}
}
