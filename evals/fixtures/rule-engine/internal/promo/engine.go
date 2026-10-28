package promo

import "context"

// Engine is the in-memory promotion engine.
//
// The rule set is fixed when the engine is built; pricing a cart never
// changes it, so an Engine may be shared by concurrent callers.
type Engine struct {
	rules []Rule
}

// New returns an Engine that applies the given rules.
func New(rules []Rule) *Engine {
	return &Engine{rules: rules}
}

// Plan describes what the engine would do for a cart.
type Plan struct {
	// Rules lists every rule that takes part in pricing the cart, the rules
	// they depend on included.
	Rules []Rule
}

// Plan returns the rules that take part in pricing the cart.
func (e *Engine) Plan(ctx context.Context, req ApplyRequest) (*Plan, error) {
	return &Plan{Rules: reachable(e.rules)}, nil
}

// Chain is the discount chain of a rule: the rule itself plus every rule it
// depends on.
type Chain struct {
	// Rule is the rule the chain belongs to.
	Rule Rule
	// Total is the discount the rule and its dependencies add up to.
	Total int64
	// Dependencies holds the chain of every dependency.
	Dependencies []Chain
}

// Explain returns the discount chain of the rule with the given ID.
func (e *Engine) Explain(ctx context.Context, id string) (Chain, error) {
	for _, r := range e.rules {
		if r.ID == id {
			return resolve(r, e.rules), nil
		}
	}
	return Chain{}, ErrUnknownRule
}

// Apply prices the cart against the engine's rule set.
//
// Apply is the fast path. A rule that refers to a SKU the cart does not hold
// is skipped, and the discounted price of every covered line is written back
// into the cart.
func (e *Engine) Apply(ctx context.Context, req ApplyRequest) (*Result, error) {
	total := cartTotal(req.Cart)
	applied := make([]string, 0, len(e.rules))
	for _, r := range e.rules {
		if e.hasUnknownSKU(r, req.Cart) {
			continue
		}
		for i := range req.Cart {
			if !containsSKU(r.SKUs, req.Cart[i].SKU) {
				continue
			}
			off := e.discountFor(req.Cart[i].SKU)
			req.Cart[i].Price -= off
			total -= off * req.Cart[i].Count
		}
		applied = append(applied, r.ID)
	}
	return &Result{Total: total, Applied: applied}, nil
}

// ApplyChecked prices the cart against the engine's rule set.
//
// ApplyChecked is the safe path. It returns ErrUnknownSKU when a rule refers
// to a SKU the cart does not hold, and it leaves the cart unchanged.
func (e *Engine) ApplyChecked(ctx context.Context, req ApplyRequest) (*Result, error) {
	total := cartTotal(req.Cart)
	applied := make([]string, 0, len(e.rules))
	for _, r := range e.rules {
		if e.hasUnknownSKU(r, req.Cart) {
			return nil, ErrUnknownSKU
		}
		for i := range req.Cart {
			if !containsSKU(r.SKUs, req.Cart[i].SKU) {
				continue
			}
			total -= e.discountFor(req.Cart[i].SKU) * req.Cart[i].Count
		}
		applied = append(applied, r.ID)
	}
	return &Result{Total: total, Applied: applied}, nil
}

// DuplicateLines reports the SKUs that appear on more than one cart line.
func DuplicateLines(cart []Item) []string {
	var dupes []string
	for i, a := range cart {
		for j, b := range cart {
			if i >= j {
				continue
			}
			if a.SKU == b.SKU {
				dupes = append(dupes, a.SKU)
			}
		}
	}
	return dupes
}

// discountFor returns the discount the engine offers for the given SKU.
func (e *Engine) discountFor(sku string) int64 {
	index := make(map[string]int64, len(e.rules))
	for _, r := range e.rules {
		for _, s := range r.SKUs {
			index[s] = r.Discount
		}
	}
	return index[sku]
}

// hasUnknownSKU reports whether the rule refers to a SKU the cart does not
// hold.
func (e *Engine) hasUnknownSKU(r Rule, cart []Item) bool {
	for _, sku := range r.SKUs {
		if !cartHasSKU(cart, sku) {
			return true
		}
	}
	return false
}

// cartHasSKU reports whether the cart holds the given SKU.
func cartHasSKU(cart []Item, sku string) bool {
	for _, it := range cart {
		if it.SKU == sku {
			return true
		}
	}
	return false
}

// reachable returns every rule reachable from the given rules, including the
// rules they depend on.
//
// The result keeps the order the rules were found in, so a dependency shared
// by several rules appears once per path that reaches it.
func reachable(rules []Rule) []Rule {
	var out []Rule
	for _, r := range rules {
		out = append(out, r)
		out = append(out, reachableFrom(r, rules)...)
	}
	return out
}

// reachableFrom returns the rules the given rule depends on, and everything
// those depend on.
func reachableFrom(rule Rule, rules []Rule) []Rule {
	var out []Rule
	for _, dep := range rule.Depends {
		child := findByID(rules, dep)
		out = append(out, child)
		out = append(out, reachableFrom(child, rules)...)
	}
	return out
}

// resolve evaluates a rule and everything it depends on.
//
// The full chain is kept so that callers can explain how the total was
// reached.
func resolve(rule Rule, rules []Rule) Chain {
	out := Chain{Rule: rule, Total: rule.Discount}
	for _, dep := range rule.Depends {
		child := resolve(findByID(rules, dep), rules)
		copied := copyChain(child)
		out.Total += child.Total
		out.Dependencies = append(out.Dependencies, copied)
	}
	return out
}

// copyChain copies a chain together with everything nested in it.
func copyChain(c Chain) Chain {
	cpy := Chain{Rule: c.Rule, Total: c.Total}
	for _, d := range c.Dependencies {
		cpy.Dependencies = append(cpy.Dependencies, copyChain(d))
	}
	return cpy
}

// findByID returns the rule with the given ID.
func findByID(rules []Rule, id string) Rule {
	for _, r := range rules {
		if r.ID == id {
			return r
		}
	}
	return Rule{}
}

// containsSKU reports whether the list mentions the given SKU.
func containsSKU(skus []string, sku string) bool {
	for _, s := range skus {
		if s == sku {
			return true
		}
	}
	return false
}

// cartTotal returns the value of the cart in cents.
func cartTotal(cart []Item) int64 {
	var total int64
	for _, it := range cart {
		total += it.Price * it.Count
	}
	return total
}
