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
	if err := store.SetSessionRetentionDays(ctx, 123, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	for _, sources := range [][]string{{"/live/.claude", ".agents"}, {}} {
		if err := store.SetAgentAssetSources(ctx, sources, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		settings, err := store.GetAppSettings(ctx)
		if err != nil || !reflect.DeepEqual(settings.AgentAssetSources, sources) || settings.SessionRetentionDays != 123 {
			t.Fatalf("settings=%+v err=%v", settings, err)
		}
	}
}

func TestSessionRetentionPreservesAgentAssetSources(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	sources := []string{"/live/.claude", "/live/.agents"}
	if err := store.SetAgentAssetSources(ctx, sources, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	for _, days := range []int{30, 0} {
		if err := store.SetSessionRetentionDays(ctx, days, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		settings, err := store.GetAppSettings(ctx)
		if err != nil || settings.SessionRetentionDays != days || !reflect.DeepEqual(settings.AgentAssetSources, sources) {
			t.Fatalf("settings=%+v err=%v", settings, err)
		}
	}
}
