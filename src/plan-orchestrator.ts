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

export interface PlanItem {
  content: string;
  priority: 'P0' | 'P1' | 'P2' | null;
  source?: string;
  rationale?: string;
  phase?: number;
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

const TESTING_SPECIALIST_PROMPT = `You are a TDD Specialist designing a comprehensive test strategy.

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
5. Plan verification steps

## OUTPUT FORMAT
Return ONLY a JSON array:
[
  {"category": "unit|integration|edge-case|error|verification", "content": "test description", "rationale": "what it validates"}
]

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

const VERIFICATION_PROMPT = `You are a Plan Verification Expert reviewing an implementation plan for completeness and quality.

## ORIGINAL TASK
{TASK}

## SYNTHESIZED PLAN (from multiple analysis subagents)
{PLAN}

## YOUR MISSION
Review this plan and:
1. Assign priorities (P0=critical/blocking, P1=required, P2=enhancement)
2. Identify any gaps or missing steps
3. Check logical ordering (tests before implementation, setup before coding)
4. Flag potential issues or warnings
5. Calculate an overall quality score (0.0-1.0)

## PRIORITY GUIDELINES
- P0: Foundation tasks, type definitions, project setup, blocking dependencies
- P1: Core implementation, tests, main features, error handling
- P2: Polish, optimization, documentation, nice-to-have features

## OUTPUT FORMAT
Return ONLY a JSON object:
{
  "validatedPlan": [
    {"content": "step description", "priority": "P0|P1|P2", "rationale": "why this priority"}
  ],
  "gaps": ["missing requirement 1", "missing test coverage for X"],
  "warnings": ["consider Y before Z", "potential issue with..."],
  "qualityScore": 0.85
}

Be critical but constructive. A thorough review catches issues early.`;

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

      const totalDurationMs = Date.now() - startTime;

      return {
        success: true,
        items: verificationResult.validatedPlan,
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

      const validatedPlan: PlanItem[] = (parsed.validatedPlan || []).map((item: unknown) => {
        if (typeof item !== 'object' || item === null) {
          return { content: String(item), priority: 'P1' as const };
        }
        const obj = item as Record<string, unknown>;
        let priority: PlanItem['priority'] = null;
        if (obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2') {
          priority = obj.priority;
        }
        return {
          content: String(obj.content || ''),
          priority,
          rationale: obj.rationale ? String(obj.rationale) : undefined,
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
   */
  private fallbackVerification(items: PlanItem[]): VerificationResult {
    return {
      validatedPlan: items.map(item => ({
        ...item,
        priority: item.phase === 1 ? 'P0' as const :
                  item.phase === 4 ? 'P2' as const : 'P1' as const,
      })),
      gaps: [],
      warnings: ['Verification subagent failed - using heuristic priorities'],
      qualityScore: 0.7,
    };
  }

  /**
   * Create a timeout promise.
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
  }
}
