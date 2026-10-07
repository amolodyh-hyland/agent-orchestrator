package multicahost

import (
	"path/filepath"
	"testing"
)

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestContractEnabled(t *testing.T) {
	for value, want := range map[string]bool{"": false, "0": false, "off": false, "yes": false, "1": true, "true": true, " ON ": true} {
		if got := Enabled(envFrom(map[string]string{FlagEnv: value})); got != want {
			t.Errorf("Enabled(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestContractHealthPort(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want int
	}{
		{"default profile", map[string]string{}, 19514},
		{"named profile formula", map[string]string{ProfileEnv: "aospike"}, 20263},
		{"override wins", map[string]string{ProfileEnv: "aospike", HealthPortEnv: "31000"}, 31000},
		{"invalid override ignored", map[string]string{HealthPortEnv: "70000"}, 19514},
	}
	for _, c := range cases {
		if got := HealthPort(envFrom(c.env)); got != c.want {
			t.Errorf("%s: HealthPort = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestContractStateDir(t *testing.T) {
	home := filepath.Join(string(filepath.Separator), "h")
	if dir, err := StateDir(home, ""); err != nil || dir != filepath.Join(home, ".multica") {
		t.Errorf("default: %q %v", dir, err)
	}
	if dir, err := StateDir(home, "p"); err != nil || dir != filepath.Join(home, ".multica", "profiles", "p") {
		t.Errorf("named: %q %v", dir, err)
	}
	for _, bad := range []string{".", "..", "a/b", `a\b`} {
		if _, err := StateDir("/h", bad); err == nil {
			t.Errorf("StateDir accepted %q", bad)
		}
	}
}
