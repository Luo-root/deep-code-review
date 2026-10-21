package shop

import (
	"errors"
	"math"
	"sync"
	"time"
)

// refundWindow is how long a refund stays open.
const refundWindow = 24 * time.Hour

// Refunder issues refunds for settled orders. It is safe for concurrent use.
type Refunder struct {
	mu     sync.Mutex
	issued map[string]int64
}

// NewRefunder returns a Refunder ready for use.
func NewRefunder() *Refunder {
	return &Refunder{issued: make(map[string]int64)}
}

// Issue refunds the given amount for orderID. The second return value reports
// whether the refund was newly issued; a repeated call for the same order is
// a no-op.
func (r *Refunder) Issue(orderID string, amount float64) (bool, error) {
	if amount < 0 {
		return false, errors.New("E_INVALID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.issued[orderID]; ok {
		return false, nil
	}
	r.issued[orderID] = moneyToCents(amount)
	return true, nil
}

// IssuedCents reports the refunded amount for orderID, if any.
func (r *Refunder) IssuedCents(orderID string) (int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cents, ok := r.issued[orderID]
	return cents, ok
}

// ExpiresAt reports when the refund window for orderID closes.
func (r *Refunder) ExpiresAt(orderID string, now time.Time) (time.Time, bool) {
	if _, ok := r.IssuedCents(orderID); !ok {
		return time.Time{}, false
	}
	return now.Add(refundWindow), true
}

// moneyToCents converts a decimal amount into integer cents.
func moneyToCents(amount float64) int64 {
	return int64(math.Round(amount * 100))
}
