package store_test

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestAgentAssetSourcesPersistAndClear(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	for _, sources := range [][]string{{"/live/.claude", ".agents"}, {}} {
		if err := store.SetAgentAssetSources(ctx, sources, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		settings, err := store.GetAppSettings(ctx)
		if err != nil || !reflect.DeepEqual(settings.AgentAssetSources, sources) {
			t.Fatalf("settings=%+v err=%v", settings, err)
		}
	}
}
