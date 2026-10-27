package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"go.etcd.io/etcd/api/v3/mvccpb"
	clientv3 "go.etcd.io/etcd/client/v3"
)

var b64 = base64.StdEncoding

func decodeKey(v string) ([]byte, error) {
	b, err := b64.DecodeString(v)
	if err != nil {
		// tolerate '+' turned into ' ' by query decoding and URL-safe alphabets
		fixed := strings.ReplaceAll(v, " ", "+")
		if b, err = b64.DecodeString(fixed); err == nil {
			return b, nil
		}
		if b, err = base64.URLEncoding.DecodeString(fixed); err == nil {
			return b, nil
		}
		if b, err = base64.RawURLEncoding.DecodeString(fixed); err == nil {
			return b, nil
		}
	}
	if err != nil {
		return nil, badRequest("niepoprawny klucz (base64): %v", err)
	}
	return b, nil
}

// display returns a printable representation of bytes and whether it had to be escaped.
func display(b []byte) (string, bool) {
	if utf8.Valid(b) {
		clean := true
		for _, r := range string(b) {
			if r < 0x20 && r != '\t' && r != '\n' && r != '\r' || r == 0x7f {
				clean = false
				break
			}
		}
		if clean {
			return string(b), false
		}
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		switch {
		case r == utf8.RuneError && size <= 1:
			fmt.Fprintf(&sb, "\\x%02x", b[0])
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&sb, "\\x%02x", r)
		case r == '\\':
			sb.WriteString("\\\\")
		default:
			sb.WriteRune(r)
		}
		b = b[size:]
	}
	return sb.String(), true
}

type keyEntry struct {
	K      string `json:"k"`
	S      string `json:"s"`
	Name   string `json:"name,omitempty"`
	Bin    bool   `json:"bin,omitempty"`
	Mod    int64  `json:"mod,omitempty"`
	Create int64  `json:"create,omitempty"`
	Ver    int64  `json:"ver,omitempty"`
	Lease  string `json:"lease,omitempty"`
	Count  int64  `json:"count,omitempty"`
	Dir    bool   `json:"dir,omitempty"`
}

func leaseHex(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 16)
}

func parseLease(s string) (clientv3.LeaseID, error) {
	s = strings.TrimSpace(strings.TrimPrefix(strings.ToLower(s), "0x"))
	if s == "" {
		return 0, nil
	}
	v, err := strconv.ParseInt(s, 16, 64)
	if err != nil {
		return 0, badRequest("niepoprawny identyfikator dzierżawy %q (oczekiwany zapis szesnastkowy)", s)
	}
	return clientv3.LeaseID(v), nil
}

func entryFor(kv *mvccpb.KeyValue, prefixLen int) keyEntry {
	s, bin := display(kv.Key)
	name, _ := display(kv.Key[prefixLen:])
	return keyEntry{K: b64.EncodeToString(kv.Key), S: s, Name: name, Bin: bin, Mod: kv.ModRevision,
		Create: kv.CreateRevision, Ver: kv.Version, Lease: leaseHex(kv.Lease)}
}

func intParam(r *http.Request, name string, def, min, max int) int {
	v, err := strconv.Atoi(r.URL.Query().Get(name))
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func rangeStart(prefix []byte) string {
	if len(prefix) == 0 {
		return "\x00"
	}
	return string(prefix)
}

// hChildren lists one level of the key space, grouping keys by delimiter like a directory tree.
func (s *server) hChildren(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	prefix, err := decodeKey(q.Get("p"))
	if err != nil {
		return nil, err
	}
	delim := []byte(q.Get("d"))
	limit := intParam(r, "limit", 3000, 50, 50000)
	cursor := []byte(rangeStart(prefix))
	if a := q.Get("after"); a != "" {
		if cursor, err = decodeKey(a); err != nil {
			return nil, err
		}
	}
	end := clientv3.GetPrefixRangeEnd(string(prefix))
	ctx, cancel := context.WithTimeout(r.Context(), c.profile.requestTimeout()*3)
	defer cancel()

	var dirs []keyEntry
	keys := []keyEntry{}
	lastDir := ""
	var rev int64
	next := ""
	const batch = 1000
	for {
		opts := []clientv3.OpOption{clientv3.WithRange(end), clientv3.WithKeysOnly(), clientv3.WithLimit(batch)}
		if rev > 0 {
			opts = append(opts, clientv3.WithRev(rev))
		}
		resp, err := c.cli.Get(ctx, string(cursor), opts...)
		if err != nil {
			return nil, err
		}
		if rev == 0 {
			rev = resp.Header.Revision
		}
		if len(resp.Kvs) == 0 {
			break
		}
		var lastKey []byte
		full := false
		for _, kv := range resp.Kvs {
			rest := kv.Key[len(prefix):]
			var dir []byte
			if len(delim) > 0 {
				if idx := bytes.Index(rest, delim); idx >= 0 {
					dir = kv.Key[:len(prefix)+idx+len(delim)]
					if string(dir) == lastDir {
						lastKey = kv.Key
						continue
					}
				}
			}
			if len(dirs)+len(keys) >= limit {
				// page is full: resume from this key next time
				next = b64.EncodeToString(kv.Key)
				full = true
				break
			}
			lastKey = kv.Key
			if dir != nil {
				lastDir = string(dir)
				e := entryFor(&mvccpb.KeyValue{Key: dir}, len(prefix))
				e.Dir = true
				dirs = append(dirs, e)
				continue
			}
			keys = append(keys, entryFor(kv, len(prefix)))
		}
		if full || !resp.More {
			break
		}
		if lastDir != "" && bytes.HasPrefix(lastKey, []byte(lastDir)) {
			e := clientv3.GetPrefixRangeEnd(lastDir)
			if e == "\x00" || (end != "\x00" && e >= end) {
				break
			}
			cursor = []byte(e)
		} else {
			cursor = append(append([]byte{}, lastKey...), 0)
		}
	}

	// count keys in each directory (bounded concurrency)
	if len(dirs) > 0 && len(dirs) <= 500 {
		var wg sync.WaitGroup
		sem := make(chan struct{}, 8)
		for i := range dirs {
			wg.Add(1)
			sem <- struct{}{}
			go func(e *keyEntry) {
				defer wg.Done()
				defer func() { <-sem }()
				k, _ := b64.DecodeString(e.K)
				resp, err := c.cli.Get(ctx, string(k), clientv3.WithPrefix(), clientv3.WithCountOnly(), clientv3.WithRev(rev))
				if err == nil {
					e.Count = resp.Count
				}
			}(&dirs[i])
		}
		wg.Wait()
	}
	if dirs == nil {
		dirs = []keyEntry{}
	}
	return map[string]any{"dirs": dirs, "keys": keys, "next": next, "rev": rev}, nil
}

func (s *server) hCount(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	prefix, err := decodeKey(r.URL.Query().Get("p"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	resp, err := c.cli.Get(ctx, rangeStart(prefix), clientv3.WithRange(clientv3.GetPrefixRangeEnd(string(prefix))), clientv3.WithCountOnly())
	if err != nil {
		return nil, err
	}
	return map[string]any{"count": resp.Count, "rev": resp.Header.Revision}, nil
}

// hSearch scans keys (optionally values) under a prefix and returns matches.
func (s *server) hSearch(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	prefix, err := decodeKey(q.Get("p"))
	if err != nil {
		return nil, err
	}
	query := q.Get("q")
	inValues := q.Get("values") == "1"
	ci := q.Get("ci") == "1"
	var re *regexp.Regexp
	if q.Get("regex") == "1" {
		expr := query
		if ci {
			expr = "(?i)" + expr
		}
		if re, err = regexp.Compile(expr); err != nil {
			return nil, badRequest("niepoprawne wyrażenie regularne: %v", err)
		}
	}
	needle := []byte(query)
	if ci {
		needle = bytes.ToLower(needle)
	}
	match := func(b []byte) bool {
		if re != nil {
			return re.Match(b)
		}
		if ci {
			return bytes.Contains(bytes.ToLower(b), needle)
		}
		return bytes.Contains(b, needle)
	}
	limit := intParam(r, "limit", 500, 1, 5000)
	maxScan := 300000
	batch := int64(2000)
	if inValues {
		maxScan = 100000
		batch = 250
	}
	cursor := []byte(rangeStart(prefix))
	if a := q.Get("after"); a != "" {
		if cursor, err = decodeKey(a); err != nil {
			return nil, err
		}
	}
	end := clientv3.GetPrefixRangeEnd(string(prefix))
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	matches := []keyEntry{}
	scanned := 0
	next := ""
	var rev int64
	for {
		opts := []clientv3.OpOption{clientv3.WithRange(end), clientv3.WithLimit(batch)}
		if !inValues {
			opts = append(opts, clientv3.WithKeysOnly())
		}
		if rev > 0 {
			opts = append(opts, clientv3.WithRev(rev))
		}
		resp, err := c.cli.Get(ctx, string(cursor), opts...)
		if err != nil {
			return nil, err
		}
		if rev == 0 {
			rev = resp.Header.Revision
		}
		stop := false
		for _, kv := range resp.Kvs {
			scanned++
			cursor = append(append(cursor[:0:0], kv.Key...), 0)
			if match(kv.Key) || (inValues && match(kv.Value)) {
				matches = append(matches, entryFor(kv, 0))
				if len(matches) >= limit {
					stop = true
					break
				}
			}
		}
		if !resp.More && !stop {
			break
		}
		if stop || scanned >= maxScan {
			next = b64.EncodeToString(cursor)
			break
		}
	}
	return map[string]any{"matches": matches, "scanned": scanned, "next": next}, nil
}

type kvOut struct {
	K            string `json:"k"`
	S            string `json:"s"`
	Bin          bool   `json:"bin,omitempty"`
	V            string `json:"v"`
	Size         int    `json:"size"`
	Create       int64  `json:"create"`
	Mod          int64  `json:"mod"`
	Ver          int64  `json:"ver"`
	Lease        string `json:"lease,omitempty"`
	LeaseTTL     int64  `json:"leaseTTL,omitempty"`
	LeaseGranted int64  `json:"leaseGranted,omitempty"`
}

func kvToOut(kv *mvccpb.KeyValue) kvOut {
	s, bin := display(kv.Key)
	return kvOut{K: b64.EncodeToString(kv.Key), S: s, Bin: bin, V: b64.EncodeToString(kv.Value), Size: len(kv.Value),
		Create: kv.CreateRevision, Mod: kv.ModRevision, Ver: kv.Version, Lease: leaseHex(kv.Lease)}
}

func (s *server) hGet(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	key, err := decodeKey(q.Get("k"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	var opts []clientv3.OpOption
	if rv, _ := strconv.ParseInt(q.Get("rev"), 10, 64); rv > 0 {
		opts = append(opts, clientv3.WithRev(rv))
	}
	resp, err := c.cli.Get(ctx, string(key), opts...)
	if err != nil {
		return nil, err
	}
	if len(resp.Kvs) == 0 {
		return map[string]any{"missing": true, "rev": resp.Header.Revision}, nil
	}
	out := kvToOut(resp.Kvs[0])
	if resp.Kvs[0].Lease != 0 {
		if lr, err := c.cli.TimeToLive(ctx, clientv3.LeaseID(resp.Kvs[0].Lease)); err == nil {
			out.LeaseTTL = lr.TTL
			out.LeaseGranted = lr.GrantedTTL
		}
	}
	return map[string]any{"kv": out, "rev": resp.Header.Revision}, nil
}

type putReq struct {
	K      string `json:"k"`
	V      string `json:"v"`
	Lease  string `json:"lease"` // "", "keep" or hex id
	Expect *int64 `json:"expect"`
}

func (s *server) hPut(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req putReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	key, err := decodeKey(req.K)
	if err != nil {
		return nil, err
	}
	if len(key) == 0 {
		return nil, badRequest("klucz nie może być pusty")
	}
	val, err := b64.DecodeString(req.V)
	if err != nil {
		return nil, badRequest("niepoprawna wartość: %v", err)
	}
	var opts []clientv3.OpOption
	if req.Lease == "keep" {
		opts = append(opts, clientv3.WithIgnoreLease())
	} else if id, err := parseLease(req.Lease); err != nil {
		return nil, err
	} else if id != 0 {
		opts = append(opts, clientv3.WithLease(id))
	}
	ctx, cancel := c.ctx(r.Context())
	defer cancel()
	put := clientv3.OpPut(string(key), string(val), opts...)
	var cmp []clientv3.Cmp
	if req.Expect != nil {
		if *req.Expect == 0 {
			cmp = append(cmp, clientv3.Compare(clientv3.CreateRevision(string(key)), "=", 0))
		} else {
			cmp = append(cmp, clientv3.Compare(clientv3.ModRevision(string(key)), "=", *req.Expect))
		}
	}
	tr, err := c.cli.Txn(ctx).If(cmp...).Then(put).Else(clientv3.OpGet(string(key))).Commit()
	if err != nil {
		return nil, err
	}
	if !tr.Succeeded {
		out := map[string]any{"conflict": true}
		if rr := tr.Responses[0].GetResponseRange(); rr != nil && len(rr.Kvs) > 0 {
			out["current"] = kvToOut(rr.Kvs[0])
		}
		return out, nil
	}
	return map[string]any{"rev": tr.Header.Revision}, nil
}

type deleteReq struct {
	K      string `json:"k"`
	Prefix bool   `json:"prefix"`
	All    bool   `json:"all"`
	Expect *int64 `json:"expect"`
}

func (s *server) hDelete(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.writable()
	if err != nil {
		return nil, err
	}
	var req deleteReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	key, err := decodeKey(req.K)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	if req.Prefix {
		if len(key) == 0 && !req.All {
			return nil, badRequest("pusty prefiks usunąłby wszystkie klucze – wymagane potwierdzenie")
		}
		resp, err := c.cli.Delete(ctx, rangeStart(key), clientv3.WithRange(clientv3.GetPrefixRangeEnd(string(key))))
		if err != nil {
			return nil, err
		}
		return map[string]any{"deleted": resp.Deleted, "rev": resp.Header.Revision}, nil
	}
	var cmp []clientv3.Cmp
	if req.Expect != nil {
		cmp = append(cmp, clientv3.Compare(clientv3.ModRevision(string(key)), "=", *req.Expect))
	}
	tr, err := c.cli.Txn(ctx).If(cmp...).Then(clientv3.OpDelete(string(key))).Commit()
	if err != nil {
		return nil, err
	}
	if !tr.Succeeded {
		return map[string]any{"conflict": true}, nil
	}
	return map[string]any{"deleted": tr.Responses[0].GetResponseDeleteRange().Deleted, "rev": tr.Header.Revision}, nil
}

// hHistory walks back through previous versions of a key until creation or compaction.
func (s *server) hHistory(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	key, err := decodeKey(q.Get("k"))
	if err != nil {
		return nil, err
	}
	limit := intParam(r, "limit", 25, 1, 200)
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	versions := []kvOut{}
	reason := ""
	var opts []clientv3.OpOption
	for len(versions) < limit {
		resp, err := c.cli.Get(ctx, string(key), opts...)
		if err != nil {
			if strings.Contains(err.Error(), "compacted") {
				reason = "compacted"
				break
			}
			return nil, err
		}
		if len(resp.Kvs) == 0 {
			reason = "deleted"
			break
		}
		kv := resp.Kvs[0]
		o := kvToOut(kv)
		if o.Size > 256<<10 {
			o.V = b64.EncodeToString(kv.Value[:256<<10])
		}
		versions = append(versions, o)
		if kv.ModRevision <= kv.CreateRevision {
			reason = "created"
			break
		}
		opts = []clientv3.OpOption{clientv3.WithRev(kv.ModRevision - 1)}
	}
	if reason == "" {
		reason = "limit"
	}
	return map[string]any{"versions": versions, "end": reason}, nil
}

type exportItem struct {
	Key         *string `json:"key,omitempty"`
	KeyBase64   string  `json:"keyBase64,omitempty"`
	Value       *string `json:"value,omitempty"`
	ValueBase64 string  `json:"valueBase64,omitempty"`
}

// textOrB64 keeps UTF-8 data readable in exports and falls back to base64 for binary data.
func textOrB64(b []byte) (*string, string) {
	if utf8.Valid(b) {
		s := string(b)
		return &s, ""
	}
	return nil, b64.EncodeToString(b)
}

func sanitizeFilename(s string) string {
	var sb strings.Builder
	for _, r := range s {
		if r < 128 && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			sb.WriteRune(r)
		} else {
			sb.WriteByte('_')
		}
	}
	out := strings.Trim(sb.String(), "_.")
	if len(out) > 60 {
		out = out[:60]
	}
	if out == "" {
		out = "all"
	}
	return out
}

// hExport streams all keys under a prefix as JSON, at one consistent revision.
func (s *server) hExport(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	prefix, err := decodeKey(r.URL.Query().Get("p"))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	end := clientv3.GetPrefixRangeEnd(string(prefix))
	first, err := c.cli.Get(ctx, rangeStart(prefix), clientv3.WithRange(end), clientv3.WithLimit(500))
	if err != nil {
		return nil, err
	}
	rev := first.Header.Revision
	name := fmt.Sprintf("etcd-export-%s-%s.json", sanitizeFilename(string(prefix)), time.Now().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.WriteHeader(http.StatusOK)
	ptext, pb64 := textOrB64(prefix)
	hdr := map[string]any{"format": "etcd-browser-export/v1", "exportedAt": time.Now().UTC().Format(time.RFC3339), "revision": rev, "profile": c.profile.Name}
	if ptext != nil {
		hdr["prefix"] = *ptext
	} else {
		hdr["prefixBase64"] = pb64
	}
	hb, _ := json.Marshal(hdr)
	w.Write(hb[:len(hb)-1])
	w.Write([]byte(",\n\"items\": [\n"))
	count := 0
	resp := first
	for {
		for _, kv := range resp.Kvs {
			var it exportItem
			it.Key, it.KeyBase64 = textOrB64(kv.Key)
			it.Value, it.ValueBase64 = textOrB64(kv.Value)
			if count > 0 {
				w.Write([]byte(","))
			}
			raw, _ := json.Marshal(it)
			w.Write(raw)
			w.Write([]byte("\n"))
			count++
		}
		if !resp.More || len(resp.Kvs) == 0 {
			break
		}
		next := string(resp.Kvs[len(resp.Kvs)-1].Key) + "\x00"
		resp, err = c.cli.Get(ctx, next, clientv3.WithRange(end), clientv3.WithLimit(500), clientv3.WithRev(rev))
		if err != nil {
			fmt.Fprintf(w, "], \"error\": %q}\n", err.Error())
			return nil, errStreamed
		}
	}
	fmt.Fprintf(w, "],\n\"count\": %d}\n", count)
	return nil, errStreamed
}

type importReq struct {
	Data   json.RawMessage `json:"data"`
	Mode   string          `json:"mode"` // overwrite | skip
	From   string          `json:"from"`
	To     string          `json:"to"`
	DryRun bool            `json:"dryRun"`
}

type importPair struct{ k, v []byte }

func parseImport(data json.RawMessage) ([]importPair, error) {
	var doc struct {
		Items []exportItem `json:"items"`
		Kvs   []struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"kvs"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		// maybe a flat object {"key": "value"}
		var flat map[string]any
		if err2 := json.Unmarshal(data, &flat); err2 != nil {
			return nil, badRequest("nie rozpoznano formatu pliku: %v", err)
		}
		return flatPairs(flat), nil
	}
	var out []importPair
	switch {
	case doc.Items != nil:
		for i, it := range doc.Items {
			var k, v []byte
			var err error
			if it.KeyBase64 != "" {
				if k, err = b64.DecodeString(it.KeyBase64); err != nil {
					return nil, badRequest("element %d: niepoprawny keyBase64", i)
				}
			} else if it.Key != nil {
				k = []byte(*it.Key)
			}
			if it.ValueBase64 != "" {
				if v, err = b64.DecodeString(it.ValueBase64); err != nil {
					return nil, badRequest("element %d: niepoprawny valueBase64", i)
				}
			} else if it.Value != nil {
				v = []byte(*it.Value)
			}
			if len(k) == 0 {
				return nil, badRequest("element %d: pusty klucz", i)
			}
			out = append(out, importPair{k, v})
		}
	case doc.Kvs != nil: // etcdctl get -w json
		for i, it := range doc.Kvs {
			k, err := b64.DecodeString(it.Key)
			if err != nil {
				return nil, badRequest("kvs[%d]: niepoprawny klucz base64", i)
			}
			v, err := b64.DecodeString(it.Value)
			if err != nil {
				return nil, badRequest("kvs[%d]: niepoprawna wartość base64", i)
			}
			out = append(out, importPair{k, v})
		}
	default:
		var flat map[string]any
		if err := json.Unmarshal(data, &flat); err != nil {
			return nil, badRequest("nie rozpoznano formatu pliku")
		}
		return flatPairs(flat), nil
	}
	return out, nil
}

func flatPairs(flat map[string]any) []importPair {
	var out []importPair
	for k, v := range flat {
		var val []byte
		switch t := v.(type) {
		case string:
			val = []byte(t)
		default:
			val, _ = json.Marshal(t)
		}
		out = append(out, importPair{[]byte(k), val})
	}
	return out
}

func (s *server) hImport(w http.ResponseWriter, r *http.Request) (any, error) {
	var req importReq
	if err := decode(r, &req); err != nil {
		return nil, err
	}
	var c *Conn
	var err error
	if req.DryRun {
		c, err = s.current()
	} else {
		c, err = s.writable()
	}
	if err != nil {
		return nil, err
	}
	pairs, err := parseImport(req.Data)
	if err != nil {
		return nil, err
	}
	from, to := []byte(req.From), []byte(req.To)
	skippedOutside := 0
	if len(from) > 0 || len(to) > 0 {
		var mapped []importPair
		for _, p := range pairs {
			if !bytes.HasPrefix(p.k, from) {
				skippedOutside++
				continue
			}
			nk := append(append([]byte{}, to...), p.k[len(from):]...)
			if len(nk) == 0 {
				skippedOutside++
				continue
			}
			mapped = append(mapped, importPair{nk, p.v})
		}
		pairs = mapped
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	written, skipped, existing := 0, 0, 0
	sample := []string{}
	const chunk = 64
	for i := 0; i < len(pairs); i += chunk {
		part := pairs[i:min(i+chunk, len(pairs))]
		// which keys exist already?
		gets := make([]clientv3.Op, len(part))
		for j, p := range part {
			gets[j] = clientv3.OpGet(string(p.k), clientv3.WithCountOnly())
		}
		tr, err := c.cli.Txn(ctx).Then(gets...).Commit()
		if err != nil {
			return nil, fmt.Errorf("po zapisaniu %d kluczy: %w", written, err)
		}
		var todo []importPair
		var conds []clientv3.Cmp
		for j, p := range part {
			exists := tr.Responses[j].GetResponseRange().Count > 0
			if exists {
				existing++
			}
			if exists && req.Mode == "skip" {
				skipped++
				continue
			}
			todo = append(todo, p)
			if !exists {
				conds = append(conds, clientv3.Compare(clientv3.CreateRevision(string(p.k)), "=", 0))
			}
			if len(sample) < 8 {
				ks, _ := display(p.k)
				sample = append(sample, ks)
			}
		}
		if req.DryRun || len(todo) == 0 {
			written += len(todo)
			continue
		}
		puts := make([]clientv3.Op, len(todo))
		for j, p := range todo {
			puts[j] = clientv3.OpPut(string(p.k), string(p.v))
		}
		if req.Mode != "skip" {
			conds = nil
		}
		pr, err := c.cli.Txn(ctx).If(conds...).Then(puts...).Commit()
		if err != nil {
			return nil, fmt.Errorf("po zapisaniu %d kluczy: %w", written, err)
		}
		if !pr.Succeeded { // a key appeared concurrently: fall back to one-by-one
			for _, p := range todo {
				r1, err := c.cli.Txn(ctx).If(clientv3.Compare(clientv3.CreateRevision(string(p.k)), "=", 0)).Then(clientv3.OpPut(string(p.k), string(p.v))).Commit()
				if err != nil {
					return nil, err
				}
				if r1.Succeeded {
					written++
				} else {
					skipped++
				}
			}
			continue
		}
		written += len(todo)
	}
	return map[string]any{"total": len(pairs), "written": written, "skipped": skipped, "existing": existing,
		"outside": skippedOutside, "dryRun": req.DryRun, "sample": sample}, nil
}

// hWatch streams watch events as server-sent events.
func (s *server) hWatch(w http.ResponseWriter, r *http.Request) (any, error) {
	c, err := s.current()
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	gen := s.gen
	s.mu.RUnlock()
	q := r.URL.Query()
	key, err := decodeKey(q.Get("p"))
	if err != nil {
		return nil, err
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		return nil, errors.New("streaming unsupported")
	}
	opts := []clientv3.OpOption{clientv3.WithPrevKV(), clientv3.WithCreatedNotify(), clientv3.WithProgressNotify()}
	if q.Get("prefix") == "1" {
		opts = append(opts, clientv3.WithRange(clientv3.GetPrefixRangeEnd(string(key))))
	}
	if rv, _ := strconv.ParseInt(q.Get("rev"), 10, 64); rv > 0 {
		opts = append(opts, clientv3.WithRev(rv))
	}
	ctx, cancel := context.WithCancel(clientv3.WithRequireLeader(r.Context()))
	defer cancel()
	wch := c.cli.Watch(ctx, rangeStart(key), opts...)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	send := func(event string, v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		fl.Flush()
	}
	ping := time.NewTicker(10 * time.Second)
	defer ping.Stop()
	const maxVal = 16 << 10
	trunc := func(b []byte) string {
		if len(b) > maxVal {
			b = b[:maxVal]
		}
		return b64.EncodeToString(b)
	}
	for {
		select {
		case <-r.Context().Done():
			return nil, errStreamed
		case <-ping.C:
			s.mu.RLock()
			stale := s.gen != gen
			s.mu.RUnlock()
			if stale {
				send("error", map[string]any{"error": "połączenie z klastrem zostało zamknięte"})
				return nil, errStreamed
			}
			fmt.Fprintf(w, ": ping\n\n")
			fl.Flush()
		case resp, ok := <-wch:
			if !ok {
				send("error", map[string]any{"error": "obserwacja zakończona"})
				return nil, errStreamed
			}
			if resp.CompactRevision > 0 {
				send("error", map[string]any{"error": fmt.Sprintf("rewizja skompaktowana – najstarsza dostępna to %d", resp.CompactRevision+1), "compactRevision": resp.CompactRevision})
				return nil, errStreamed
			}
			if err := resp.Err(); err != nil {
				send("error", map[string]any{"error": explainErr(err).Error()})
				return nil, errStreamed
			}
			if resp.Created {
				send("created", map[string]any{"rev": resp.Header.Revision})
				continue
			}
			if resp.IsProgressNotify() {
				send("progress", map[string]any{"rev": resp.Header.Revision})
				continue
			}
			evs := make([]map[string]any, 0, len(resp.Events))
			for _, ev := range resp.Events {
				ks, bin := display(ev.Kv.Key)
				e := map[string]any{"type": ev.Type.String(), "k": b64.EncodeToString(ev.Kv.Key), "s": ks, "bin": bin,
					"mod": ev.Kv.ModRevision, "create": ev.Kv.CreateRevision, "ver": ev.Kv.Version,
					"lease": leaseHex(ev.Kv.Lease), "v": trunc(ev.Kv.Value), "size": len(ev.Kv.Value)}
				if ev.PrevKv != nil {
					e["prev"] = trunc(ev.PrevKv.Value)
					e["prevSize"] = len(ev.PrevKv.Value)
				}
				evs = append(evs, e)
			}
			send("events", map[string]any{"rev": resp.Header.Revision, "events": evs})
		}
	}
}
