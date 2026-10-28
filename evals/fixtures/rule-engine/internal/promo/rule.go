// Package promo implements the promotion rule engine.
//
// This package is internal to the pricing service; nothing outside the module
// imports it.
package promo

import (
	"context"
	"errors"
)

// ErrUnknownSKU is returned when a rule refers to a SKU the cart does not
// hold.
var ErrUnknownSKU = errors.New("E_UNKNOWN_SKU")

// ErrUnknownRule is returned when a rule ID does not name a rule of the set.
var ErrUnknownRule = errors.New("E_UNKNOWN_RULE")

// Item is one line of a shopping cart.
type Item struct {
	// SKU identifies the product on this line.
	SKU string
	// Count is how many units the line holds.
	Count int64
	// Price is the unit price in cents.
	Price int64
}

// Rule is a promotion rule. It takes Discount cents off the cart when the
// cart holds every SKU the rule lists.
type Rule struct {
	// ID identifies the rule.
	ID string
	// SKUs are the products the rule applies to.
	SKUs []string
	// Discount is the amount taken off, in cents.
	Discount int64
	// Depends lists the IDs of the rules that must be applied first. Several
	// rules may depend on the same rule.
	Depends []string
}

// Pricer prices a cart against a set of promotion rules.
type Pricer interface {
	Apply(ctx context.Context, req ApplyRequest) (*Result, error)
}

// ApplyRequest carries the cart to price.
type ApplyRequest struct {
	// Cart is the cart to price.
	Cart []Item
}

// Result is the outcome of pricing a cart.
type Result struct {
	// Total is the price in cents after the rules were applied.
	Total int64
	// Applied lists the IDs of the rules that were applied.
	Applied []string
}
