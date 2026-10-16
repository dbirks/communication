package schedule

import (
	"strings"
	"testing"
	"time"
)

// utc builds a wall-clock time in the only zone schedules fire in.
func utc(y int, mo time.Month, d, h, mi int) time.Time {
	return time.Date(y, mo, d, h, mi, 0, 0, time.UTC)
}

func TestCronParseAccepts(t *testing.T) {
	for _, tt := range []struct {
		expr string
		want string // normalized; "" means equal to expr
	}{
		{expr: "* * * * *"},
		{expr: "0 0 * * *"},
		{expr: "*/15 * * * *"},
		{expr: "5 4 * * *"},
		{expr: "0 6,18 * * *"},
		{expr: "0 9-17 * * 1-5"},
		{expr: "0 0 1 */3 *"},
		{expr: "0 0 1-7 */1 1"},
		{expr: "30 4 1,15 * 3"},
		{expr: "0 12 * * 7"}, // 7 folds to Sunday, same as 0
		{expr: "0-30/10 * * * *"},
		{expr: "  0   5 * * 1  ", want: "0 5 * * 1"}, // surrounding space is not syntax
	} {
		got, err := Parse(tt.expr)
		if err != nil {
			t.Errorf("Parse(%q) = error %v, want a parsed expression", tt.expr, err)
			continue
		}
		want := tt.want
		if want == "" {
			want = strings.Join(strings.Fields(tt.expr), " ")
		}
		if got.String() != want {
			t.Errorf("Parse(%q).String() = %q, want %q", tt.expr, got.String(), want)
		}
	}
}

func TestCronParseRejects(t *testing.T) {
	for _, tt := range []struct {
		expr string
		says string // substring the error must name
	}{
		{expr: "", says: "wants 5 fields"},
		{expr: "* * * *", says: "wants 5 fields"},
		{expr: "0 0 * * * *", says: "wants 5 fields"},      // seconds form
		{expr: "0 0 * * * * 2030", says: "wants 5 fields"}, // year form
		{expr: "60 * * * *", says: "outside 0-59"},
		{expr: "* 24 * * *", says: "outside 0-23"},
		{expr: "* * 0 * *", says: "outside 1-31"},
		{expr: "* * * 0 *", says: "outside 1-12"},
		{expr: "* * * * 8", says: "outside 0-7"},
		{expr: "* * * MON *", says: "not a plain number"},
		{expr: "* * * * FRI", says: "not a plain number"},
		{expr: "* * * ? *", says: "unsupported syntax"},
		{expr: "0 0 L * *", says: "unsupported syntax"},
		{expr: "0 0 1W * *", says: "unsupported syntax"},
		{expr: "0 0 * * 5#3", says: "unsupported syntax"},
		{expr: "0 0 * * H", says: "unsupported syntax"},
		{expr: "0 22-2 * * *", says: "must not wrap"},
		{expr: "5/10 * * * *", says: "unsupported"},
		{expr: "1,,2 * * * *", says: "empty item"},
		{expr: "1, * * * *", says: "empty item"},
		{expr: "*/0 * * * *", says: "outside 1-60"},
		{expr: "*/ * * * *", says: "needs a step count"},
		{expr: "*/2/2 * * * *", says: "more than one /"},
		{expr: "1-2-3 * * * *", says: "not a range"},
		{expr: "-5 * * * *", says: "empty number"},
		{expr: "+5 * * * *", says: "not a plain number"},
		{expr: "0x5 * * * *", says: "not a plain number"},
	} {
		_, err := Parse(tt.expr)
		if err == nil {
			t.Errorf("Parse(%q) succeeded, want an error saying %q", tt.expr, tt.says)
			continue
		}
		if !strings.Contains(err.Error(), tt.says) {
			t.Errorf("Parse(%q) error = %v, want it to say %q", tt.expr, err, tt.says)
		}
	}
}

func TestCronNext(t *testing.T) {
	for _, tt := range []struct {
		name  string
		expr  string
		after time.Time
		want  time.Time
	}{
		{
			name: "every minute", expr: "* * * * *",
			after: utc(2026, 3, 10, 8, 42), want: utc(2026, 3, 10, 8, 43),
		},
		{
			name: "strictly after an exact match", expr: "*/15 * * * *",
			after: utc(2026, 3, 10, 8, 45), want: utc(2026, 3, 10, 9, 0),
		},
		{
			name: "sub-second after", expr: "*/15 * * * *",
			after: utc(2026, 3, 10, 8, 44).Add(500 * time.Millisecond), want: utc(2026, 3, 10, 8, 45),
		},
		{
			name: "step list", expr: "*/15 * * * *",
			after: utc(2026, 3, 10, 8, 46), want: utc(2026, 3, 10, 9, 0),
		},
		{
			name: "daily at midnight rolls the day", expr: "0 0 * * *",
			after: utc(2026, 3, 10, 0, 0), want: utc(2026, 3, 11, 0, 0),
		},
		{
			name: "hour list picks the next one", expr: "0 6,18 * * *",
			after: utc(2026, 3, 10, 7, 0), want: utc(2026, 3, 10, 18, 0),
		},
		{
			name: "hour list wraps to tomorrow", expr: "0 6,18 * * *",
			after: utc(2026, 3, 10, 19, 0), want: utc(2026, 3, 11, 6, 0),
		},
		{
			name: "weekday window skips the weekend", expr: "0 9 * * 1-5",
			after: utc(2026, 3, 13, 9, 30), want: utc(2026, 3, 16, 9, 0), // Fri -> Mon
		},
		{
			name: "sunday is 0", expr: "0 12 * * 0",
			after: utc(2026, 3, 10, 0, 0), want: utc(2026, 3, 15, 12, 0),
		},
		{
			name: "sunday is also 7", expr: "0 12 * * 7",
			after: utc(2026, 3, 10, 0, 0), want: utc(2026, 3, 15, 12, 0),
		},
		{
			name: "monthly crosses a short February", expr: "0 0 30 * *",
			after: utc(2026, 1, 31, 12, 0), want: utc(2026, 3, 30, 0, 0),
		},
		{
			name: "quarterly months", expr: "0 0 1 */3 *",
			after: utc(2026, 1, 2, 0, 0), want: utc(2026, 4, 1, 0, 0),
		},
		{
			name: "dom-or-dow rule: 13th OR Friday", expr: "0 12 13 * 5",
			after: utc(2026, 2, 1, 0, 0), want: utc(2026, 2, 6, 12, 0), // Friday before the 13th
		},
		{
			name: "dom-only when dow is star", expr: "0 12 13 * *",
			after: utc(2026, 2, 1, 0, 0), want: utc(2026, 2, 13, 12, 0),
		},
		{
			name: "range step", expr: "0-30/10 * * * *",
			after: utc(2026, 3, 10, 8, 11), want: utc(2026, 3, 10, 8, 20),
		},
		{
			name: "leap day", expr: "0 0 29 2 *",
			after: utc(2026, 3, 1, 0, 0), want: utc(2028, 2, 29, 0, 0),
		},
		{
			name: "year boundary", expr: "5 4 1 1 *",
			after: utc(2026, 3, 10, 8, 0), want: utc(2027, 1, 1, 4, 5),
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Parse(tt.expr)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tt.expr, err)
			}
			if got := c.Next(tt.after); !got.Equal(tt.want) {
				t.Errorf("Next(%s) = %s, want %s", tt.after.Format(time.RFC3339),
					got.Format(time.RFC3339), tt.want.Format(time.RFC3339))
			}
		})
	}
}

// TestCronNextImpossibleExpressionReturnsZero pins the documented answer for
// an expression that matches nothing: the zero time, which Create/Update
// refuse. Feb 30 never comes.
func TestCronNextImpossibleExpressionReturnsZero(t *testing.T) {
	c, err := Parse("0 0 30 2 *")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got := c.Next(utc(2026, 1, 1, 0, 0)); !got.IsZero() {
		t.Errorf("Next = %s, want the zero time for an impossible expression", got)
	}
}

// TestCronNextAlwaysMatches scans a chain of fires across two years for a
// handful of expressions: every answer is strictly later, minute-aligned, and
// re-matches the mask it came from. A Next that drifts a minute, or lands on a
// Saturday for 1-5, fails here rather than in somebody's nightly scan.
func TestCronNextAlwaysMatches(t *testing.T) {
	for _, expr := range []string{
		"* * * * *", "*/7 * * * *", "3 */4 * * *", "0 0 * * 6", "15 2 29 2 *",
		"0 9-17/2 * * 1-5", "0 0 1,15 * *", "59 23 31 12 *",
	} {
		c, err := Parse(expr)
		if err != nil {
			t.Fatalf("Parse(%q): %v", expr, err)
		}
		at := utc(2025, 12, 1, 0, 0)
		for i := 0; i < 400; i++ {
			next := c.Next(at)
			if next.IsZero() {
				t.Fatalf("%q: Next went zero after %s", expr, at.Format(time.RFC3339))
			}
			if !next.After(at) {
				t.Fatalf("%q: Next(%s) = %s, want strictly later", expr, at.Format(time.RFC3339), next)
			}
			if next.Second() != 0 || next.Nanosecond() != 0 {
				t.Fatalf("%q: Next(%s) = %s, want a whole minute", expr, at, next)
			}
			if next.Location() != time.UTC {
				t.Fatalf("%q: Next returned %s in %s, want UTC", expr, next, next.Location())
			}
			if !c.Matches(next) {
				t.Fatalf("%q: Next(%s) = %s does not match the expression", expr, at, next)
			}
			at = next
		}
	}
}

// TestCronNextIsMonotonic checks the other half of the
// scheduler's assumption: the next answer is the same whether it is computed
// from the previous fire or from any instant inside that fire's own minute.
func TestCronNextIsMonotonic(t *testing.T) {
	c, err := Parse("*/20 * * * *")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	from := utc(2026, 6, 30, 23, 51)
	first := c.Next(from)
	if want := utc(2026, 7, 1, 0, 0); !first.Equal(want) {
		t.Fatalf("Next(%s) = %s, want %s", from, first, want)
	}
	// Any instant inside the fired minute yields the same next fire.
	for _, skew := range []time.Duration{0, time.Second, 59 * time.Second, 59*time.Second + 999*time.Millisecond} {
		if got := c.Next(first.Add(skew)); !got.Equal(first.Add(20 * time.Minute)) {
			t.Errorf("Next(%s) = %s, want %s", first.Add(skew), got, first.Add(20*time.Minute))
		}
	}
}
