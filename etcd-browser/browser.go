package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type launchedBrowser struct {
	cmd     *exec.Cmd
	url     string
	waitErr error
	waited  chan struct{}
	once    sync.Once
}

func (b *launchedBrowser) wait() error {
	<-b.waited
	return b.waitErr
}

// close stops the dedicated browser instance (it uses its own profile, so it is
// never the user's everyday browser session).
func (b *launchedBrowser) close() {
	b.once.Do(func() {
		select {
		case <-b.waited:
			return
		default:
		}
		if b.cmd.Process != nil {
			_ = b.cmd.Process.Kill()
		}
		select {
		case <-b.waited:
		case <-time.After(2 * time.Second):
		}
	})
}

// openAppWindow opens the UI in a chromeless window of a Chromium-based browser
// (Edge, Chrome, Chromium, Brave). Falls back to the default browser.
func openAppWindow(url, cfgDir string) *launchedBrowser {
	for _, exe := range chromiumCandidates() {
		if exe == "" {
			continue
		}
		if _, err := os.Stat(exe); err != nil {
			if p, err := exec.LookPath(exe); err == nil {
				exe = p
			} else {
				continue
			}
		}
		profile := filepath.Join(browserProfileBase(cfgDir), "window")
		_ = os.MkdirAll(profile, 0o700)
		cmd := exec.Command(exe,
			"--app="+url,
			"--user-data-dir="+profile,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate,MediaRouter",
			"--disable-background-networking",
			"--disable-sync",
			"--window-size=1440,900",
			"--class=etcd-browser",
		)
		prepareCmd(cmd)
		if err := cmd.Start(); err != nil {
			log.Printf("nie udało się uruchomić %s: %v", exe, err)
			continue
		}
		log.Printf("okno aplikacji: %s", exe)
		b := &launchedBrowser{cmd: cmd, url: url, waited: make(chan struct{})}
		go func() {
			b.waitErr = cmd.Wait()
			close(b.waited)
		}()
		return b
	}
	log.Printf("nie znaleziono przeglądarki Chromium – otwieram domyślną przeglądarkę")
	openDefaultBrowser(url)
	return nil
}

func browserProfileBase(cfgDir string) string {
	if d, err := os.UserCacheDir(); err == nil {
		return filepath.Join(d, "etcd-browser")
	}
	return cfgDir
}
