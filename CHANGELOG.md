
Changelog
=========

# 0.2.x release

## v0.2.0

- Change: rename private api `listen` to `start` 
- Feature: new event `queue work` before worker start processing each job
- Feature: `add error` and `queue error` events now emits related job as second parameter
- Feature: `remove` can now remove job from any queue
- Enhance: prevent potential memory leak with `run` loop due to long promise chain

# 0.1.x release

## v0.1.6

- Enhance: stalled runQueue job are moved to workQueue on startup
- Enhance: update to verbose error message
- Enhance: reached 100% code coverage
- Enhance: mark api as public/private

## v0.1.5

- Fix: async worker api
- Fix: documentation update
- Enhance: better code coverage

## v0.1.4

- Fix: run loop to have correct blocking mechanism
- Enhance: refactor job remove into its own method
- Enhance: better code coverage with fake server response

## v0.1.3

- Major: initial public release
