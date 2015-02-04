
Changelog
=========


# 1.x release

## v1.0.1 (master)

- Fix: node v0.10 promise support

## v1.0.0

- Feature: job item now includes their current queue name for better tracking
- Enhance: remove obsolete code and tests
- Break: Redis client and add/remove events are removed


# 0.x release

## v0.2.0

- Feature: new event `queue work` before worker start processing each job
- Feature: `add error` and `queue error` events now emits related job as second parameter
- Feature: `remove` can now remove job from any queue
- Fix: prevent potential memory leak with `run` loop due to unresolved promise chain

## v0.1.6

- Fix: stalled runQueue job are moved to workQueue on startup
- Enhance: verbose error message
- Enhance: reached 100% code coverage

## v0.1.5

- Fix: async worker api

## v0.1.4

- Fix: run loop

## v0.1.3

- initial public release

