package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed web
var webFS embed.FS

var version = "1.0.0"

type appOptions struct {
	listen    string
	serve     bool
	noWindow  bool
	debug     bool
	configDir string
}

func main() {
	var opt appOptions
	flag.StringVar(&opt.listen, "listen", "127.0.0.1:0", "adres nasłuchu interfejsu (domyślnie losowy port na localhost)")
	flag.BoolVar(&opt.serve, "serve", false, "tryb serwera: nie otwieraj okna i nie zamykaj się po zamknięciu karty")
	flag.BoolVar(&opt.noWindow, "no-window", false, "nie otwieraj okna aplikacji (tylko wypisz adres)")
	flag.BoolVar(&opt.debug, "debug", false, "szczegółowe logi")
	flag.StringVar(&opt.configDir, "config-dir", "", "katalog konfiguracji (profile połączeń)")
	showVersion := flag.Bool("version", false, "pokaż wersję")
	flag.Parse()
	if *showVersion {
		fmt.Println("etcd-browser", version)
		return
	}
	if opt.serve {
		opt.noWindow = true
	}

	cfgDir, err := resolveConfigDir(opt.configDir)
	if err != nil {
		fatal("Nie można utworzyć katalogu konfiguracji: " + err.Error())
	}
	setupLogging(cfgDir, opt.debug)

	store, err := newStore(cfgDir)
	if err != nil {
		fatal("Nie można odczytać konfiguracji: " + err.Error())
	}

	token := randomHex(24)
	ln, err := listen(opt.listen)
	if err != nil {
		fatal("Nie można uruchomić serwera interfejsu: " + err.Error())
	}
	addr := ln.Addr().(*net.TCPAddr)
	host := addr.IP.String()
	if addr.IP.IsUnspecified() {
		host = "127.0.0.1"
	}
	baseURL := fmt.Sprintf("http://%s/", net.JoinHostPort(host, fmt.Sprint(addr.Port)))
	appURL := baseURL + "?token=" + token

	life := newLifecycle(!opt.serve)
	srv := newServer(store, token, life, opt)
	sub, _ := fs.Sub(webFS, "web")
	httpSrv := &http.Server{
		Handler:           srv.routes(http.FS(sub)),
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("serwer HTTP: %v", err)
			life.shutdown()
		}
	}()

	fmt.Printf("etcd-browser %s\nInterfejs: %s\n", version, appURL)
	log.Printf("start, interfejs na %s", baseURL)

	var browser *launchedBrowser
	if !opt.noWindow {
		browser = openAppWindow(appURL, cfgDir)
		if browser != nil {
			life.watchProcess(browser)
		}
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-life.done:
	}
	log.Printf("zamykanie")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	srv.closeAll()
	if browser != nil {
		browser.close()
	}
}

func listen(addr string) (net.Listener, error) {
	// Prefer a stable port so the app window keeps its size/position between runs.
	if addr == "127.0.0.1:0" {
		if ln, err := net.Listen("tcp", "127.0.0.1:23790"); err == nil {
			return ln, nil
		}
	}
	return net.Listen("tcp", addr)
}

func resolveConfigDir(flagDir string) (string, error) {
	dir := flagDir
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".config")
		}
		dir = filepath.Join(base, "etcd-browser")
	}
	return dir, os.MkdirAll(dir, 0o700)
}

func setupLogging(dir string, debug bool) {
	f, err := os.OpenFile(filepath.Join(dir, "etcd-browser.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	if debug {
		log.SetOutput(io.MultiWriter(f, os.Stderr))
	} else {
		log.SetOutput(f)
	}
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	log.Print(msg)
	showErrorDialog("etcd-browser", msg)
	os.Exit(1)
}

// lifecycle decides when the process should exit: in window mode the app
// quits shortly after the last UI tab disconnects.
type lifecycle struct {
	mu        sync.Mutex
	auto      bool
	clients   int
	everSeen  bool
	lastClose time.Time
	done      chan struct{}
	once      sync.Once
}

func newLifecycle(auto bool) *lifecycle {
	l := &lifecycle{auto: auto, done: make(chan struct{})}
	if auto {
		go l.loop()
	}
	return l
}

func (l *lifecycle) shutdown() { l.once.Do(func() { close(l.done) }) }

func (l *lifecycle) clientConnected() {
	l.mu.Lock()
	l.clients++
	l.everSeen = true
	l.mu.Unlock()
}

func (l *lifecycle) clientDisconnected() {
	l.mu.Lock()
	l.clients--
	if l.clients == 0 {
		l.lastClose = time.Now()
	}
	l.mu.Unlock()
}

func (l *lifecycle) loop() {
	start := time.Now()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-l.done:
			return
		case <-t.C:
		}
		l.mu.Lock()
		quit := false
		if l.everSeen && l.clients == 0 && time.Since(l.lastClose) > 8*time.Second {
			quit = true
		}
		if !l.everSeen && time.Since(start) > 5*time.Minute {
			quit = true
		}
		l.mu.Unlock()
		if quit {
			log.Printf("brak otwartych okien interfejsu – kończę")
			l.shutdown()
			return
		}
	}
}

// watchProcess handles the case where the dedicated browser window could not
// start (e.g. sandboxed browser): fall back to the system default browser.
func (l *lifecycle) watchProcess(b *launchedBrowser) {
	go func() {
		started := time.Now()
		err := b.wait()
		l.mu.Lock()
		seen := l.everSeen
		l.mu.Unlock()
		if !seen && time.Since(started) < 15*time.Second {
			log.Printf("okno przeglądarki zakończyło się od razu (%v) – otwieram domyślną przeglądarkę", err)
			openDefaultBrowser(b.url)
		}
	}()
}

func normalizeEndpoint(ep string, tls bool) string {
	ep = strings.TrimSpace(ep)
	if ep == "" {
		return ""
	}
	if !strings.Contains(ep, "://") {
		if tls {
			return "https://" + ep
		}
		return "http://" + ep
	}
	return ep
}
