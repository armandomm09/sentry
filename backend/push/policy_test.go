package push

import (
	"testing"
	"time"
)

func TestPolicyAllows(t *testing.T) {
	loc := time.FixedZone("test", -6*3600) // UTC-6, DST-free
	// 2026-07-20 12:00:00 local
	noon := time.Date(2026, 7, 20, 12, 0, 0, 0, loc).UnixMilli()
	hour := int64(3600 * 1000)

	cases := []struct {
		name        string
		mode        string
		quietHours  float64
		lastSeen    int64
		hasLastSeen bool
		want        bool
	}{
		{"every always fires", ModeEvery, 4, noon - hour, true, true},
		{"unrecognized mode behaves as every", "bogus", 4, noon - hour, true, true},
		{"quiet: first sighting ever fires", ModeQuietPeriod, 4, 0, false, true},
		{"quiet: seen 1h ago inside 4h window suppresses", ModeQuietPeriod, 4, noon - hour, true, false},
		{"quiet: seen exactly 4h ago suppresses (strictly more than)", ModeQuietPeriod, 4, noon - 4*hour, true, false},
		{"quiet: seen 5h ago fires", ModeQuietPeriod, 4, noon - 5*hour, true, true},
		{"quiet: fractional hours honored", ModeQuietPeriod, 0.5, noon - hour, true, true},
		{"first_of_day: first sighting ever fires", ModeFirstOfDay, 0, 0, false, true},
		{"first_of_day: already seen today suppresses", ModeFirstOfDay, 0, noon - 2*hour, true, false},
		{"first_of_day: seen yesterday 23:59 local fires", ModeFirstOfDay, 0,
			time.Date(2026, 7, 19, 23, 59, 0, 0, loc).UnixMilli(), true, true},
		{"first_of_day: seen today 00:00 local suppresses", ModeFirstOfDay, 0,
			time.Date(2026, 7, 20, 0, 0, 0, 0, loc).UnixMilli(), true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := policyAllows(tc.mode, tc.quietHours, tc.lastSeen, tc.hasLastSeen, noon, loc)
			if got != tc.want {
				t.Fatalf("policyAllows = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestValidMode(t *testing.T) {
	for _, m := range []string{ModeEvery, ModeQuietPeriod, ModeFirstOfDay} {
		if !ValidMode(m) {
			t.Fatalf("%q should be valid", m)
		}
	}
	for _, m := range []string{"", "bogus", "EVERY"} {
		if ValidMode(m) {
			t.Fatalf("%q should be invalid", m)
		}
	}
}
