package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func chromiumCandidates() []string {
	apps := []string{
		"Google Chrome.app/Contents/MacOS/Google Chrome",
		"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"Chromium.app/Contents/MacOS/Chromium",
		"Brave Browser.app/Contents/MacOS/Brave Browser",
		"Vivaldi.app/Contents/MacOS/Vivaldi",
		"Arc.app/Contents/MacOS/Arc",
	}
	home, _ := os.UserHomeDir()
	var out []string
	for _, a := range apps {
		out = append(out, filepath.Join("/Applications", a))
		if home != "" {
			out = append(out, filepath.Join(home, "Applications", a))
		}
	}
	return out
}

func prepareCmd(cmd *exec.Cmd) {}

func openDefaultBrowser(url string) { _ = exec.Command("open", url).Start() }

func showErrorDialog(title, msg string) {
	esc := func(s string) string { return strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) }
	_ = exec.Command("osascript", "-e", `display alert "`+esc(title)+`" message "`+esc(msg)+`" as critical`).Run()
}
