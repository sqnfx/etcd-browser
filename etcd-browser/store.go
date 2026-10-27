package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Profile describes one saved connection.
type Profile struct {
	Name               string            `json:"name"`
	Endpoints          []string          `json:"endpoints"`
	Username           string            `json:"username,omitempty"`
	Password           string            `json:"password,omitempty"`
	SavePassword       bool              `json:"savePassword,omitempty"`
	CACert             string            `json:"caCert,omitempty"`
	ClientCert         string            `json:"clientCert,omitempty"`
	ClientKey          string            `json:"clientKey,omitempty"`
	InsecureSkipVerify bool              `json:"insecureSkipVerify,omitempty"`
	ServerName         string            `json:"serverName,omitempty"`
	DialTimeoutSec     int               `json:"dialTimeoutSec,omitempty"`
	RequestTimeoutSec  int               `json:"requestTimeoutSec,omitempty"`
	AutoSync           bool              `json:"autoSync,omitempty"`
	Overrides          map[string]string `json:"overrides,omitempty"`
	Env                string            `json:"env,omitempty"` // "", dev, test, prod
	ReadOnly           bool              `json:"readOnly,omitempty"`
	Delimiter          string            `json:"delimiter,omitempty"`
	LastUsed           int64             `json:"lastUsed,omitempty"`
}

func (p *Profile) usesTLS() bool {
	if p.CACert != "" || p.ClientCert != "" || p.InsecureSkipVerify {
		return true
	}
	for _, e := range p.Endpoints {
		if strings.HasPrefix(strings.TrimSpace(e), "https://") {
			return true
		}
	}
	return false
}

// publicProfile is what the UI receives: never the stored password.
type publicProfile struct {
	Profile
	HasPassword bool `json:"hasPassword"`
}

func (p Profile) public() publicProfile {
	pp := publicProfile{Profile: p, HasPassword: p.Password != ""}
	pp.Password = ""
	return pp
}

type store struct {
	mu       sync.Mutex
	dir      string
	profiles map[string]Profile
	settings map[string]any
}

func newStore(dir string) (*store, error) {
	s := &store{dir: dir, profiles: map[string]Profile{}, settings: map[string]any{}}
	var list []Profile
	if err := readJSON(filepath.Join(dir, "profiles.json"), &list); err != nil {
		return nil, err
	}
	for _, p := range list {
		s.profiles[p.Name] = p
	}
	if err := readJSON(filepath.Join(dir, "settings.json"), &s.settings); err != nil {
		return nil, err
	}
	if s.settings == nil {
		s.settings = map[string]any{}
	}
	return s, nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, v)
}

func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *store) list() []publicProfile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]publicProfile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p.public())
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].LastUsed != out[j].LastUsed {
			return out[i].LastUsed > out[j].LastUsed
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

func (s *store) get(name string) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.profiles[name]
	return p, ok
}

func (s *store) saveLocked() error {
	list := make([]Profile, 0, len(s.profiles))
	for _, p := range s.profiles {
		if !p.SavePassword {
			p.Password = ""
		}
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return writeJSONFile(filepath.Join(s.dir, "profiles.json"), list)
}

// put stores a profile. If oldName differs it renames. An empty password with
// keepPassword keeps the stored one.
func (s *store) put(p Profile, oldName string, keepPassword bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.profiles[oldName]; ok && oldName != "" {
		if keepPassword && p.Password == "" {
			p.Password = old.Password
		}
		if p.Overrides == nil {
			p.Overrides = old.Overrides
		}
		if p.LastUsed == 0 {
			p.LastUsed = old.LastUsed
		}
		if oldName != p.Name {
			delete(s.profiles, oldName)
		}
	}
	if !p.SavePassword {
		p.Password = ""
	}
	s.profiles[p.Name] = p
	return s.saveLocked()
}

func (s *store) update(name string, fn func(p *Profile)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.profiles[name]
	if !ok {
		return
	}
	fn(&p)
	s.profiles[name] = p
	_ = s.saveLocked()
}

func (s *store) remove(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.profiles, name)
	return s.saveLocked()
}

func (s *store) getSettings() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]any{}
	for k, v := range s.settings {
		out[k] = v
	}
	return out
}

func (s *store) mergeSettings(patch map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range patch {
		if v == nil {
			delete(s.settings, k)
		} else {
			s.settings[k] = v
		}
	}
	return writeJSONFile(filepath.Join(s.dir, "settings.json"), s.settings)
}
