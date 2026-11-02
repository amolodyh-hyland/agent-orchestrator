package domain

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestAgentAssetSourcePrecedenceRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		json string
		want []string
	}{
		{`{}`, []string{"/global"}},
		{`{"agentAssetSources":null}`, []string{"/global"}},
		{`{"agentAssetSources":[]}`, []string{}},
		{`{"agentAssetSources":[".claude"]}`, []string{".claude"}},
	} {
		var cfg ProjectConfig
		if err := json.Unmarshal([]byte(tc.json), &cfg); err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(cfg)
		if err != nil {
			t.Fatal(err)
		}
		var roundtrip ProjectConfig
		if err := json.Unmarshal(data, &roundtrip); err != nil {
			t.Fatal(err)
		}
		if got := roundtrip.ResolveAgentAssetSources([]string{"/global"}); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: got %v want %v", tc.json, got, tc.want)
		}
	}
}
