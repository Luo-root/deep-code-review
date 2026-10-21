// Package shop implements the checkout pipeline.
//
// This package is internal to the shop service; nothing outside the module
// imports it.
package shop

import (
	"errors"
	"time"
)

// ErrInvalid is returned when a checkout request cannot be fulfilled.
var ErrInvalid = errors.New("E_INVALID")

// DiscountRequest describes the discount to apply to a batch of orders.
type DiscountRequest struct {
	// Code is the discount code supplied by the caller.
	Code string
	// Threshold is the minimum order total, in cents. Orders below it are
	// skipped. Zero disables the threshold.
	Threshold int
}

// DiscountStrategy computes a discounted total.
type DiscountStrategy interface {
	Apply(total int64) int64
}

// PercentageDiscount applies a fixed percentage discount.
type PercentageDiscount struct {
	Percent int
}

// Apply returns the discounted total for total.
func (p PercentageDiscount) Apply(total int64) int64 {
	return total - total*int64(p.Percent)/100
}

// Order is a single order to check out.
type Order struct {
	ID     string
	Amount float64
}

// Stats counts checkouts for reporting.
type Stats struct {
	CheckedOut int64
}

// Checkout settles a batch of orders.
type Checkout struct {
	// Processed is the number of orders settled so far.
	Processed int64
	// Stats receives checkout counters.
	Stats *Stats
}

// Run settles every order in orders and returns the discounted total.
//
// Checkout is read-only with respect to the order store: it never mutates
// orders and never writes back to the database.
func (c *Checkout) Run(orders []Order, req DiscountRequest, timeout time.Duration) (int64, error) {
	if len(orders) == 0 {
		return 0, ErrInvalid
	}
	var total int64
	for _, o := range orders {
		if o.Amount < 0 {
			return 0, ErrInvalid
		}
		c.Stats.CheckedOut++
		amount := moneyToCents(o.Amount)
		if req.Threshold > 0 && amount < int64(req.Threshold) {
			continue
		}
		total += amount
		c.Processed++
	}
	return total, nil
}

// moneyToCents converts a decimal amount into integer cents.
func moneyToCents(amount float64) int64 {
	return int64(amount * 100)
}
