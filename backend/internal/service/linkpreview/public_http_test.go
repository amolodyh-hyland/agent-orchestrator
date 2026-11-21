package linkpreview

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestPublicPreviewRejectsUnsafeURLsAndAddresses(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "http://localhost", "http://service.internal", "http://127.0.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://10.0.0.1", "http://169.254.169.254", "http://100.64.0.1", "http://192.0.2.1", "http://example.test:8080", "https://user:secret@example.test", "https://example.test/%0D%0Aheader"} {
		t.Run(raw, func(t *testing.T) {
			u, err := url.Parse(raw)
			if err == nil && publicURL(u) == nil {
				t.Fatal("unsafe destination accepted")
			}
		})
	}
	for _, raw := range []string{"0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "198.51.100.1", "203.0.113.1", "fc00::1", "fec0::1", "fe80::1", "2001:db8::1", "3fff::1", "64:ff9b::7f00:1", "2002:7f00:1::"} {
		if publicAddress(netip.MustParseAddr(raw)) {
			t.Errorf("unsafe IP accepted: %s", raw)
		}
	}
}

func TestPublicPreviewPinsResolvedPublicIPAndDoesNotUseProxyOrCredentials(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1234")
	var addresses []string
	client := publicPreviewClient(func(_ context.Context, host string) ([]netip.Addr, error) {
		if host != "public.example" {
			t.Errorf("unexpected lookup: %s", host)
		}
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}, func(_ context.Context, _, address string) (net.Conn, error) {
		addresses = append(addresses, address)
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			r, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				return
			}
			if r.Host != "public.example" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
				t.Error("request authority or credential isolation failed")
			}
			body := "<title>New page title</title>"
			_, _ = fmt.Fprintf(server, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
		}()
		return client, nil
	})
	req, _ := http.NewRequest(http.MethodGet, "http://public.example/new?q=secret#fragment", nil)
	req.Header.Set("Cookie", "session=secret")
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Referer", "https://private.example/")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if !reflect.DeepEqual(addresses, []string{"93.184.216.34:80"}) {
		t.Fatalf("DNS name was not pinned: %v", addresses)
	}
	if client.Transport.(*publicTransport).transport.Proxy != nil || client.Jar != nil {
		t.Fatal("ambient proxy/cookie state enabled")
	}
}

func TestPublicPreviewRejectsMixedDNSAndRedirectRebindingWithoutDialingPrivateIP(t *testing.T) {
	for _, mixed := range []bool{true, false} {
		t.Run(fmt.Sprint("mixed=", mixed), func(t *testing.T) {
			lookups, dials := 0, 0
			client := publicPreviewClient(func(_ context.Context, _ string) ([]netip.Addr, error) {
				lookups++
				if mixed {
					return []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")}, nil
				}
				if lookups > 1 {
					return []netip.Addr{netip.MustParseAddr("10.0.0.1")}, nil
				}
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}, func(_ context.Context, _, address string) (net.Conn, error) {
				dials++
				if address != "93.184.216.34:80" {
					t.Errorf("unsafe dial: %s", address)
				}
				client, server := net.Pipe()
				go func() {
					defer server.Close()
					_, _ = http.ReadRequest(bufio.NewReader(server))
					_, _ = io.WriteString(server, "HTTP/1.1 302 Found\r\nLocation: http://rebound.example/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
				}()
				return client, nil
			})
			_, err := client.Get("http://public.example/")
			if err == nil {
				t.Fatal("unsafe destination fetched")
			}
			if mixed && dials != 0 || !mixed && (dials != 1 || lookups != 2) {
				t.Fatalf("unexpected lookup/dial count: %d/%d", lookups, dials)
			}
		})
	}
}

func TestPublicPreviewRedirectPolicyAndMetadataCache(t *testing.T) {
	client := publicPreviewClient(nil, nil)
	first, _ := http.NewRequest(http.MethodGet, "https://public.example/", nil)
	for _, raw := range []string{"http://public.example/", "https://127.0.0.1/", "https://user:secret@public.example/", "file:///tmp/example"} {
		req, _ := http.NewRequest(http.MethodGet, raw, nil)
		if client.CheckRedirect(req, []*http.Request{first}) == nil {
			t.Fatalf("unsafe redirect accepted: %s", raw)
		}
	}
	count := 0
	client = publicPreviewClient(func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
	}, func(context.Context, string, string) (net.Conn, error) {
		count++
		a, b := net.Pipe()
		go func() {
			defer b.Close()
			_, _ = http.ReadRequest(bufio.NewReader(b))
			body := "<title>Brand new page</title>"
			_, _ = fmt.Fprintf(b, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
		}()
		return a, nil
	})
	svc := New(client)
	for i := 0; i < 2; i++ {
		result, err := svc.Preview(context.Background(), "http://new.example/page")
		if err != nil || !strings.Contains(result.Title, "Brand new page") {
			t.Fatalf("new URL title unavailable: %#v, %v", result, err)
		}
	}
	if count != 1 {
		t.Fatalf("metadata cache missed: %d requests", count)
	}
}
