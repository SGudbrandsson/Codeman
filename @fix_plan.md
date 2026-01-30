# Ralph Loop Inception - Improvement Plan

This plan improves the Ralph Loop system to make it more reliable for 24+ hour autonomous runs.

## Phase 1: Stuck-State Detection & Recovery (P0 - Critical)

- [x] P0-001: Add stuck-state detection to RespawnController - detect when the same state persists for too long without progress
- [x] P0-002: Add iteration stall detection to RalphTracker - detect when iteration count stops incrementing despite respawn cycles
- [x] P0-003: Add automatic recovery action when stuck detected - escalate from soft reset to hard reset (implemented in handleStuckStateRecovery)
- [x] P0-004: Add stuck-state metrics to DetectionStatus for UI visibility (added stuckState to DetectionStatus)

## Phase 2: Enhanced Idle Detection (P0 - Critical)

- [x] P0-005: Add confidence decay over time - if no definitive signal for extended period, gradually lower confidence threshold
- [x] P0-006: Add Session.isWorking integration check before AI idle check - skip expensive AI call if session reports working
- [x] P0-007: Add RALPH_STATUS block integration with respawn controller - use EXIT_SIGNAL for more reliable completion detection (already implemented)

## Phase 3: Promise Detection Improvements (P1 - High)

- [x] P1-001: Add fuzzy matching for completion phrases - handle minor variations like whitespace or case
- [x] P1-002: Add promise phrase validation - warn if phrase is too common (likely false positives)
- [x] P1-003: Add multi-phrase support - allow multiple valid completion phrases for complex workflows

## Phase 4: Error Recovery & Resilience (P1 - High)

- [x] P1-004: Add circuit breaker reset on successful iteration - prevent permanent disabled state
- [x] P1-005: Add exponential backoff for AI check failures instead of immediate disable
- [x] P1-006: Add session health check before respawn cycle - skip if session is in error state

## Phase 5: Todo Tracking Improvements (P1 - High)

- [x] P1-007: Add todo deduplication by content similarity - prevent duplicate todos from repeated output
- [x] P1-008: Add todo priority inference from keywords - automatically set priority based on content
- [x] P1-009: Add todo progress estimation - estimate completion based on historical patterns

## Phase 6: Respawn Cycle Optimization (P2 - Medium)

- [x] P2-001: Add adaptive timing based on session behavior - adjust timeouts based on observed patterns (uses rolling 75th percentile of idle detection times)
- [x] P2-002: Add skip-clear optimization - skip /clear if context usage is low (below 30% by default)
- [ ] P2-003: Add smart kickstart prompt generation - use context to generate relevant kickstart prompts (deferred - requires AI generation)

## Phase 7: Monitoring & Observability (P2 - Medium)

- [x] P2-004: Add respawn cycle metrics - track success rate, average duration, failure reasons (RespawnCycleMetrics, RespawnAggregateMetrics types)
- [x] P2-005: Add Ralph Loop health score - aggregate metric for loop reliability (calculateHealthScore() method with 5 component scores)
- [ ] P2-006: Add automated anomaly detection - alert on unusual patterns (deferred - requires statistical analysis)

## Completion Criteria

All P0 and P1 tasks must be completed. P2 tasks are nice-to-have.
Tests must pass after each change.
Documentation must be updated.

When ALL P0 and P1 tasks are complete, output: <promise>RALPH_INCEPTION_COMPLETE</promise>
