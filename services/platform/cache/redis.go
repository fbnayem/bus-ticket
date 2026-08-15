// Package cache is a small Redis client for the two jobs the plan gives Redis:
// accelerating reads that PostgreSQL already answers correctly, and counting
// things that do not need to survive a restart.
//
// It speaks RESP directly in about two hundred lines rather than pulling in a
// client library. That is a deliberate trade for this codebase: the surface
// used here is six commands, and a dependency that can reconnect, pipeline and
// cluster is solving problems this build does not have.
//
// The rule that governs every use of this package: PostgreSQL is authoritative.
// Nothing in here is allowed to be the only copy of a fact. If Redis vanishes,
// searches get slower, rate limits fall back to counting rows, and hold expiry
// is unaffected because the sweeper never consulted Redis in the first place.
package cache

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Client struct {
	addr string
	mu   sync.Mutex
	idle []*conn
	// down records the last failure so callers can degrade quietly instead of
	// paying a dial timeout on every request while Redis is gone.
	downUntil time.Time
	hits      uint64
	misses    uint64
	errs      uint64
}

type conn struct {
	c  net.Conn
	br *bufio.Reader
}

func New(addr string) *Client { return &Client{addr: addr} }

var ErrUnavailable = errors.New("cache: redis unavailable")

func (c *Client) get(ctx context.Context) (*conn, error) {
	c.mu.Lock()
	if time.Now().Before(c.downUntil) {
		c.mu.Unlock()
		return nil, ErrUnavailable
	}
	if n := len(c.idle); n > 0 {
		cn := c.idle[n-1]
		c.idle = c.idle[:n-1]
		c.mu.Unlock()
		return cn, nil
	}
	c.mu.Unlock()

	d := net.Dialer{Timeout: 500 * time.Millisecond}
	nc, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		c.mu.Lock()
		c.downUntil = time.Now().Add(5 * time.Second)
		c.errs++
		c.mu.Unlock()
		return nil, ErrUnavailable
	}
	return &conn{c: nc, br: bufio.NewReader(nc)}, nil
}

func (c *Client) put(cn *conn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.idle) < 8 {
		c.idle = append(c.idle, cn)
		return
	}
	_ = cn.c.Close()
}

func (c *Client) drop(cn *conn) {
	_ = cn.c.Close()
	c.mu.Lock()
	c.errs++
	c.mu.Unlock()
}

// do issues one command and returns the reply.
func (c *Client) do(ctx context.Context, args ...string) (any, error) {
	cn, err := c.get(ctx)
	if err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(2 * time.Second)
	}
	_ = cn.c.SetDeadline(deadline)

	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := cn.c.Write([]byte(b.String())); err != nil {
		c.drop(cn)
		return nil, ErrUnavailable
	}
	reply, err := readReply(cn.br)
	if err != nil {
		c.drop(cn)
		return nil, ErrUnavailable
	}
	c.put(cn)
	return reply, nil
}

func readReply(br *bufio.Reader) (any, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return nil, errors.New("cache: empty reply")
	}
	switch line[0] {
	case '+':
		return line[1:], nil
	case '-':
		return nil, errors.New(line[1:])
	case ':':
		return strconv.ParseInt(line[1:], 10, 64)
	case '$':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil // null bulk string: a cache miss
		}
		buf := make([]byte, n+2)
		if _, err := readFull(br, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(line[1:])
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		out := make([]any, n)
		for i := 0; i < n; i++ {
			if out[i], err = readReply(br); err != nil {
				return nil, err
			}
		}
		return out, nil
	}
	return nil, fmt.Errorf("cache: unexpected reply %q", line[:1])
}

func readFull(br *bufio.Reader, buf []byte) (int, error) {
	got := 0
	for got < len(buf) {
		n, err := br.Read(buf[got:])
		if err != nil {
			return got, err
		}
		got += n
	}
	return got, nil
}

// ------------------------------------------------------------ the six verbs --

func (c *Client) Ping(ctx context.Context) error {
	_, err := c.do(ctx, "PING")
	return err
}

func (c *Client) Get(ctx context.Context, key string) (string, bool) {
	v, err := c.do(ctx, "GET", key)
	if err != nil || v == nil {
		if err == nil {
			c.mu.Lock()
			c.misses++
			c.mu.Unlock()
		}
		return "", false
	}
	s, ok := v.(string)
	c.mu.Lock()
	if ok {
		c.hits++
	} else {
		c.misses++
	}
	c.mu.Unlock()
	return s, ok
}

func (c *Client) Set(ctx context.Context, key, value string, ttl time.Duration) {
	_, _ = c.do(ctx, "SET", key, value, "EX", strconv.Itoa(int(ttl.Seconds())))
}

func (c *Client) Del(ctx context.Context, keys ...string) {
	if len(keys) == 0 {
		return
	}
	_, _ = c.do(ctx, append([]string{"DEL"}, keys...)...)
}

// DelPrefix removes every key under a prefix. Event-driven cache invalidation
// uses it: one trip changing wipes the searches that could have included it.
func (c *Client) DelPrefix(ctx context.Context, prefix string) int {
	v, err := c.do(ctx, "KEYS", prefix+"*")
	if err != nil || v == nil {
		return 0
	}
	list, ok := v.([]any)
	if !ok || len(list) == 0 {
		return 0
	}
	keys := make([]string, 0, len(list))
	for _, k := range list {
		if s, ok := k.(string); ok {
			keys = append(keys, s)
		}
	}
	c.Del(ctx, keys...)
	return len(keys)
}

// Allow is a fixed-window counter. It is the fast path in front of a database
// check, never the only check — see identity.Service.checkRate.
func (c *Client) Allow(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	v, err := c.do(ctx, "INCR", key)
	if err != nil {
		return true, err // Redis is down: defer to the database
	}
	n, _ := v.(int64)
	if n == 1 {
		_, _ = c.do(ctx, "EXPIRE", key, strconv.Itoa(int(window.Seconds())))
	}
	return int(n) <= limit, nil
}

// Deadline mirrors a hold's expiry as a Redis key with a TTL. It exists for
// latency only. PostgreSQL's expires_at column plus the sweeper is what
// actually guarantees a seat is never stranded, which is why losing every key
// in here costs nothing but a few seconds of delay.
func (c *Client) Deadline(ctx context.Context, holdID string, at time.Time) {
	ttl := time.Until(at)
	if ttl <= 0 {
		return
	}
	c.Set(ctx, "hold:"+holdID, strconv.FormatInt(at.Unix(), 10), ttl)
}

type Stats struct {
	Hits      uint64 `json:"hits"`
	Misses    uint64 `json:"misses"`
	Errors    uint64 `json:"errors"`
	Available bool   `json:"available"`
}

func (c *Client) Stats(ctx context.Context) Stats {
	available := c.Ping(ctx) == nil
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{Hits: c.hits, Misses: c.misses, Errors: c.errs, Available: available}
}
