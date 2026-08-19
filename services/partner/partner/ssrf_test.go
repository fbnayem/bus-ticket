package partner

import (
	"net"
	"testing"
)

// A partner-registered webhook URL must never be turned into a request against
// the platform's own network. publicIP is the gate: it must reject loopback,
// private, link-local, unspecified, multicast and the cloud-metadata address,
// and accept only genuinely public addresses. Remove any clause and one of these
// assertions goes red.
func TestPublicIPRejectsInternalAddresses(t *testing.T) {
	blocked := []string{
		"127.0.0.1",       // loopback
		"::1",             // loopback v6
		"10.0.0.5",        // private A
		"172.16.9.9",      // private B
		"192.168.1.1",     // private C
		"169.254.169.254", // cloud metadata (link-local)
		"169.254.1.1",     // link-local
		"0.0.0.0",         // unspecified
		"224.0.0.1",       // multicast
		"fd00::1",         // unique-local v6 (private)
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if publicIP(ip) {
			t.Errorf("publicIP(%s) = true, want false — an internal address must be refused", s)
		}
	}

	allowed := []string{"8.8.8.8", "1.1.1.1", "203.0.113.7", "2606:4700:4700::1111"}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if !publicIP(ip) {
			t.Errorf("publicIP(%s) = false, want true — a public address must be allowed", s)
		}
	}
}
