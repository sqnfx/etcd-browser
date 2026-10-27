package main

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"go.etcd.io/etcd/api/v3/authpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

// ---- leases ----

type leaseOut struct {
	ID      string     `json:"id"`
	TTL     int64      `json:"ttl"`
	Granted int64      `json:"granted"`
	Keys    []keyEntry `json:"keys"`
	NKeys   int        `json:"nKeys"`
	Error   string     `json:"error,omitempty"`
}

func (s *server) hLeases(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	lr, err := c.cli.Leases(ctx)
	if err != nil {
		return nil, err
	}
	const maxDetail = 2000
	total := len(lr.Leases)
	ids := lr.Leases
	if len(ids) > maxDetail {
		ids = ids[:maxDetail]
	}
	out := make([]leaseOut, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for i, l := range ids {
		out[i] = leaseOut{ID: leaseHex(int64(l.ID)), Keys: []keyEntry{}}
		wg.Add(1)
		sem <- struct{}{}
		go func(o *leaseOut, id clientv3.LeaseID) {
			defer wg.Done()
			defer func() { <-sem }()
			t, err := c.cli.TimeToLive(ctx, id, clientv3.WithAttachedKeys())
			if err != nil {
				o.Error = explainErr(err).Error()
				return
			}
			o.TTL, o.Granted, o.NKeys = t.TTL, t.GrantedTTL, len(t.Keys)
			for j, k := range t.Keys {
				if j >= 50 {
					break
				}
				ks, bin := display(k)
				o.Keys = append(o.Keys, keyEntry{K: b64.EncodeToString(k), S: ks, Bin: bin})
			}
		}(&out[i], l.ID)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].TTL < out[j].TTL })
	return map[string]any{"leases": out, "total": total}, nil
}

func (s *server) hLeaseGrant(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req struct {
		TTL int64 `json:"ttl"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if req.TTL < 1 {
		return nil, badRequest("TTL musi być dodatni")
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	resp, err := c.cli.Grant(ctx, req.TTL)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": leaseHex(int64(resp.ID)), "ttl": resp.TTL}, nil
}

func (s *server) leaseOp(r *http.Request, write bool, fn func(ctx context.Context, c *Conn, id clientv3.LeaseID) (any, error)) (any, error) {
	var c *Conn
	var err error
	if write {
		c, err = s.writable()
	} else {
		c, err = s.current()
	}
	if err != nil {
		return nil, err
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	id, err := parseLease(req.ID)
	if err != nil {
		return nil, err
	}
	if id == 0 {
		return nil, badRequest("brak identyfikatora dzierżawy")
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	return fn(ctx, c, id)
}

func (s *server) hLeaseRevoke(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.leaseOp(r, true, func(ctx context.Context, c *Conn, id clientv3.LeaseID) (any, error) {
		_, err := c.cli.Revoke(ctx, id)
		return nil, err
	})
}

func (s *server) hLeaseKeepAlive(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.leaseOp(r, true, func(ctx context.Context, c *Conn, id clientv3.LeaseID) (any, error) {
		resp, err := c.cli.KeepAliveOnce(ctx, id)
		if err != nil {
			return nil, err
		}
		return map[string]any{"ttl": resp.TTL}, nil
	})
}

// ---- auth ----

type permOut struct {
	Type     string `json:"type"`
	Key      string `json:"key"`
	KeyS     string `json:"keyS"`
	RangeEnd string `json:"rangeEnd"`
	EndS     string `json:"endS"`
	Kind     string `json:"kind"` // single | prefix | all | range
}

func describePerm(p *authpb.Permission) permOut {
	ks, _ := display(p.Key)
	es, _ := display(p.RangeEnd)
	o := permOut{Type: p.PermType.String(), Key: b64.EncodeToString(p.Key), KeyS: ks,
		RangeEnd: b64.EncodeToString(p.RangeEnd), EndS: es}
	switch {
	case len(p.RangeEnd) == 0:
		o.Kind = "single"
	case string(p.RangeEnd) == "\x00" && (len(p.Key) == 0 || string(p.Key) == "\x00"):
		o.Kind = "all"
	case string(p.RangeEnd) == "\x00":
		o.Kind = "fromkey"
	case clientv3.GetPrefixRangeEnd(string(p.Key)) == string(p.RangeEnd):
		o.Kind = "prefix"
	default:
		o.Kind = "range"
	}
	return o
}

func (s *server) hAuth(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	out := map[string]any{"currentUser": c.profile.Username}
	st, err := c.cli.AuthStatus(ctx)
	if err != nil {
		out["statusError"] = explainErr(err).Error()
	} else {
		out["enabled"] = st.Enabled
		out["authRevision"] = st.AuthRevision
	}
	users := []map[string]any{}
	if ul, err := c.cli.UserList(ctx); err != nil {
		out["usersError"] = explainErr(err).Error()
	} else {
		for _, u := range ul.Users {
			roles := []string{}
			if ug, err := c.cli.UserGet(ctx, u); err == nil {
				roles = append(roles, ug.Roles...)
			}
			users = append(users, map[string]any{"name": u, "roles": roles})
		}
	}
	roles := []map[string]any{}
	if rl, err := c.cli.RoleList(ctx); err != nil {
		out["rolesError"] = explainErr(err).Error()
	} else {
		for _, name := range rl.Roles {
			perms := []permOut{}
			if rg, err := c.cli.RoleGet(ctx, name); err == nil {
				for _, p := range rg.Perm {
					perms = append(perms, describePerm(p))
				}
			}
			roles = append(roles, map[string]any{"name": name, "perms": perms})
		}
	}
	out["users"] = users
	out["roles"] = roles
	return out, nil
}

func (s *server) hAuthToggle(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req struct {
		Enable bool `json:"enable"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	if req.Enable {
		ug, err := c.cli.UserGet(ctx, "root")
		if err != nil {
			return nil, badRequest("przed włączeniem uwierzytelniania utwórz użytkownika „root” z rolą „root” (%v)", explainErr(err))
		}
		hasRoot := false
		for _, r := range ug.Roles {
			hasRoot = hasRoot || r == "root"
		}
		if !hasRoot {
			return nil, badRequest("użytkownik „root” musi mieć rolę „root”")
		}
		_, err = c.cli.AuthEnable(ctx)
		return nil, err
	}
	_, err = c.cli.AuthDisable(ctx)
	return nil, err
}

type authUserReq struct {
	Action     string `json:"action"` // add, delete, passwd, grant, revoke
	Name       string `json:"name"`
	Password   string `json:"password"`
	NoPassword bool   `json:"noPassword"`
	Role       string `json:"role"`
}

func (s *server) hAuthUser(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req authUserReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return nil, badRequest("podaj nazwę użytkownika")
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	switch req.Action {
	case "add":
		if req.NoPassword {
			_, err = c.cli.UserAddWithOptions(ctx, req.Name, "", &clientv3.UserAddOptions{NoPassword: true})
		} else {
			if req.Password == "" {
				return nil, badRequest("podaj hasło lub zaznacz „bez hasła”")
			}
			_, err = c.cli.UserAdd(ctx, req.Name, req.Password)
		}
	case "delete":
		_, err = c.cli.UserDelete(ctx, req.Name)
	case "passwd":
		_, err = c.cli.UserChangePassword(ctx, req.Name, req.Password)
	case "grant":
		_, err = c.cli.UserGrantRole(ctx, req.Name, strings.TrimSpace(req.Role))
	case "revoke":
		_, err = c.cli.UserRevokeRole(ctx, req.Name, req.Role)
	default:
		return nil, badRequest("nieznana operacja %q", req.Action)
	}
	return nil, err
}

type authRoleReq struct {
	Action   string `json:"action"` // add, delete, grant, revoke
	Name     string `json:"name"`
	Key      string `json:"key"`      // base64
	RangeEnd string `json:"rangeEnd"` // base64 (revoke / explicit range)
	Kind     string `json:"kind"`     // single, prefix, all, range
	Perm     string `json:"perm"`     // READ, WRITE, READWRITE
}

func (s *server) hAuthRole(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req authRoleReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return nil, badRequest("podaj nazwę roli")
	}
	key, err := decodeKey(req.Key)
	if err != nil {
		return nil, err
	}
	end, err := decodeKey(req.RangeEnd)
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	switch req.Action {
	case "add":
		_, err = c.cli.RoleAdd(ctx, req.Name)
	case "delete":
		_, err = c.cli.RoleDelete(ctx, req.Name)
	case "grant":
		var rangeEnd string
		k := string(key)
		switch req.Kind {
		case "single":
			if k == "" {
				return nil, badRequest("podaj klucz")
			}
		case "prefix":
			if k == "" {
				return nil, badRequest("podaj prefiks (dla całej przestrzeni wybierz „wszystkie klucze”)")
			}
			rangeEnd = clientv3.GetPrefixRangeEnd(k)
		case "all":
			k, rangeEnd = "\x00", "\x00"
		case "range":
			rangeEnd = string(end)
			if k == "" || rangeEnd == "" {
				return nil, badRequest("podaj początek i koniec zakresu")
			}
		default:
			return nil, badRequest("nieznany rodzaj zakresu")
		}
		pt, ok := authpb.Permission_Type_value[strings.ToUpper(req.Perm)]
		if !ok {
			return nil, badRequest("nieznany typ uprawnienia %q", req.Perm)
		}
		_, err = c.cli.RoleGrantPermission(ctx, req.Name, k, rangeEnd, clientv3.PermissionType(pt))
	case "revoke":
		_, err = c.cli.RoleRevokePermission(ctx, req.Name, string(key), string(end))
	default:
		return nil, badRequest("nieznana operacja %q", req.Action)
	}
	return nil, err
}
