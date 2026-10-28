package promo

import (
	"context"
	"testing"
)

func TestApplyPricesCart(t *testing.T) {
	rules := []Rule{
		{ID: "r1", SKUs: []string{"apple"}, Discount: 100},
	}
	e := New(rules)
	cart := []Item{{SKU: "apple", Count: 2, Price: 500}}

	got, err := e.Apply(context.Background(), ApplyRequest{Cart: cart})
	if err != nil {
		t.Fatal(err)
	}
	if got.Total != 800 {
		t.Fatalf("total = %d, want 800", got.Total)
	}
}

func TestApplyCheckedRejectsUnknownSKU(t *testing.T) {
	rules := []Rule{
		{ID: "r1", SKUs: []string{"apple", "pear"}, Discount: 100},
	}
	e := New(rules)
	cart := []Item{{SKU: "apple", Count: 1, Price: 500}}

	if _, err := e.ApplyChecked(context.Background(), ApplyRequest{Cart: cart}); err != ErrUnknownSKU {
		t.Fatalf("err = %v, want %v", err, ErrUnknownSKU)
	}
}

func TestDuplicateLinesFindsRepeat(t *testing.T) {
	cart := []Item{
		{SKU: "apple", Count: 1, Price: 100},
		{SKU: "apple", Count: 2, Price: 100},
		{SKU: "pear", Count: 1, Price: 100},
	}
	dupes := DuplicateLines(cart)
	if len(dupes) != 1 || dupes[0] != "apple" {
		t.Fatalf("dupes = %v, want [apple]", dupes)
	}
}
