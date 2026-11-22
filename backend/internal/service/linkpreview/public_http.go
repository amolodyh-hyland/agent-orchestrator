package linkpreview

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
)

var errUnsafeDestination = errors.New("link preview requires a public HTTP(S) destination")

var reservedNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"), netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("2001:10::/28"), netip.MustParsePrefix("2001:20::/28"),
	netip.MustParsePrefix("2001::/32"), netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"), netip.MustParsePrefix("64:ff9b::/96"),
}

func publicAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip.Zone() != "" || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range reservedNetworks {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

func publicURL(u *url.URL) error {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if u.User != nil || host == "" || (u.Scheme != "http" && u.Scheme != "https") || strings.IndexFunc(u.String(), unicode.IsControl) >= 0 {
		return errUnsafeDestination
	}
	if port := u.Port(); port != "" && port != "80" && port != "443" {
		return errUnsafeDestination
	}
	query, err := url.QueryUnescape(u.RawQuery)
	if err != nil || strings.IndexFunc(u.Path+query+u.Fragment, unicode.IsControl) >= 0 {
		return errUnsafeDestination
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		if !publicAddress(ip) {
			return errUnsafeDestination
		}
	} else if !strings.Contains(host, ".") || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return errUnsafeDestination
	}
	for _, control := range []string{"%00", "%0a", "%0d"} {
		if strings.Contains(strings.ToLower(u.String()), control) {
			return errUnsafeDestination
		}
	}
	return nil
}

type lookupAddresses func(context.Context, string) ([]netip.Addr, error)
type dialAddress func(context.Context, string, string) (net.Conn, error)

type publicTransport struct{ transport *http.Transport }

func (t *publicTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := publicURL(req.URL); err != nil {
		return nil, err
	}
	clean := req.Clone(req.Context())
	clean.Header.Del("Authorization")
	clean.Header.Del("Cookie")
	clean.Header.Del("Referer")
	return t.transport.RoundTrip(clean)
}

func publicPreviewClient(lookup lookupAddresses, dial dialAddress) *http.Client {
	if lookup == nil {
		lookup = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	if dial == nil {
		dial = (&net.Dialer{Timeout: fetchTimeout}).DialContext
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = fetchTimeout
	transport.IdleConnTimeout = 30 * time.Second
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || (port != "80" && port != "443") {
			return nil, errUnsafeDestination
		}
		ips, err := lookup(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, errUnsafeDestination
		}
		for _, ip := range ips {
			if !publicAddress(ip) {
				return nil, errUnsafeDestination
			}
		}
		for _, ip := range ips {
			conn, dialErr := dial(ctx, network, net.JoinHostPort(ip.Unmap().String(), port))
			if dialErr == nil {
				return conn, nil
			}
			err = dialErr
		}
		return nil, err
	}
	return &http.Client{
		Transport: &publicTransport{transport: transport},
		Timeout:   fetchTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errors.New("link preview redirect limit exceeded")
			}
			if err := publicURL(req.URL); err != nil {
				return err
			}
			if len(via) > 0 && via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
				return errUnsafeDestination
			}
			req.Header.Del("Authorization")
			req.Header.Del("Cookie")
			req.Header.Del("Referer")
			return nil
		},
	}
}
