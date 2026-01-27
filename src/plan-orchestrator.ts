/**
 * @fileoverview Enhanced plan generation using subagent orchestration.
 *
 * This module implements a multi-phase plan generation system that leverages
 * Claude's subagent capabilities for parallel analysis and verification.
 *
 * Architecture:
 * 1. Phase 1 (Parallel Analysis): Spawn 4 specialist subagents simultaneously
 * 2. Phase 2 (Synthesis): Merge and deduplicate outputs
 * 3. Phase 3 (Verification): Final review and priority assignment
 *
 * @see https://code.claude.com/docs/en/sub-agents
 * @module plan-orchestrator
 */

import { Session } from './session.js';
import { ScreenManager } from './screen-manager.js';

// ============================================================================
// Types
// ============================================================================

/** Development phase in TDD cycle */
export type PlanPhase = 'setup' | 'test' | 'impl' | 'verify' | 'review';

/** Task execution status */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

/**
 * Enhanced plan item with verification, dependencies, and execution tracking.
 * Supports TDD workflow, failure tracking, and plan versioning.
 */
export interface PlanItem {
  /** Unique identifier (e.g., "P0-001") */
  id?: string;
  /** Task description */
  content: string;
  /** Criticality level */
  priority: 'P0' | 'P1' | 'P2' | null;
  /** Which subagent generated this item */
  source?: string;
  /** Why this task is needed */
  rationale?: string;
  /** Legacy numeric phase (1-4) */
  phase?: number;

  // === NEW: Verification ===
  /** How to know it's done (e.g., "npm test passes", "endpoint returns 200") */
  verificationCriteria?: string;
  /** Command to run for verification (e.g., "npm test -- --grep='auth'") */
  testCommand?: string;

  // === NEW: Dependencies ===
  /** IDs of tasks that must complete first */
  dependencies?: string[];

  // === NEW: Execution tracking ===
  /** Current execution status */
  status?: PlanTaskStatus;
  /** How many times attempted */
  attempts?: number;
  /** Most recent failure reason */
  lastError?: string;
  /** Timestamp of completion */
  completedAt?: number;

  // === NEW: Metadata ===
  /** Estimated complexity */
  complexity?: 'low' | 'medium' | 'high';
  /** How to undo if needed */
  rollbackStrategy?: string;
  /** Plan version this belongs to */
  version?: number;
  /** TDD phase category */
  tddPhase?: PlanPhase;
  /** ID of paired test/impl task */
  pairedWith?: string;
  /** Checklist items for review tasks (tddPhase: 'review') */
  reviewChecklist?: string[];
}

export interface SubagentResult {
  agentType: 'requirements' | 'architecture' | 'testing' | 'risks';
  items: Array<{
    category: string;
    content: string;
    rationale?: string;
  }>;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface SynthesisResult {
  items: PlanItem[];
  stats: {
    totalFromSubagents: number;
    afterDedup: number;
    sourceBreakdown: Record<string, number>;
  };
}

export interface VerificationResult {
  validatedPlan: PlanItem[];
  gaps: string[];
  warnings: string[];
  qualityScore: number;
}

export interface DetailedPlanResult {
  success: boolean;
  items?: PlanItem[];
  costUsd?: number;
  metadata?: {
    subagentResults: SubagentResult[];
    synthesisStats: SynthesisResult['stats'];
    verificationGaps: string[];
    verificationWarnings: string[];
    qualityScore: number;
    totalDurationMs: number;
  };
  error?: string;
}

export type ProgressCallback = (phase: string, detail: string) => void;

// ============================================================================
// Constants
// ============================================================================

const SUBAGENT_TIMEOUT_MS = 45000; // 45 seconds per subagent
const VERIFICATION_TIMEOUT_MS = 60000; // 60 seconds for verification
const MODEL_ANALYSIS = 'haiku'; // Fast model for parallel analysis
const MODEL_VERIFICATION = 'sonnet'; // Better reasoning for verification

// ============================================================================
// Subagent Prompts
// ============================================================================

const REQUIREMENTS_ANALYST_PROMPT = `You are a Requirements Analyst specializing in extracting all requirements from task descriptions.

## YOUR TASK
Analyze the following task and extract ALL requirements (explicit and implicit):

## TASK DESCRIPTION
{TASK}

## INSTRUCTIONS
1. Identify explicit requirements (directly stated)
2. Infer implicit requirements (unstated but necessary)
3. Note any assumptions that should be validated
4. Consider non-functional requirements (performance, security, usability)

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {"category": "functional|non-functional|constraint|assumption", "content": "requirement description", "rationale": "why this is needed"}
]

Generate 8-15 items. Be thorough - missing requirements cause project failures.`;

const ARCHITECTURE_PLANNER_PROMPT = `You are an Architecture Planner specializing in software component design.

## YOUR TASK
Design the architecture for implementing this task:

## TASK DESCRIPTION
{TASK}

## INSTRUCTIONS
1. Identify all modules/components needed
2. Define interfaces between components
3. Specify data structures and types
4. Note configuration and setup requirements
5. Consider separation of concerns

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {"category": "module|interface|type|config|infrastructure", "content": "component description", "rationale": "why needed"}
]

Generate 10-20 items. Think about the complete system architecture.`;

const TESTING_SPECIALIST_PROMPT = `You are a TDD Specialist designing a comprehensive test strategy with verification criteria.

## YOUR TASK
Design test coverage for this task:

## TASK DESCRIPTION
{TASK}

## INSTRUCTIONS
Following Test-Driven Development methodology:
1. Design unit tests for each component
2. Plan integration tests for feature interactions
3. Identify edge cases and boundary conditions
4. Consider error scenarios and failure modes
5. For each test, specify HOW to verify it passes

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {
    "category": "unit|integration|edge-case|error|verification",
    "content": "Write test for user login with valid credentials",
    "rationale": "Validates happy path authentication flow",
    "verificationCriteria": "Test passes: POST /auth/login returns 200 with JWT token",
    "testCommand": "npm test -- --grep='login valid'",
    "pairedImpl": "Implement login endpoint handler"
  }
]

CRITICAL: Every test item MUST include:
- verificationCriteria: How to know the test passes (observable outcome)
- testCommand: The actual command to run (npm test, pytest, etc.)
- pairedImpl: The implementation step this test validates

Generate 12-25 items. Tests should be written BEFORE implementation.`;

const RISK_ANALYST_PROMPT = `You are a Risk Analyst identifying potential issues and blockers.

## YOUR TASK
Identify risks and edge cases for this task:

## TASK DESCRIPTION
{TASK}

## INSTRUCTIONS
1. Identify potential failure points
2. Note edge cases that could cause bugs
3. Consider security vulnerabilities
4. Flag performance concerns
5. Identify dependencies that could block progress

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {"category": "failure|edge-case|security|performance|dependency", "content": "risk description", "rationale": "mitigation approach"}
]

Generate 8-15 items. Being proactive about risks prevents surprises.`;

// @ts-expect-error Reserved for future use - code review specialist prompt
const CODE_REVIEWER_PROMPT = `You are a Code Review Specialist designing post-implementation review tasks.

## YOUR TASK
Design code review steps for implementations in this task:

## TASK DESCRIPTION
{TASK}

## INSTRUCTIONS
For each implementation identified, create a review task that checks:
1. **Best Practices**: Language-specific conventions and idioms
2. **Security**: OWASP top 10, input validation, authentication
3. **Performance**: Time complexity, memory usage, N+1 queries
4. **Error Handling**: Edge cases covered, meaningful error messages
5. **Code Quality**: DRY, SOLID principles, readability
6. **Type Safety**: Proper typing, no implicit any, null checks

## REVIEW TASK GUIDELINES
- Review tasks run AFTER implementation, BEFORE merge
- Each review should be specific and actionable
- Include what to look for and how to verify
- Reference language-specific linting tools where applicable

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {
    "category": "security|performance|quality|error-handling|best-practices|type-safety",
    "content": "Review authentication handler for XSS vulnerabilities",
    "rationale": "User input flows through auth - must sanitize",
    "verificationCriteria": "No unescaped user input, all inputs validated",
    "reviewChecklist": ["Check input sanitization", "Verify CSRF tokens", "Review session handling"],
    "implToReview": "Implement authentication handler"
  }
]

Generate 5-10 review tasks. Code review catches bugs that tests miss.`;

const VERIFICATION_PROMPT = `You are a Plan Verification Expert reviewing an implementation plan for completeness and quality.

## ORIGINAL TASK
{TASK}

## SYNTHESIZED PLAN (from multiple analysis subagents)
{PLAN}

## YOUR MISSION
Review and enhance this plan:
1. Assign priorities (P0=critical/blocking, P1=required, P2=enhancement)
2. Add verification criteria to EVERY task (how to know it's done)
3. Pair test tasks with implementation tasks (TDD cycle)
4. Add dependencies where one task blocks another
5. Identify gaps and calculate quality score

## PRIORITY GUIDELINES
- P0: Foundation tasks, type definitions, project setup, blocking dependencies
- P1: Core implementation, tests, main features, error handling
- P2: Polish, optimization, documentation, nice-to-have features

## TDD + REVIEW CYCLE RULES
The complete cycle is: test → impl → review
- Every implementation task should have a corresponding test task AND review task
- Test task comes BEFORE its paired implementation task
- Review task comes AFTER the implementation it reviews
- Use "pairedWith" to link test ↔ implementation ↔ review
- Verification criteria should reference test results where applicable

## REVIEW TASK REQUIREMENTS
After EVERY implementation task, add a review task that checks:
- Best practices for the language/framework
- Security vulnerabilities (OWASP top 10)
- Performance concerns
- Error handling completeness
- Code quality (DRY, SOLID, readability)

## OUTPUT FORMAT
Return ONLY a JSON object:
{
  "validatedPlan": [
    {
      "id": "P0-001",
      "content": "Write failing test for user authentication",
      "priority": "P0",
      "tddPhase": "test",
      "verificationCriteria": "Test file exists, test fails with 'not implemented'",
      "testCommand": "npm test -- --grep='auth'",
      "pairedWith": "P0-002",
      "dependencies": [],
      "complexity": "low"
    },
    {
      "id": "P0-002",
      "content": "Implement user authentication handler",
      "priority": "P0",
      "tddPhase": "impl",
      "verificationCriteria": "npm test -- --grep='auth' passes",
      "pairedWith": "P0-001",
      "dependencies": ["P0-001"],
      "complexity": "medium"
    },
    {
      "id": "P0-003",
      "content": "Review auth implementation for security and best practices",
      "priority": "P0",
      "tddPhase": "review",
      "verificationCriteria": "No security issues found, follows TypeScript best practices",
      "reviewChecklist": ["Input validation", "XSS prevention", "Session security", "Error handling"],
      "pairedWith": "P0-002",
      "dependencies": ["P0-002"],
      "complexity": "low"
    }
  ],
  "gaps": ["missing requirement 1", "missing test coverage for X"],
  "warnings": ["consider Y before Z", "potential issue with..."],
  "qualityScore": 0.85
}

CRITICAL REQUIREMENTS:
1. EVERY task MUST have verificationCriteria (how to verify completion)
2. Implementation tasks MUST have a paired test task AND a review task
3. Review tasks MUST have a reviewChecklist with specific items to check
4. Dependencies must form a valid DAG (no cycles)
5. Use sequential IDs: P0-001, P0-002, P0-003, P1-001, etc.

Be critical but constructive. A thorough review catches issues that tests miss.`;

// ============================================================================
// Main Orchestrator Class
// ============================================================================

export class PlanOrchestrator {
  private screenManager: ScreenManager;
  private workingDir: string;

  constructor(screenManager: ScreenManager, workingDir: string = process.cwd()) {
    this.screenManager = screenManager;
    this.workingDir = workingDir;
  }

  /**
   * Generate a detailed implementation plan using subagent orchestration.
   *
   * Phases:
   * 1. Spawn 4 specialist subagents in parallel for analysis
   * 2. Synthesize their outputs into a unified plan
   * 3. Run verification subagent for quality assurance
   */
  async generateDetailedPlan(
    taskDescription: string,
    onProgress?: ProgressCallback
  ): Promise<DetailedPlanResult> {
    const startTime = Date.now();
    let totalCost = 0;

    try {
      // Phase 1: Parallel Analysis
      onProgress?.('parallel-analysis', 'Spawning analysis subagents...');
      const subagentResults = await this.runParallelAnalysis(taskDescription, onProgress);

      totalCost += subagentResults.reduce((sum, r) => sum + (r.success ? 0.002 : 0), 0); // Estimate

      // Check if we got enough results to continue
      const successfulResults = subagentResults.filter(r => r.success);
      if (successfulResults.length < 2) {
        return {
          success: false,
          error: `Only ${successfulResults.length} subagents succeeded. Falling back to standard generation.`,
        };
      }

      // Phase 2: Synthesis
      onProgress?.('synthesis', 'Synthesizing subagent outputs...');
      const synthesisResult = this.synthesizeResults(subagentResults);

      // Phase 3: Verification
      onProgress?.('verification', 'Running verification subagent...');
      const verificationResult = await this.runVerification(
        taskDescription,
        synthesisResult.items,
        onProgress
      );

      totalCost += 0.01; // Verification cost estimate

      // Phase 4: Ensure all impl tasks have review tasks
      onProgress?.('review-injection', 'Ensuring review tasks for all implementations...');
      const planWithReviews = this.ensureReviewTasks(verificationResult.validatedPlan);
      const reviewsAdded = planWithReviews.length - verificationResult.validatedPlan.length;
      if (reviewsAdded > 0) {
        onProgress?.('review-injection', `Added ${reviewsAdded} auto-review task(s)`);
      }

      const totalDurationMs = Date.now() - startTime;

      return {
        success: true,
        items: planWithReviews,
        costUsd: totalCost,
        metadata: {
          subagentResults,
          synthesisStats: synthesisResult.stats,
          verificationGaps: verificationResult.gaps,
          verificationWarnings: verificationResult.warnings,
          qualityScore: verificationResult.qualityScore,
          totalDurationMs,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Run all 4 analysis subagents in parallel.
   */
  private async runParallelAnalysis(
    taskDescription: string,
    onProgress?: ProgressCallback
  ): Promise<SubagentResult[]> {
    const subagents: Array<{
      type: SubagentResult['agentType'];
      prompt: string;
    }> = [
      { type: 'requirements', prompt: REQUIREMENTS_ANALYST_PROMPT.replace('{TASK}', taskDescription) },
      { type: 'architecture', prompt: ARCHITECTURE_PLANNER_PROMPT.replace('{TASK}', taskDescription) },
      { type: 'testing', prompt: TESTING_SPECIALIST_PROMPT.replace('{TASK}', taskDescription) },
      { type: 'risks', prompt: RISK_ANALYST_PROMPT.replace('{TASK}', taskDescription) },
    ];

    // Run all subagents in parallel
    const promises = subagents.map(({ type, prompt }) =>
      this.runSubagent(type, prompt, onProgress)
    );

    return Promise.all(promises);
  }

  /**
   * Run a single analysis subagent.
   */
  private async runSubagent(
    agentType: SubagentResult['agentType'],
    prompt: string,
    onProgress?: ProgressCallback
  ): Promise<SubagentResult> {
    const startTime = Date.now();

    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    try {
      onProgress?.('subagent', `Running ${agentType} analysis...`);

      const { result } = await Promise.race([
        session.runPrompt(prompt, { model: MODEL_ANALYSIS }),
        this.timeout(SUBAGENT_TIMEOUT_MS),
      ]);

      // Parse JSON from result
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return {
          agentType,
          items: [],
          success: false,
          error: 'No JSON array found in response',
          durationMs: Date.now() - startTime,
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return {
          agentType,
          items: [],
          success: false,
          error: 'Response is not an array',
          durationMs: Date.now() - startTime,
        };
      }

      const items = parsed.map((item: unknown) => {
        if (typeof item !== 'object' || item === null) {
          return { category: 'unknown', content: String(item) };
        }
        const obj = item as Record<string, unknown>;
        return {
          category: String(obj.category || 'general'),
          content: String(obj.content || ''),
          rationale: obj.rationale ? String(obj.rationale) : undefined,
        };
      });

      onProgress?.('subagent', `${agentType} complete (${items.length} items)`);

      return {
        agentType,
        items,
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        agentType,
        items: [],
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    } finally {
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Synthesize results from all subagents into a unified plan.
   */
  private synthesizeResults(subagentResults: SubagentResult[]): SynthesisResult {
    const allItems: PlanItem[] = [];
    const sourceBreakdown: Record<string, number> = {};

    // Collect items from all successful subagents
    for (const result of subagentResults) {
      if (!result.success) continue;

      sourceBreakdown[result.agentType] = result.items.length;

      for (const item of result.items) {
        allItems.push({
          content: item.content,
          priority: null, // Will be assigned by verification
          source: result.agentType,
          rationale: item.rationale,
          phase: this.determinePhase(item.content, result.agentType),
        });
      }
    }

    const totalFromSubagents = allItems.length;

    // Deduplicate similar items
    const deduped = this.deduplicateItems(allItems);

    // Sort by phase
    deduped.sort((a, b) => (a.phase || 4) - (b.phase || 4));

    return {
      items: deduped,
      stats: {
        totalFromSubagents,
        afterDedup: deduped.length,
        sourceBreakdown,
      },
    };
  }

  /**
   * Determine the implementation phase for an item based on keywords.
   */
  private determinePhase(content: string, source: string): number {
    const lower = content.toLowerCase();

    // Phase 1: Foundation
    if (
      lower.includes('create') && (lower.includes('project') || lower.includes('directory')) ||
      lower.includes('setup') ||
      lower.includes('initialize') ||
      lower.includes('configure') ||
      lower.includes('install') ||
      lower.includes('define') && (lower.includes('interface') || lower.includes('type'))
    ) {
      return 1;
    }

    // Phase 2: Tests (before implementation)
    if (
      source === 'testing' ||
      lower.includes('test') ||
      lower.includes('verify') && !lower.includes('final')
    ) {
      return 2;
    }

    // Phase 3: Implementation
    if (
      lower.includes('implement') ||
      lower.includes('build') ||
      lower.includes('add') ||
      lower.includes('create') && !lower.includes('test')
    ) {
      return 3;
    }

    // Phase 4: Integration & Verification
    if (
      lower.includes('integrate') ||
      lower.includes('connect') ||
      lower.includes('final') ||
      lower.includes('run') && lower.includes('suite')
    ) {
      return 4;
    }

    return 3; // Default to implementation phase
  }

  /**
   * Deduplicate similar items using fuzzy matching.
   */
  private deduplicateItems(items: PlanItem[]): PlanItem[] {
    const result: PlanItem[] = [];

    for (const item of items) {
      const isDuplicate = result.some(existing =>
        this.isSimilar(existing.content, item.content)
      );

      if (!isDuplicate) {
        result.push(item);
      }
    }

    return result;
  }

  /**
   * Check if two strings are similar (>60% word overlap).
   */
  private isSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let overlap = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) overlap++;
    }

    const similarity = overlap / Math.min(wordsA.size, wordsB.size);
    return similarity > 0.6;
  }

  /**
   * Run the verification subagent to validate and prioritize the plan.
   */
  private async runVerification(
    taskDescription: string,
    synthesizedItems: PlanItem[],
    onProgress?: ProgressCallback
  ): Promise<VerificationResult> {
    const session = new Session({
      workingDir: this.workingDir,
      screenManager: this.screenManager,
      useScreen: false,
      mode: 'claude',
    });

    try {
      // Format plan for verification
      const planText = synthesizedItems
        .map((item, idx) => `${idx + 1}. [Phase ${item.phase}] ${item.content}`)
        .join('\n');

      const prompt = VERIFICATION_PROMPT
        .replace('{TASK}', taskDescription)
        .replace('{PLAN}', planText);

      onProgress?.('verification', 'Validating plan quality...');

      const { result } = await Promise.race([
        session.runPrompt(prompt, { model: MODEL_VERIFICATION }),
        this.timeout(VERIFICATION_TIMEOUT_MS),
      ]);

      // Parse JSON from result
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // Fallback: return items with default priorities
        return this.fallbackVerification(synthesizedItems);
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const validatedPlan: PlanItem[] = (parsed.validatedPlan || []).map((item: unknown, idx: number) => {
        if (typeof item !== 'object' || item === null) {
          return { content: String(item), priority: 'P1' as const, id: `task-${idx}` };
        }
        const obj = item as Record<string, unknown>;
        let priority: PlanItem['priority'] = null;
        if (obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2') {
          priority = obj.priority;
        }

        // Parse TDD phase (now includes 'review')
        let tddPhase: PlanItem['tddPhase'];
        if (obj.tddPhase === 'setup' || obj.tddPhase === 'test' || obj.tddPhase === 'impl' || obj.tddPhase === 'verify' || obj.tddPhase === 'review') {
          tddPhase = obj.tddPhase;
        }

        // Parse complexity
        let complexity: PlanItem['complexity'];
        if (obj.complexity === 'low' || obj.complexity === 'medium' || obj.complexity === 'high') {
          complexity = obj.complexity;
        }

        // Parse reviewChecklist for review tasks
        let reviewChecklist: string[] | undefined;
        if (Array.isArray(obj.reviewChecklist)) {
          reviewChecklist = obj.reviewChecklist.map(String);
        }

        return {
          id: obj.id ? String(obj.id) : `task-${idx}`,
          content: String(obj.content || ''),
          priority,
          rationale: obj.rationale ? String(obj.rationale) : undefined,
          // Enhanced fields
          verificationCriteria: obj.verificationCriteria ? String(obj.verificationCriteria) : undefined,
          testCommand: obj.testCommand ? String(obj.testCommand) : undefined,
          tddPhase,
          pairedWith: obj.pairedWith ? String(obj.pairedWith) : undefined,
          dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : undefined,
          complexity,
          reviewChecklist,
          // Execution tracking defaults
          status: 'pending' as PlanTaskStatus,
          attempts: 0,
          version: 1,
        };
      });

      onProgress?.('verification', `Verification complete (quality: ${Math.round((parsed.qualityScore || 0.8) * 100)}%)`);

      return {
        validatedPlan,
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [],
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 0.8,
      };
    } catch (err) {
      console.error('[PlanOrchestrator] Verification failed:', err);
      return this.fallbackVerification(synthesizedItems);
    } finally {
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Fallback verification when the verification subagent fails.
   * Assigns heuristic priorities and adds basic verification criteria.
   */
  private fallbackVerification(items: PlanItem[]): VerificationResult {
    return {
      validatedPlan: items.map((item, idx) => ({
        ...item,
        id: item.id || `task-${idx}`,
        priority: item.phase === 1 ? 'P0' as const :
                  item.phase === 4 ? 'P2' as const : 'P1' as const,
        // Add default verification criteria based on content
        verificationCriteria: item.verificationCriteria ||
          this.inferVerificationCriteria(item.content),
        status: 'pending' as PlanTaskStatus,
        attempts: 0,
        version: 1,
      })),
      gaps: [],
      warnings: ['Verification subagent failed - using heuristic priorities'],
      qualityScore: 0.7,
    };
  }

  /**
   * Infer verification criteria from task content.
   */
  private inferVerificationCriteria(content: string): string {
    const lower = content.toLowerCase();

    if (lower.includes('test')) {
      return 'Tests pass without errors';
    }
    if (lower.includes('implement') || lower.includes('create') || lower.includes('add')) {
      return 'Code compiles, no type errors';
    }
    if (lower.includes('fix') || lower.includes('debug')) {
      return 'Issue is resolved, tests pass';
    }
    if (lower.includes('refactor')) {
      return 'Code refactored, all tests still pass';
    }
    if (lower.includes('document') || lower.includes('readme')) {
      return 'Documentation exists and is accurate';
    }
    if (lower.includes('config') || lower.includes('setup')) {
      return 'Configuration is valid, app starts';
    }

    return 'Task completed successfully';
  }

  /**
   * Create a timeout promise.
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
  }

  /**
   * Inject review tasks for any implementation tasks that don't have them.
   * Called as a post-processing step to ensure the test → impl → review cycle is complete.
   *
   * @param items - The validated plan items
   * @returns Updated plan items with review tasks added
   */
  ensureReviewTasks(items: PlanItem[]): PlanItem[] {
    const result: PlanItem[] = [];
    const implTasksNeedingReview: Map<string, PlanItem> = new Map();

    // First pass: identify impl tasks and their existing review pairs
    const reviewPairs = new Set<string>();
    for (const item of items) {
      if (item.tddPhase === 'review' && item.pairedWith) {
        reviewPairs.add(item.pairedWith);
      }
    }

    // Second pass: collect impl tasks without review pairs
    for (const item of items) {
      if (item.tddPhase === 'impl' && item.id && !reviewPairs.has(item.id)) {
        implTasksNeedingReview.set(item.id, item);
      }
    }

    // Third pass: build result with injected review tasks
    for (const item of items) {
      result.push(item);

      // If this is an impl task needing review, inject one after it
      if (item.id && implTasksNeedingReview.has(item.id)) {
        const reviewId = this.generateReviewId(item.id);
        const reviewTask = this.createReviewTask(item, reviewId);
        result.push(reviewTask);
      }
    }

    return result;
  }

  /**
   * Generate a review task ID from an impl task ID.
   * P0-002 → P0-002-R, task-5 → task-5-R
   */
  private generateReviewId(implId: string): string {
    return `${implId}-R`;
  }

  /**
   * Create a review task for an implementation task.
   */
  private createReviewTask(implTask: PlanItem, reviewId: string): PlanItem {
    const reviewChecklist = this.generateReviewChecklist(implTask.content);

    return {
      id: reviewId,
      content: `Review: ${implTask.content}`,
      priority: implTask.priority,
      tddPhase: 'review',
      pairedWith: implTask.id,
      dependencies: implTask.id ? [implTask.id] : [],
      verificationCriteria: 'Code review complete, no issues found or all issues addressed',
      reviewChecklist,
      status: 'pending',
      attempts: 0,
      version: implTask.version || 1,
      complexity: 'low',
    };
  }

  /**
   * Generate a review checklist based on the implementation task content.
   */
  private generateReviewChecklist(content: string): string[] {
    const lower = content.toLowerCase();
    const checklist: string[] = [];

    // Always include these
    checklist.push('Code compiles without errors');
    checklist.push('No TypeScript/linting warnings');

    // Security checks for certain patterns
    if (lower.includes('auth') || lower.includes('login') || lower.includes('password')) {
      checklist.push('Input validation implemented');
      checklist.push('No sensitive data in logs');
      checklist.push('Secure session handling');
    }

    if (lower.includes('api') || lower.includes('endpoint') || lower.includes('route')) {
      checklist.push('Request validation');
      checklist.push('Error responses do not leak internals');
      checklist.push('Rate limiting considered');
    }

    if (lower.includes('database') || lower.includes('query') || lower.includes('sql')) {
      checklist.push('Parameterized queries used');
      checklist.push('No N+1 query issues');
    }

    if (lower.includes('file') || lower.includes('path') || lower.includes('upload')) {
      checklist.push('Path traversal prevented');
      checklist.push('File type validation');
    }

    if (lower.includes('user') || lower.includes('input')) {
      checklist.push('XSS prevention');
      checklist.push('Input sanitization');
    }

    // Performance checks
    if (lower.includes('loop') || lower.includes('iterate') || lower.includes('array')) {
      checklist.push('Algorithm complexity is appropriate');
    }

    // Error handling
    checklist.push('Error cases handled');
    checklist.push('Meaningful error messages');

    // Code quality
    checklist.push('Code is readable and maintainable');
    checklist.push('No duplicate logic');

    return checklist;
  }
}
