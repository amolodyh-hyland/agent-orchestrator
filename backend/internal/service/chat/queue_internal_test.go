package chat

import "testing"

func TestQueuedEditLegacyReceiptHash(t *testing.T) {
	// Receipt written before selection intent was added. An omitted intent must
	// still reconcile that accepted edit after an upgrade.
	zero := int64(0)
	delivery, err := queuedEditDelivery("queued", QueuedMessageEdit{ClientMessageID: "legacy-receipt", Text: "$review original", RetainedContent: &[]int{}, ExpectedRevision: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if delivery.RequestHash != "7b7190a48bb0f0fafc196f56c65ad030af80793ceca635129f9e66cc7d752e30" {
		t.Fatalf("legacy receipt hash changed: %s", delivery.RequestHash)
	}
}
