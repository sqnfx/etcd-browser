package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type server struct {
	store *store
	token string
	life  *lifecycle
	opt   appOptions

	mu   sync.RWMutex
	conn *Conn
	gen  int // incremented on every (dis)connect, used to stop watchers
}

func newServer(st *store, token string, life *lifecycle, opt appOptions) *server {
	return &server{store: st, token: token, life: life, opt: opt}
}

func (s *server) closeAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		s.conn.close()
		s.conn = nil
	}
}

type apiError struct {
	status int
	msg    string
}

func (e *apiError) Error() string { return e.msg }

func badRequest(format string, a ...any) error {
	return &apiError{status: http.StatusBadRequest, msg: fmt.Sprintf(format, a...)}
}

var errNotConnected = &apiError{status: http.StatusConflict, msg: "brak połączenia z klastrem"}
var errReadOnly = &apiError{status: http.StatusForbidden, msg: "profil jest w trybie tylko do odczytu – zmiany są zablokowane"}

type handlerFunc func(w http.ResponseWriter, r *http.Request) (any, error)

func (s *server) routes(static http.FileSystem) http.Handler {
	mux := http.NewServeMux()
	files := http.FileServer(static)
	mux.Handle("/", noCache(files))

	api := func(path string, h handlerFunc) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if !s.authorized(r) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			res, err := h(w, r)
			if err == errStreamed {
				return
			}
			if err != nil {
				status := http.StatusInternalServerError
				var ae *apiError
				if errors.As(err, &ae) {
					status = ae.status
				}
				msg := explainErr(err).Error()
				if s.opt.debug {
					log.Printf("%s %s -> %d %s", r.Method, r.URL.Path, status, msg)
				}
				writeJSON(w, status, map[string]any{"error": msg})
				return
			}
			if res == nil {
				res = map[string]any{"ok": true}
			}
			writeJSON(w, http.StatusOK, res)
		})
	}

	// session & profiles
	api("/api/state", s.hState)
	api("/api/events", s.hEvents)
	api("/api/settings", s.hSettings)
	api("/api/profiles", s.hProfiles)
	api("/api/profiles/save", s.hProfileSave)
	api("/api/profiles/delete", s.hProfileDelete)
	api("/api/connect", s.hConnect)
	api("/api/test", s.hTest)
	api("/api/disconnect", s.hDisconnect)

	// keys
	api("/api/kv/children", s.hChildren)
	api("/api/kv/search", s.hSearch)
	api("/api/kv/count", s.hCount)
	api("/api/kv/get", s.hGet)
	api("/api/kv/put", s.hPut)
	api("/api/kv/delete", s.hDelete)
	api("/api/kv/history", s.hHistory)
	api("/api/kv/export", s.hExport)
	api("/api/kv/import", s.hImport)
	api("/api/watch", s.hWatch)

	// cluster
	api("/api/cluster", s.hCluster)
	api("/api/members/add", s.hMemberAdd)
	api("/api/members/remove", s.hMemberRemove)
	api("/api/members/update", s.hMemberUpdate)
	api("/api/members/promote", s.hMemberPromote)
	api("/api/members/leader", s.hMoveLeader)
	api("/api/members/override", s.hOverride)

	// maintenance
	api("/api/maint/compact", s.hCompact)
	api("/api/maint/defrag", s.hDefrag)
	api("/api/maint/alarms", s.hAlarms)
	api("/api/maint/disarm", s.hDisarm)
	api("/api/maint/hashkv", s.hHashKV)
	api("/api/maint/snapshot", s.hSnapshot)

	// leases
	api("/api/leases", s.hLeases)
	api("/api/leases/grant", s.hLeaseGrant)
	api("/api/leases/revoke", s.hLeaseRevoke)
	api("/api/leases/keepalive", s.hLeaseKeepAlive)

	// auth
	api("/api/auth", s.hAuth)
	api("/api/auth/toggle", s.hAuthToggle)
	api("/api/auth/user", s.hAuthUser)
	api("/api/auth/role", s.hAuthRole)

	return s.guard(mux)
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

// guard blocks DNS-rebinding and cross-site requests.
func (s *server) guard(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.exposed() && !isLoopbackHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && r.Method != http.MethodGet {
			if !strings.HasSuffix(o, "://"+r.Host) {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		h.ServeHTTP(w, r)
	})
}

// exposed reports whether the user deliberately bound the UI to a non-loopback address.
func (s *server) exposed() bool { return !isLoopbackHost(s.opt.listen) }

func isLoopbackHost(hostport string) bool {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = strings.Trim(hostport, "[]")
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *server) authorized(r *http.Request) bool {
	t := r.Header.Get("X-Token")
	if t == "" {
		t = r.URL.Query().Get("t")
	}
	return subtle.ConstantTimeCompare([]byte(t), []byte(s.token)) == 1
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func decode(r *http.Request, v any) error {
	if r.Method != http.MethodPost {
		return &apiError{status: http.StatusMethodNotAllowed, msg: "wymagana metoda POST"}
	}
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 512<<20))
	if err := dec.Decode(v); err != nil {
		return badRequest("niepoprawne dane żądania: %v", err)
	}
	return nil
}

var errStreamed = errors.New("streamed")

// current returns the active connection.
func (s *server) current() (*Conn, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.conn == nil {
		return nil, errNotConnected
	}
	return s.conn, nil
}

func (s *server) writable() (*Conn, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	if c.profile.ReadOnly {
		return nil, errReadOnly
	}
	return c, nil
}

// ---- session ----

func (s *server) hState(w http.ResponseWriter, r *http.Request) (any, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]any{"version": version, "connected": s.conn != nil, "serve": s.opt.serve}
	if s.conn != nil {
		p := s.conn.profile.public()
		out["profile"] = p
	}
	return out, nil
}

// hEvents is a long-lived SSE stream; while at least one is open the app keeps running.
func (s *server) hEvents(w http.ResponseWriter, r *http.Request) (any, error) {
	fl, ok := w.(http.Flusher)
	if !ok {
		return nil, errors.New("streaming unsupported")
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, "event: hello\ndata: {}\n\n")
	fl.Flush()
	s.life.clientConnected()
	defer s.life.clientDisconnected()
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.Context().Done():
			return nil, errStreamed
		case <-s.life.done:
			fmt.Fprintf(w, "event: bye\ndata: {}\n\n")
			fl.Flush()
			return nil, errStreamed
		case <-t.C:
			fmt.Fprintf(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (s *server) hSettings(w http.ResponseWriter, r *http.Request) (any, error) {
	if r.Method == http.MethodGet {
		return s.store.getSettings(), nil
	}
	var patch map[string]any
	if err := decode(r, &patch); err != nil {
		return nil, err
	}
	return nil, s.store.mergeSettings(patch)
}

func (s *server) hProfiles(w http.ResponseWriter, r *http.Request) (any, error) {
	return map[string]any{"profiles": s.store.list()}, nil
}

type profileReq struct {
	Profile      Profile `json:"profile"`
	OldName      string  `json:"oldName"`
	KeepPassword bool    `json:"keepPassword"`
}

func cleanProfile(p *Profile) error {
	p.Name = strings.TrimSpace(p.Name)
	var eps []string
	for _, e := range p.Endpoints {
		for _, part := range strings.FieldsFunc(e, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == ';' }) {
			if part = strings.TrimSpace(part); part != "" {
				eps = append(eps, part)
			}
		}
	}
	p.Endpoints = eps
	if len(eps) == 0 {
		return badRequest("podaj co najmniej jeden endpoint")
	}
	if p.Name == "" {
		p.Name = eps[0]
	}
	return nil
}

func (s *server) hProfileSave(w http.ResponseWriter, r *http.Request) (any, error) {
	var req profileReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if err := cleanProfile(&req.Profile); err != nil {
		return nil, err
	}
	if req.OldName != req.Profile.Name {
		if _, exists := s.store.get(req.Profile.Name); exists {
			return nil, badRequest("profil o nazwie %q już istnieje", req.Profile.Name)
		}
	}
	if err := s.store.put(req.Profile, req.OldName, req.KeepPassword); err != nil {
		return nil, err
	}
	return map[string]any{"profiles": s.store.list(), "name": req.Profile.Name}, nil
}

func (s *server) hProfileDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if err := s.store.remove(req.Name); err != nil {
		return nil, err
	}
	return map[string]any{"profiles": s.store.list()}, nil
}

// resolveProfile merges a profile from the request with the stored password.
func (s *server) resolveProfile(req profileReq) (Profile, error) {
	p := req.Profile
	if err := cleanProfile(&p); err != nil {
		return p, err
	}
	if p.Password == "" && req.KeepPassword {
		name := req.OldName
		if name == "" {
			name = p.Name
		}
		if stored, ok := s.store.get(name); ok {
			p.Password = stored.Password
			if p.Overrides == nil {
				p.Overrides = stored.Overrides
			}
		}
	}
	return p, nil
}

func (s *server) hTest(w http.ResponseWriter, r *http.Request) (any, error) {
	var req profileReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p, err := s.resolveProfile(req)
	if err != nil {
		return nil, err
	}
	start := time.Now()
	c, err := openConn(p)
	if err != nil {
		return nil, err
	}
	defer c.close()
	ms := c.cachedMembers()
	names := []string{}
	for _, m := range ms {
		names = append(names, m.Name)
	}
	return map[string]any{"members": len(ms), "names": names, "ms": time.Since(start).Milliseconds()}, nil
}

func (s *server) hConnect(w http.ResponseWriter, r *http.Request) (any, error) {
	var req profileReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	p, err := s.resolveProfile(req)
	if err != nil {
		return nil, err
	}
	c, err := openConn(p)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	old := s.conn
	s.conn = c
	s.gen++
	s.mu.Unlock()
	if old != nil {
		old.close()
	}
	s.store.update(p.Name, func(sp *Profile) { sp.LastUsed = time.Now().Unix() })
	return map[string]any{"profile": c.profile.public()}, nil
}

func (s *server) hDisconnect(w http.ResponseWriter, r *http.Request) (any, error) {
	s.mu.Lock()
	old := s.conn
	s.conn = nil
	s.gen++
	s.mu.Unlock()
	if old != nil {
		old.close()
	}
	return nil, nil
}
