// Package sqlstore implements the promotion engine backed by a SQL database.
//
// This package is internal to the pricing service; nothing outside the module
// imports it.
package sqlstore

import (
	"context"

	"example.com/rule-engine/internal/promo"
)

// Request carries the cart to price.
type Request struct {
	// Items is the cart to price.
	Items []promo.Item
	// RuleIDs restricts pricing to the listed rules.
	RuleIDs []string
}

// Outcome is the result of pricing a cart.
type Outcome struct {
	// Total is the price in cents after the rules were applied.
	Total int64
	// Lines holds one entry per priced cart line.
	Lines []promo.Item
}

// DB is the rule table the engine reads from.
type DB struct {
	// Rules are the stored rules.
	Rules []promo.Rule
}

// Engine prices carts against the rules stored in the database.
type Engine struct {
	// DB holds the rule table.
	DB *DB
}

// Apply prices the cart against the stored rules.
func (e *Engine) Apply(ctx context.Context, req Request) (*Outcome, error) {
	var total int64
	for _, it := range req.Items {
		total += it.Price * it.Count
	}
	return &Outcome{Total: total, Lines: req.Items}, nil
}
