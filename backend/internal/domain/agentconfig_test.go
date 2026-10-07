package domain

import (
	"encoding/json"
	"testing"
)

func TestAgentConfigPermissionFallbackDefaultsOn(t *testing.T) {
	off, on := false, true
	for _, tc := range []struct {
		name string
		cfg  AgentConfig
		want bool
	}{
		{"unset", AgentConfig{}, true},
		{"explicitly on", AgentConfig{PermissionFallback: &on}, true},
		{"explicitly off", AgentConfig{PermissionFallback: &off}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.PermissionFallbackEnabled(); got != tc.want {
				t.Fatalf("PermissionFallbackEnabled() = %t, want %t", got, tc.want)
			}
		})
	}
}

// Unset must stay absent on the wire and "off" must survive a round trip, or a
// project could never record the difference between the default and a choice.
func TestAgentConfigPermissionFallbackJSON(t *testing.T) {
	data, err := json.Marshal(AgentConfig{Permissions: PermissionModeAuto})
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != `{"permissions":"auto"}` {
		t.Fatalf("unset config marshals as %s; the default must not be written", data)
	}

	var off AgentConfig
	if err := json.Unmarshal([]byte(`{"permissionFallback":false}`), &off); err != nil {
		t.Fatal(err)
	}
	if off.PermissionFallbackEnabled() || off.IsZero() {
		t.Fatalf("a stored off was lost: %#v", off)
	}
	back, err := json.Marshal(off)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != `{"permissionFallback":false}` {
		t.Fatalf("off marshals as %s", back)
	}
}
