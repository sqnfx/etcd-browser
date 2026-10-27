package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	pb "go.etcd.io/etcd/api/v3/etcdserverpb"
	clientv3 "go.etcd.io/etcd/client/v3"
	"go.uber.org/zap"
)

// Conn is an active connection to a cluster.
type Conn struct {
	profile Profile
	cfg     clientv3.Config
	cli     *clientv3.Client

	mu           sync.Mutex
	members      []*pb.Member
	compactRev   int64
	compactRevAt time.Time
}

func readPEM(v string) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if strings.HasPrefix(v, "-----BEGIN") {
		return []byte(v), nil
	}
	b, err := os.ReadFile(v)
	if err != nil {
		return nil, fmt.Errorf("nie można odczytać pliku %q: %w", v, err)
	}
	return b, nil
}

func buildTLS(p Profile) (*tls.Config, error) {
	if !p.usesTLS() {
		return nil, nil
	}
	cfg := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: p.InsecureSkipVerify, //nolint:gosec // explicit user choice
		ServerName:         p.ServerName,
	}
	ca, err := readPEM(p.CACert)
	if err != nil {
		return nil, err
	}
	if len(ca) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(ca) {
			return nil, errors.New("certyfikat CA nie zawiera poprawnych certyfikatów PEM")
		}
		cfg.RootCAs = pool
	}
	cert, err := readPEM(p.ClientCert)
	if err != nil {
		return nil, err
	}
	key, err := readPEM(p.ClientKey)
	if err != nil {
		return nil, err
	}
	if len(cert) > 0 || len(key) > 0 {
		if len(cert) == 0 || len(key) == 0 {
			return nil, errors.New("certyfikat klienta wymaga zarówno certyfikatu, jak i klucza")
		}
		pair, err := tls.X509KeyPair(cert, key)
		if err != nil {
			return nil, fmt.Errorf("certyfikat klienta: %w", err)
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	return cfg, nil
}

func (p Profile) dialTimeout() time.Duration {
	if p.DialTimeoutSec > 0 {
		return time.Duration(p.DialTimeoutSec) * time.Second
	}
	return 5 * time.Second
}

func (p Profile) requestTimeout() time.Duration {
	if p.RequestTimeoutSec > 0 {
		return time.Duration(p.RequestTimeoutSec) * time.Second
	}
	return 10 * time.Second
}

func openConn(p Profile) (*Conn, error) {
	tlsCfg, err := buildTLS(p)
	if err != nil {
		return nil, err
	}
	var eps []string
	for _, e := range p.Endpoints {
		for _, part := range strings.FieldsFunc(e, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == ';' }) {
			if n := normalizeEndpoint(part, tlsCfg != nil); n != "" {
				eps = append(eps, n)
			}
		}
	}
	if len(eps) == 0 {
		return nil, errors.New("podaj co najmniej jeden endpoint, np. 127.0.0.1:2379")
	}
	p.Endpoints = eps
	cfg := clientv3.Config{
		Endpoints:            eps,
		DialTimeout:          p.dialTimeout(),
		DialKeepAliveTime:    30 * time.Second,
		DialKeepAliveTimeout: 10 * time.Second,
		Username:             p.Username,
		Password:             p.Password,
		TLS:                  tlsCfg,
		Logger:               zap.NewNop(),
		MaxCallRecvMsgSize:   256 << 20,
		MaxCallSendMsgSize:   16 << 20,
		PermitWithoutStream:  true,
	}
	cli, err := clientv3.New(cfg)
	if err != nil {
		return nil, explainErr(err)
	}
	c := &Conn{profile: p, cfg: cfg, cli: cli}
	ctx, cancel := context.WithTimeout(context.Background(), p.dialTimeout()+p.requestTimeout())
	defer cancel()
	if _, err := c.refreshMembers(ctx); err != nil {
		cli.Close()
		return nil, explainErr(err)
	}
	if p.AutoSync {
		c.syncEndpoints()
	}
	return c, nil
}

func (c *Conn) close() {
	if c != nil && c.cli != nil {
		c.cli.Close()
	}
}

func (c *Conn) ctx(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, c.profile.requestTimeout())
}

func (c *Conn) refreshMembers(ctx context.Context) ([]*pb.Member, error) {
	resp, err := c.cli.MemberList(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.members = resp.Members
	c.mu.Unlock()
	return resp.Members, nil
}

func (c *Conn) cachedMembers() []*pb.Member {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.members
}

func (c *Conn) syncEndpoints() {
	var eps []string
	for _, m := range c.cachedMembers() {
		if ep := c.memberEndpoint(m); ep != "" && !m.IsLearner {
			eps = append(eps, ep)
		}
	}
	if len(eps) > 0 {
		c.cli.SetEndpoints(eps...)
	}
}

func memberKey(m *pb.Member) string { return fmt.Sprintf("%x", m.ID) }

// memberEndpoint returns the client URL used to reach a member directly.
func (c *Conn) memberEndpoint(m *pb.Member) string {
	if ov := c.override(m); ov != "" {
		return ov
	}
	if len(m.ClientURLs) == 0 {
		return ""
	}
	// Prefer a URL the user typed (it is known to be reachable).
	for _, u := range m.ClientURLs {
		for _, e := range c.profile.Endpoints {
			if sameHostPort(u, e) {
				return e
			}
		}
	}
	wantTLS := c.cfg.TLS != nil
	for _, u := range m.ClientURLs {
		if strings.HasPrefix(u, "https://") == wantTLS && !strings.HasPrefix(u, "unix") {
			return u
		}
	}
	return m.ClientURLs[0]
}

func (c *Conn) override(m *pb.Member) string {
	ov := c.profile.Overrides
	if ov == nil {
		return ""
	}
	if v := ov[memberKey(m)]; v != "" {
		return normalizeEndpoint(v, c.cfg.TLS != nil)
	}
	if m.Name != "" {
		if v := ov["name:"+m.Name]; v != "" {
			return normalizeEndpoint(v, c.cfg.TLS != nil)
		}
	}
	return ""
}

func sameHostPort(a, b string) bool {
	ua, err1 := url.Parse(a)
	ub, err2 := url.Parse(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return strings.EqualFold(ua.Host, ub.Host)
}

func (c *Conn) findMember(id uint64) (*pb.Member, error) {
	for _, m := range c.cachedMembers() {
		if m.ID == id {
			return m, nil
		}
	}
	ctx, cancel := c.ctx(context.Background())
	defer cancel()
	ms, err := c.refreshMembers(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range ms {
		if m.ID == id {
			return m, nil
		}
	}
	return nil, fmt.Errorf("nie znaleziono członka %x", id)
}

// singleClient opens a short-lived client bound to exactly one endpoint.
func (c *Conn) singleClient(ep string) (*clientv3.Client, error) {
	cfg := c.cfg
	cfg.Endpoints = []string{ep}
	cfg.Context = nil
	return clientv3.New(cfg)
}

func (c *Conn) leader(ctx context.Context) (*pb.Member, error) {
	members := c.cachedMembers()
	type res struct {
		leader uint64
		err    error
	}
	ch := make(chan res, len(members))
	for _, m := range members {
		ep := c.memberEndpoint(m)
		if ep == "" {
			ch <- res{err: errors.New("brak adresu")}
			continue
		}
		go func(ep string) {
			cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			st, err := c.cli.Status(cctx, ep)
			if err != nil {
				ch <- res{err: err}
				return
			}
			ch <- res{leader: st.Leader}
		}(ep)
	}
	var lastErr error
	for range members {
		r := <-ch
		if r.err == nil && r.leader != 0 {
			return c.findMember(r.leader)
		}
		if r.err != nil {
			lastErr = r.err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("klaster nie ma lidera")
	}
	return nil, lastErr
}

func explainErr(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case errors.Is(err, context.DeadlineExceeded) || strings.Contains(msg, "context deadline exceeded"):
		return fmt.Errorf("przekroczono czas oczekiwania – sprawdź adres, port, TLS i czy węzeł działa (%s)", msg)
	case strings.Contains(msg, "authentication failed"):
		return fmt.Errorf("nieprawidłowa nazwa użytkownika lub hasło (%s)", msg)
	case strings.Contains(msg, "user name is empty"), strings.Contains(msg, "user name not found"):
		return fmt.Errorf("klaster wymaga uwierzytelnienia (%s)", msg)
	case strings.Contains(msg, "permission denied"):
		return fmt.Errorf("brak uprawnień do tej operacji (%s)", msg)
	case strings.Contains(msg, "certificate"):
		return fmt.Errorf("problem z certyfikatem TLS (%s)", msg)
	case strings.Contains(msg, "required revision has been compacted"):
		return fmt.Errorf("ta rewizja została już skompaktowana (%s)", msg)
	case strings.Contains(msg, "mvcc: required revision is a future revision"):
		return fmt.Errorf("podana rewizja jest z przyszłości (%s)", msg)
	case strings.Contains(msg, "database space exceeded"):
		return fmt.Errorf("przekroczono limit miejsca bazy (alarm NOSPACE) – wykonaj kompakcję, defragmentację i rozbrój alarm (%s)", msg)
	}
	return err
}
