package push

import "time"

// Notification policy modes (spec § 4). Stored per subscription, independently
// for known and unknown people.
const (
	ModeEvery       = "every"        // every event (default)
	ModeQuietPeriod = "quiet_period" // only if not seen for more than quietHours
	ModeFirstOfDay  = "first_of_day" // first event per local calendar day
)

// ValidMode reports whether m is a recognized policy mode. Used by the
// registration handler to reject bad input; the evaluator itself treats
// unrecognized modes as ModeEvery so a corrupt row can never mute alerts.
func ValidMode(m string) bool {
	return m == ModeEvery || m == ModeQuietPeriod || m == ModeFirstOfDay
}

// policyAllows decides whether one subscription's mode permits notifying about
// an event that started at startedAtMs. lastSeenMs is the previous sighting of
// the same person (any camera) or, for unknowns, the same camera; it is
// ignored when hasLastSeen is false — a first-ever sighting always notifies.
func policyAllows(mode string, quietHours float64, lastSeenMs int64, hasLastSeen bool, startedAtMs int64, loc *time.Location) bool {
	switch mode {
	case ModeQuietPeriod:
		if !hasLastSeen {
			return true
		}
		quiet := time.Duration(quietHours * float64(time.Hour))
		return time.UnixMilli(startedAtMs).Sub(time.UnixMilli(lastSeenMs)) > quiet
	case ModeFirstOfDay:
		if !hasLastSeen {
			return true
		}
		t := time.UnixMilli(startedAtMs).In(loc)
		dayStart := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		return lastSeenMs < dayStart.UnixMilli()
	default: // ModeEvery and anything unrecognized
		return true
	}
}
