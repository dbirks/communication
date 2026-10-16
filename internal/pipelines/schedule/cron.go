// Package schedule parses the cron expressions a schedule fires on
// (ADR-0032 § 3, communication-spec/07-config-integrations.md's "cron-like
// schedule" trigger). It is deliberately small: 5-field Vixie-style cron in
// UTC, with a hand-written parser rather than a dependency (ADR-0032: no new
// module for a grammar this narrow, and a scheduler whose whole contract is
// "compute the next minute" must be auditable in one screen).
//
// Supported per field: `*`, a single value, lists (`1,2,3`), inclusive ranges
// (`1-5`) and steps (`*/n`, `1-5/2`). Day-of-week accepts 0-7 with 7 folded to
// 0 (Sunday). When BOTH day-of-month and day-of-week are restricted the day
// matches if EITHER matches — Vixie's rule, the one cron users expect, not an
// AND that can never fire for `0 12 13 * FRI`-style combinations.
//
// Deliberately unsupported, each refused by Parse with a message naming the
// syntax rather than misfiring: 6/7-field forms (seconds, years), month and
// weekday NAMES, `?`, `L`, `W`, `#`, `H`, wrapped ranges (`22-2`), and a step
// on a single value (`5/10`). No DST: Next works in UTC, so a schedule does
// not shift when a host's zone changes.
package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Fields is how many space-separated fields a supported expression carries.
const Fields = 5

// maxDayScan bounds the search for a next occurrence at a little over twelve
// years of days. The longest gap a 5-field expression can honestly have is
// eight years — a leap-day expression crossing a non-leap century year
// (2096-02-29 to 2104-02-29 skips 2100) — so twelve years covers every real
// schedule with margin while still being ~4.4k mask lookups, cheap enough that
// no expression can turn a tick into CPU exhaustion. An expression that finds
// nothing inside the bound is one that never matches (Feb 30), and Next
// documents that answer as the zero time.Time.
const maxDayScan = 366*12 + 2

// Cron is one parsed expression: five bitmasks plus the two flags that say
// whether day-of-month and day-of-week were restricted (the OR rule).
// The zero Cron matches nothing useful; build one with Parse.
type Cron struct {
	expr string

	minute bits
	hour   bits
	dom    bits
	month  bits
	dow    bits

	domRestricted bool
	dowRestricted bool
}

// String returns the normalized expression (fields joined by single spaces),
// which is what the schedules row stores.
func (c Cron) String() string { return c.expr }

// Parse reads a 5-field expression. Every rejection names the field and the
// syntax that caused it, because the message reaches a human fixing a
// schedule in a UI they did not write.
func Parse(expr string) (Cron, error) {
	fields := strings.Fields(expr)
	if len(fields) != Fields {
		return Cron{}, fmt.Errorf(
			"schedule: cron expression %q wants %d fields (minute hour day-of-month month day-of-week), got %d",
			expr, Fields, len(fields))
	}
	out := Cron{expr: strings.Join(fields, " ")}
	var err error
	if out.minute, err = parseField(fields[0], 0, 59, "minute"); err != nil {
		return Cron{}, err
	}
	if out.hour, err = parseField(fields[1], 0, 23, "hour"); err != nil {
		return Cron{}, err
	}
	if out.dom, out.domRestricted, err = parseFieldRestricted(fields[2], 1, 31, "day-of-month"); err != nil {
		return Cron{}, err
	}
	if out.month, err = parseField(fields[3], 1, 12, "month"); err != nil {
		return Cron{}, err
	}
	// Day-of-week takes 0-7 so `* * * * 7` reads as Sunday like every other
	// cron; the fold happens after the range check.
	if out.dow, out.dowRestricted, err = parseFieldRestricted(fields[4], 0, 7, "day-of-week"); err != nil {
		return Cron{}, err
	}
	if out.dow.has(7) {
		out.dow = out.dow.clear(7).set(0)
	}
	return out, nil
}

// ------------------------------------------------------------------ parsing

// bits is a set of field values as a uint64 mask (the widest field is 0-59).
type bits uint64

func (b bits) set(i int) bits   { return b | bits(1)<<uint(i) }
func (b bits) clear(i int) bits { return b &^ (bits(1) << uint(i)) }
func (b bits) has(i int) bool   { return b&(bits(1)<<uint(i)) != 0 }
func (b bits) empty() bool      { return b == 0 }

// parseFieldRestricted parses one field and reports whether it was anything
// other than a bare `*` — the "restricted" flag Vixie's day rule needs.
func parseFieldRestricted(field string, min, max int, name string) (bits, bool, error) {
	m, err := parseField(field, min, max, name)
	if err != nil {
		return 0, false, err
	}
	return m, field != "*", nil
}

// parseField parses comma-separated items into one mask.
func parseField(field string, min, max int, name string) (bits, error) {
	out := bits(0)
	for _, item := range strings.Split(field, ",") {
		m, err := parseItem(item, min, max, name)
		if err != nil {
			return 0, err
		}
		out |= m
	}
	if out.empty() {
		return 0, fmt.Errorf("schedule: cron %s field %q matches nothing", name, field)
	}
	return out, nil
}

// parseItem parses `*`, `N`, `A-B`, `*/n` or `A-B/n`. An empty item (from
// `1,,2` or a trailing comma) is an error: silently dropping it would widen
// the fire time, which is the one failure mode a scheduler must not have.
func parseItem(item string, min, max int, name string) (bits, error) {
	if item == "" {
		return 0, fmt.Errorf("schedule: cron %s field has an empty item (a stray comma)", name)
	}
	body, stepText := item, ""
	hasStep := false
	if i := strings.IndexByte(item, '/'); i >= 0 {
		body, stepText, hasStep = item[:i], item[i+1:], true
		if body == "" {
			return 0, fmt.Errorf("schedule: cron %s item %q needs a range or * before /", name, item)
		}
		if strings.ContainsAny(stepText, "/") {
			return 0, fmt.Errorf("schedule: cron %s item %q has more than one /", name, item)
		}
	}

	lo, hi := min, max
	switch {
	case body == "*":
	case strings.Contains(body, "-"):
		parts := strings.Split(body, "-")
		if len(parts) != 2 {
			return 0, fmt.Errorf("schedule: cron %s item %q is not a range", name, item)
		}
		var err error
		if lo, err = parseNum(parts[0], min, max, name, item); err != nil {
			return 0, err
		}
		if hi, err = parseNum(parts[1], min, max, name, item); err != nil {
			return 0, err
		}
		if lo > hi {
			return 0, fmt.Errorf("schedule: cron %s range %q must not wrap; list the values instead", name, item)
		}
	default:
		if hasStep {
			return 0, fmt.Errorf(
				"schedule: cron %s item %q is unsupported: a step needs * or a range (write %d-%d/%s)",
				name, item, lo, max, stepText)
		}
		n, err := parseNum(body, min, max, name, item)
		if err != nil {
			return 0, err
		}
		lo, hi = n, n
	}

	step := 1
	if hasStep {
		if stepText == "" {
			return 0, fmt.Errorf("schedule: cron %s item %q needs a step count after /", name, item)
		}
		n, err := parseNum(stepText, 1, max-min+1, name, item)
		if err != nil {
			return 0, err
		}
		step = n
	}

	out := bits(0)
	for v := lo; v <= hi; v += step {
		out = out.set(v)
	}
	return out, nil
}

// parseNum reads an unsigned decimal literal in range. Signs, spaces, hex and
// anything else are refused: names (JAN, MON) fail here too, which is why the
// parser needs no name tables at all.
func parseNum(s string, min, max int, name, item string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("schedule: cron %s item %q has an empty number", name, item)
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			continue
		}
		if strings.ContainsRune("?LW#H", r) {
			return 0, fmt.Errorf("schedule: cron %s item %q uses unsupported syntax %q", name, item, string(r))
		}
		return 0, fmt.Errorf("schedule: cron %s item %q is not a plain number (names such as JAN/MON are not supported)", name, item)
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("schedule: cron %s item %q is not a number: %w", name, item, err)
	}
	if n < min || n > max {
		return 0, fmt.Errorf("schedule: cron %s value %d is outside %d-%d", name, n, min, max)
	}
	return n, nil
}

// ------------------------------------------------------------- next fire

// Next returns the first matching minute STRICTLY after `after`, evaluated in
// UTC (ADR-0032 § 3: a schedule belongs to the deployment's clock, not to any
// user's zone). It returns the zero time.Time when nothing matches inside
// maxDayScan days, which for a 5-field expression means what it looks like —
// an impossible day/month pair such as Feb 30. Callers that must not accept
// one (schedule Create/Update) check for the zero value.
//
// The search walks whole days, at most maxDayScan of them: a bounded number
// of mask lookups, so a fire-time computation cannot be turned into CPU
// exhaustion by a hostile expression.
func (c Cron) Next(after time.Time) time.Time {
	// Truncate floors to the minute (a sub-minute `after` floors to its own
	// minute), and the +1 below makes the start strictly after `after` in
	// both cases — a tick that lands at 10:00:00.000 must not answer 10:00.
	cur := after.UTC().Truncate(time.Minute).Add(time.Minute)

	for day := 0; day <= maxDayScan; day++ {
		date := time.Date(cur.Year(), cur.Month(), cur.Day(), 0, 0, 0, 0, time.UTC)
		if c.month.has(int(cur.Month())) && c.dayMatches(cur.Day(), cur.Weekday()) {
			if at, ok := c.firstTimeOnDay(cur); ok {
				return at
			}
		}
		cur = date.AddDate(0, 0, 1)
	}
	return time.Time{}
}

// dayMatches is Vixie's rule: a both-restricted day pair matches on EITHER
// field, a single-restricted pair matches on the one that was written, and
// `* *` matches every day.
func (c Cron) dayMatches(day int, wd time.Weekday) bool {
	mDom, mDow := c.dom.has(day), c.dow.has(int(wd))
	switch {
	case c.domRestricted && c.dowRestricted:
		return mDom || mDow
	case c.domRestricted:
		return mDom
	case c.dowRestricted:
		return mDow
	default:
		return true
	}
}

// firstTimeOnDay returns the earliest matching hour:minute at or after `from`
// within from's own date (so a partial first day is respected and the answer
// never lands on the following day — the caller checks that one itself).
func (c Cron) firstTimeOnDay(from time.Time) (time.Time, bool) {
	// The first candidate hour is from's own, so its minutes start at
	// from.Minute() — 0 from the second hour on. Starting at 0 here would
	// let Next answer a minute earlier than `from` whenever the hour matched.
	startMinute := from.Minute()
	for hour := from.Hour(); hour < 24; hour++ {
		if !c.hour.has(hour) {
			startMinute = 0
			continue
		}
		for minute := startMinute; minute < 60; minute++ {
			if c.minute.has(minute) {
				return time.Date(from.Year(), from.Month(), from.Day(),
					hour, minute, 0, 0, time.UTC), true
			}
		}
		startMinute = 0
	}
	return time.Time{}, false
}

// Matches reports whether t falls in the expression — the predicate Next is
// built to agree with. Seconds and nanoseconds are ignored: a fire is a
// minute, and Next only ever answers a whole minute. Exported so the
// scheduler's own tests, and any caller that wants to double-check a stored
// expression against a candidate time, can ask without reimplementing the
// day rule.
func (c Cron) Matches(t time.Time) bool {
	u := t.UTC()
	return c.month.has(int(u.Month())) &&
		c.dayMatches(u.Day(), u.Weekday()) &&
		c.hour.has(u.Hour()) &&
		c.minute.has(u.Minute())
}
