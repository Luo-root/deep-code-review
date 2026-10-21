package shop

import (
	"testing"
	"time"
)

func TestRunSkipsBelowThreshold(t *testing.T) {
	c := &Checkout{Stats: &Stats{}}
	got, err := c.Run(
		[]Order{{ID: "a", Amount: 5.00}, {ID: "b", Amount: 50.00}},
		DiscountRequest{Threshold: 1000},
		time.Second,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 5000 {
		t.Fatalf("got %d cents, want 5000", got)
	}
}

func TestRunRejectsNegativeAmount(t *testing.T) {
	c := &Checkout{Stats: &Stats{}}
	_, err := c.Run([]Order{{ID: "a", Amount: -1}}, DiscountRequest{}, time.Second)
	if err == nil {
		t.Fatal("expected an error for a negative amount")
	}
	if err.Error() != "E_INVALID" {
		t.Fatalf("got %q, want E_INVALID", err.Error())
	}
}

func TestRunEmptyBatch(t *testing.T) {
	c := &Checkout{Stats: &Stats{}}
	_, err := c.Run(nil, DiscountRequest{}, time.Second)
	if err == nil || err.Error() != "E_INVALID" {
		t.Fatalf("got %v, want E_INVALID", err)
	}
}
