package multicasupervisor

import (
	"sync"
	"time"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) NewTimer(duration time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	timer := &fakeTimer{
		clock:  c,
		at:     c.now.Add(duration),
		ch:     make(chan time.Time, 1),
		active: true,
	}
	c.timers = append(c.timers, timer)
	if duration <= 0 {
		timer.active = false
		timer.ch <- c.now
	}
	return timer
}

func (c *fakeClock) Advance(duration time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(duration)
	for _, timer := range c.timers {
		if timer.active && !timer.at.After(c.now) {
			timer.active = false
			timer.ch <- c.now
		}
	}
	c.mu.Unlock()
}

type fakeTimer struct {
	clock  *fakeClock
	at     time.Time
	ch     chan time.Time
	active bool
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	wasActive := t.active
	t.active = false
	return wasActive
}
