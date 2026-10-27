package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	pb "go.etcd.io/etcd/api/v3/etcdserverpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

type memberStatus struct {
	Version          string   `json:"version"`
	DBSize           int64    `json:"dbSize"`
	DBSizeInUse      int64    `json:"dbSizeInUse"`
	DBSizeQuota      int64    `json:"dbSizeQuota,omitempty"`
	Leader           string   `json:"leader"`
	RaftIndex        uint64   `json:"raftIndex"`
	RaftTerm         uint64   `json:"raftTerm"`
	RaftAppliedIndex uint64   `json:"raftAppliedIndex"`
	Revision         int64    `json:"revision"`
	IsLearner        bool     `json:"isLearner"`
	Errors           []string `json:"errors,omitempty"`
	StorageVersion   string   `json:"storageVersion,omitempty"`
}

type memberOut struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	PeerURLs   []string      `json:"peerURLs"`
	ClientURLs []string      `json:"clientURLs"`
	IsLearner  bool          `json:"isLearner"`
	Endpoint   string        `json:"endpoint"`
	Override   string        `json:"override,omitempty"`
	Status     *memberStatus `json:"status,omitempty"`
	Error      string        `json:"error,omitempty"`
	LatencyMs  int64         `json:"latencyMs"`
	IsLeader   bool          `json:"isLeader"`
	Started    bool          `json:"started"`
}

func idHex(id uint64) string { return strconv.FormatUint(id, 16) }

func parseID(s string) (uint64, error) {
	v, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "0x"), 16, 64)
	if err != nil {
		return 0, badRequest("niepoprawny identyfikator członka %q", s)
	}
	return v, nil
}

func (c *Conn) statusOf(ctx context.Context, ep string) (*clientv3.StatusResponse, time.Duration, error) {
	start := time.Now()
	cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	st, err := c.cli.Status(cctx, ep)
	return st, time.Since(start), err
}

func toStatus(st *clientv3.StatusResponse) *memberStatus {
	return &memberStatus{
		Version: st.Version, DBSize: st.DbSize, DBSizeInUse: st.DbSizeInUse, DBSizeQuota: st.DbSizeQuota,
		Leader: idHex(st.Leader), RaftIndex: st.RaftIndex, RaftTerm: st.RaftTerm, RaftAppliedIndex: st.RaftAppliedIndex,
		Revision: st.Header.Revision, IsLearner: st.IsLearner, Errors: st.Errors, StorageVersion: st.StorageVersion,
	}
}

func (s *server) hCluster(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	ml, err := c.cli.MemberList(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.members = ml.Members
	c.mu.Unlock()
	if c.profile.AutoSync {
		c.syncEndpoints()
	}

	out := make([]memberOut, len(ml.Members))
	var wg sync.WaitGroup
	for i, m := range ml.Members {
		out[i] = memberOut{ID: idHex(m.ID), Name: m.Name, PeerURLs: m.PeerURLs, ClientURLs: m.ClientURLs,
			IsLearner: m.IsLearner, Endpoint: c.memberEndpoint(m), Override: c.override(m), Started: m.Name != "" || len(m.ClientURLs) > 0}
		if out[i].PeerURLs == nil {
			out[i].PeerURLs = []string{}
		}
		if out[i].ClientURLs == nil {
			out[i].ClientURLs = []string{}
		}
		if out[i].Endpoint == "" {
			out[i].Error = "członek nie został jeszcze uruchomiony (brak adresu klienta)"
			continue
		}
		wg.Add(1)
		go func(o *memberOut) {
			defer wg.Done()
			st, d, err := c.statusOf(r.Context(), o.Endpoint)
			o.LatencyMs = d.Milliseconds()
			if err != nil {
				o.Error = explainErr(err).Error()
				return
			}
			o.Status = toStatus(st)
		}(&out[i])
	}
	var alarms []map[string]string
	var alarmErr string
	var compactRev int64
	wg.Add(2)
	go func() {
		defer wg.Done()
		compactRev = c.cachedCompactRevision(r.Context())
	}()
	go func() {
		defer wg.Done()
		actx, acancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer acancel()
		ar, err := c.cli.AlarmList(actx)
		if err != nil {
			alarmErr = explainErr(err).Error()
			return
		}
		for _, a := range ar.Alarms {
			alarms = append(alarms, map[string]string{"member": idHex(a.MemberID), "alarm": a.Alarm.String()})
		}
	}()
	wg.Wait()

	// leader: majority view among reachable members (highest term wins)
	var leader string
	var term uint64
	var revision int64
	for _, o := range out {
		if o.Status != nil {
			if o.Status.RaftTerm >= term && o.Status.Leader != "0" {
				term, leader = o.Status.RaftTerm, o.Status.Leader
			}
			if o.Status.Revision > revision {
				revision = o.Status.Revision
			}
		}
	}
	for i := range out {
		out[i].IsLeader = out[i].ID == leader
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if alarms == nil {
		alarms = []map[string]string{}
	}
	return map[string]any{
		"clusterId": idHex(ml.Header.ClusterId), "memberId": idHex(ml.Header.MemberId), "members": out, "leader": leader,
		"raftTerm": term, "revision": revision, "compactRevision": compactRev, "alarms": alarms, "alarmError": alarmErr,
		"endpoints": c.cli.Endpoints(), "readOnly": c.profile.ReadOnly,
	}, nil
}

// compactRevision discovers the last compaction revision by watching from revision 1.
func (c *Conn) compactRevision(parent context.Context) (int64, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	wch := c.cli.Watch(clientv3.WithRequireLeader(ctx), "\x00etcd-browser/compact-probe", clientv3.WithRev(1), clientv3.WithCreatedNotify())
	for {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case resp, ok := <-wch:
			if !ok {
				return 0, nil
			}
			if resp.CompactRevision > 0 {
				return resp.CompactRevision, nil
			}
			if resp.Canceled {
				return 0, nil
			}
			if resp.Created {
				// the compaction notice (if any) follows the creation within one sync cycle
				select {
				case resp2, ok := <-wch:
					if ok && resp2.CompactRevision > 0 {
						return resp2.CompactRevision, nil
					}
					return 0, nil
				case <-time.After(700 * time.Millisecond):
					return 0, nil
				case <-ctx.Done():
					return 0, nil
				}
			}
		}
	}
}

// cachedCompactRevision avoids probing on every refresh.
func (c *Conn) cachedCompactRevision(ctx context.Context) int64 {
	c.mu.Lock()
	rev, at := c.compactRev, c.compactRevAt
	c.mu.Unlock()
	if time.Since(at) < 20*time.Second {
		return rev
	}
	rev, err := c.compactRevision(ctx)
	if err != nil {
		return rev
	}
	c.setCompactRevision(rev)
	return rev
}

func (c *Conn) setCompactRevision(rev int64) {
	c.mu.Lock()
	if rev >= c.compactRev || time.Since(c.compactRevAt) > 20*time.Second {
		c.compactRev = rev
	}
	c.compactRevAt = time.Now()
	c.mu.Unlock()
}

type memberReq struct {
	ID       string   `json:"id"`
	PeerURLs []string `json:"peerURLs"`
	Learner  bool     `json:"learner"`
	Name     string   `json:"name"`
	URL      string   `json:"url"`
}

func cleanURLs(in []string) []string {
	var out []string
	for _, u := range in {
		for _, p := range strings.FieldsFunc(u, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

func (s *server) hMemberAdd(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req memberReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	urls := cleanURLs(req.PeerURLs)
	if len(urls) == 0 {
		return nil, badRequest("podaj adres peer nowego członka, np. https://10.0.0.4:2380")
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	var resp *clientv3.MemberAddResponse
	if req.Learner {
		resp, err = c.cli.MemberAddAsLearner(ctx, urls)
	} else {
		resp, err = c.cli.MemberAdd(ctx, urls)
	}
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = "nowy-czlonek"
	}
	var initial []string
	for _, m := range resp.Members {
		n := m.Name
		if m.ID == resp.Member.ID {
			n = name
		}
		for _, u := range m.PeerURLs {
			initial = append(initial, fmt.Sprintf("%s=%s", n, u))
		}
	}
	c.refreshMembers(ctx)
	return map[string]any{
		"id": idHex(resp.Member.ID),
		"env": []string{
			"ETCD_NAME=\"" + name + "\"",
			"ETCD_INITIAL_CLUSTER=\"" + strings.Join(initial, ",") + "\"",
			"ETCD_INITIAL_ADVERTISE_PEER_URLS=\"" + strings.Join(urls, ",") + "\"",
			"ETCD_INITIAL_CLUSTER_STATE=\"existing\"",
		},
	}, nil
}

func (s *server) memberOp(r *http.Request, fn func(ctx context.Context, c *Conn, id uint64, req memberReq) error) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req memberReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	id, err := parseID(req.ID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), c.profile.requestTimeout()*2)
	defer cancel()
	if err := fn(ctx, c, id, req); err != nil {
		return nil, err
	}
	c.refreshMembers(ctx)
	return nil, nil
}

func (s *server) hMemberRemove(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.memberOp(r, func(ctx context.Context, c *Conn, id uint64, _ memberReq) error {
		_, err := c.cli.MemberRemove(ctx, id)
		return err
	})
}

func (s *server) hMemberUpdate(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.memberOp(r, func(ctx context.Context, c *Conn, id uint64, req memberReq) error {
		urls := cleanURLs(req.PeerURLs)
		if len(urls) == 0 {
			return badRequest("podaj co najmniej jeden adres peer")
		}
		_, err := c.cli.MemberUpdate(ctx, id, urls)
		return err
	})
}

func (s *server) hMemberPromote(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.memberOp(r, func(ctx context.Context, c *Conn, id uint64, _ memberReq) error {
		_, err := c.cli.MemberPromote(ctx, id)
		return err
	})
}

// hMoveLeader asks the current leader to transfer leadership.
func (s *server) hMoveLeader(w http.ResponseWriter, r *http.Request) (any, error) {
	return s.memberOp(r, func(ctx context.Context, c *Conn, id uint64, _ memberReq) error {
		leader, err := c.leader(ctx)
		if err != nil {
			return fmt.Errorf("nie udało się ustalić lidera: %w", err)
		}
		if leader.ID == id {
			return badRequest("ten członek już jest liderem")
		}
		ep := c.memberEndpoint(leader)
		lc, err := c.singleClient(ep)
		if err != nil {
			return err
		}
		defer lc.Close()
		_, err = lc.MoveLeader(ctx, id)
		return err
	})
}

// hOverride sets a custom client URL used to reach a member directly.
func (s *server) hOverride(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	var req memberReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	if _, err := parseID(req.ID); err != nil {
		return nil, err
	}
	key := strings.ToLower(strings.TrimPrefix(req.ID, "0x"))
	url := strings.TrimSpace(req.URL)
	c.mu.Lock()
	ov := map[string]string{}
	for k, v := range c.profile.Overrides {
		ov[k] = v
	}
	if url == "" {
		delete(ov, key)
	} else {
		ov[key] = url
	}
	c.profile.Overrides = ov
	name := c.profile.Name
	c.mu.Unlock()
	s.store.update(name, func(p *Profile) { p.Overrides = ov })
	return nil, nil
}

// ---- maintenance ----

func (s *server) hCompact(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req struct {
		Revision int64 `json:"revision"`
		Keep     int64 `json:"keep"`
		Physical bool  `json:"physical"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	cur, err := c.cli.Get(ctx, "\x00etcd-browser/rev-probe", clientv3.WithCountOnly())
	if err != nil {
		return nil, err
	}
	current := cur.Header.Revision
	rev := req.Revision
	if rev <= 0 {
		rev = current - req.Keep
	}
	if rev > current {
		return nil, badRequest("rewizja %d jest większa od bieżącej (%d)", rev, current)
	}
	if rev < 1 {
		return nil, badRequest("nie ma czego kompaktować (bieżąca rewizja: %d)", current)
	}
	var opts []clientv3.CompactOption
	if req.Physical {
		opts = append(opts, clientv3.WithCompactPhysical())
	}
	start := time.Now()
	if _, err := c.cli.Compact(ctx, rev, opts...); err != nil {
		return nil, err
	}
	c.setCompactRevision(rev)
	return map[string]any{"revision": rev, "current": current, "ms": time.Since(start).Milliseconds()}, nil
}

func (s *server) memberByReq(c *Conn, idStr string) (*pb.Member, string, error) {
	id, err := parseID(idStr)
	if err != nil {
		return nil, "", err
	}
	m, err := c.findMember(id)
	if err != nil {
		return nil, "", err
	}
	ep := c.memberEndpoint(m)
	if ep == "" {
		return nil, "", badRequest("członek %s nie ma adresu klienta", m.Name)
	}
	return m, ep, nil
}

func (s *server) hDefrag(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	m, ep, err := s.memberByReq(c, req.ID)
	if err != nil {
		return nil, err
	}
	before, _, err := c.statusOf(r.Context(), ep)
	if err != nil {
		return nil, fmt.Errorf("%s (%s) jest nieosiągalny: %w", m.Name, ep, err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	start := time.Now()
	if _, err := c.cli.Defragment(ctx, ep); err != nil {
		return nil, err
	}
	took := time.Since(start)
	after, _, err := c.statusOf(r.Context(), ep)
	res := map[string]any{"name": m.Name, "before": before.DbSize, "ms": took.Milliseconds()}
	if err == nil {
		res["after"] = after.DbSize
		res["inUse"] = after.DbSizeInUse
	}
	return res, nil
}

func (s *server) hAlarms(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	ar, err := c.cli.AlarmList(ctx)
	if err != nil {
		return nil, err
	}
	out := []map[string]string{}
	for _, a := range ar.Alarms {
		out = append(out, map[string]string{"member": idHex(a.MemberID), "alarm": a.Alarm.String()})
	}
	return map[string]any{"alarms": out}, nil
}

func (s *server) hDisarm(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req struct {
		Member string `json:"member"`
		Alarm  string `json:"alarm"`
	}
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	am := &clientv3.AlarmMember{}
	if req.Member != "" {
		if am.MemberID, err = parseID(req.Member); err != nil {
			return nil, err
		}
	}
	if req.Alarm != "" {
		v, ok := pb.AlarmType_value[strings.ToUpper(req.Alarm)]
		if !ok {
			return nil, badRequest("nieznany alarm %q", req.Alarm)
		}
		am.Alarm = pb.AlarmType(v)
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	resp, err := c.cli.AlarmDisarm(ctx, am)
	if err != nil {
		return nil, err
	}
	return map[string]any{"disarmed": len(resp.Alarms)}, nil
}

func (s *server) hHashKV(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	ms, err := c.refreshMembers(ctx)
	if err != nil {
		return nil, err
	}
	cur, err := c.cli.Get(ctx, "\x00etcd-browser/rev-probe", clientv3.WithCountOnly())
	if err != nil {
		return nil, err
	}
	rev := cur.Header.Revision
	type res struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Hash         string `json:"hash,omitempty"`
		HashRevision int64  `json:"hashRevision,omitempty"`
		CompactRev   int64  `json:"compactRevision,omitempty"`
		Error        string `json:"error,omitempty"`
	}
	out := make([]res, len(ms))
	var wg sync.WaitGroup
	for i, m := range ms {
		out[i] = res{ID: idHex(m.ID), Name: m.Name}
		ep := c.memberEndpoint(m)
		if ep == "" {
			out[i].Error = "brak adresu klienta"
			continue
		}
		wg.Add(1)
		go func(o *res, ep string) {
			defer wg.Done()
			hr, err := c.cli.HashKV(ctx, ep, rev)
			if err != nil {
				o.Error = explainErr(err).Error()
				return
			}
			o.Hash = fmt.Sprintf("%08x", hr.Hash)
			o.HashRevision = hr.HashRevision
			o.CompactRev = hr.CompactRevision
		}(&out[i], ep)
	}
	wg.Wait()
	hashes := map[string]bool{}
	for _, o := range out {
		if o.Hash != "" {
			hashes[o.Hash] = true
		}
	}
	return map[string]any{"revision": rev, "members": out, "consistent": len(hashes) == 1}, nil
}

// hSnapshot streams a database snapshot taken from one member.
func (s *server) hSnapshot(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	m, ep, err := s.memberByReq(c, r.URL.Query().Get("id"))
	if err != nil {
		return nil, err
	}
	sc, err := c.singleClient(ep)
	if err != nil {
		return nil, err
	}
	defer sc.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Hour)
	defer cancel()
	rc, err := sc.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	buf := make([]byte, 64<<10)
	n, err := rc.Read(buf)
	if err != nil && n == 0 {
		return nil, err
	}
	name := fmt.Sprintf("etcd-snapshot-%s-%s.db", sanitizeFilename(m.Name), time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.WriteHeader(http.StatusOK)
	w.Write(buf[:n])
	for {
		n, err := rc.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return nil, errStreamed
			}
		}
		if err == io.EOF {
			return nil, errStreamed
		}
		if err != nil {
			// abort the transfer so the browser marks the download as failed
			panic(http.ErrAbortHandler)
		}
	}
}
