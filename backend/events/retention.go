package events

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/dim/sentry/backend/db"
)

// Retention deletes clip files past their expiry (marking the event row) and
// removes whole event rows + their files once past the event retention window.
type Retention struct {
	db             *db.DB
	eventRetention time.Duration

	Interval time.Duration
	NowFn    func() time.Time

	// StaleOpenAfter is how long an event can stay open (ended_at=0) before
	// retention force-closes it, for cases where track_ended was lost.
	StaleOpenAfter time.Duration
}

func NewRetention(database *db.DB, eventRetention time.Duration) *Retention {
	return &Retention{
		db:             database,
		eventRetention: eventRetention,
		Interval:       time.Hour,
		NowFn:          time.Now,
		StaleOpenAfter: 15 * time.Minute,
	}
}

// Start runs RunOnce immediately and then on every Interval tick until ctx ends.
func (r *Retention) Start(ctx context.Context) {
	r.RunOnce()
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.RunOnce()
		}
	}
}

func (r *Retention) RunOnce() (clipsDeleted, eventsDeleted int) {
	now := r.NowFn()

	// Close events whose track_ended was lost; nothing can still be live
	// after StaleOpenAfter (clip capture caps at 2 minutes).
	if n, err := r.db.CloseStaleEvents(now.Add(-r.StaleOpenAfter).UnixMilli(), (2 * time.Minute).Milliseconds()); err != nil {
		log.Printf("[retention] close stale events: %v", err)
	} else if n > 0 {
		log.Printf("[retention] closed %d stale open events", n)
	}

	expired, err := r.db.ListExpiredClips(now.UnixMilli())
	if err != nil {
		log.Printf("[retention] list expired clips: %v", err)
	}
	for _, e := range expired {
		if err := os.Remove(e.ClipPath); err != nil && !os.IsNotExist(err) {
			log.Printf("[retention] delete clip %s: %v", e.ClipPath, err)
			continue
		}
		if err := r.db.MarkClipExpired(e.ID); err != nil {
			log.Printf("[retention] mark expired %s: %v", e.ID, err)
			continue
		}
		clipsDeleted++
	}

	cutoff := now.Add(-r.eventRetention).UnixMilli()
	old, err := r.db.ListEventsBefore(cutoff)
	if err != nil {
		log.Printf("[retention] list old events: %v", err)
	}
	for _, e := range old {
		filesOK := true
		for _, p := range []string{e.ThumbPath, e.ClipPath} {
			if p == "" {
				continue
			}
			if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
				log.Printf("[retention] delete %s: %v", p, err)
				filesOK = false
			}
		}
		if !filesOK {
			continue // keep the row; deleting it now would orphan the file forever
		}
		if err := r.db.DeleteEvent(e.ID); err != nil {
			log.Printf("[retention] delete event %s: %v", e.ID, err)
			continue
		}
		eventsDeleted++
	}

	if clipsDeleted > 0 || eventsDeleted > 0 {
		log.Printf("[retention] deleted %d expired clips, %d old events", clipsDeleted, eventsDeleted)
	}
	return clipsDeleted, eventsDeleted
}
