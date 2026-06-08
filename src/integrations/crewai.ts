/**
 * CrewAI auto-instrumentation.
 *
 * Usage:
 *
 * ```ts
 * import { Crew } from 'crewai';
 * import { Execlave } from '@execlave/sdk';
 * import { instrumentCrew } from '@execlave/sdk/integrations/crewai';
 *
 * const exe = new Execlave({ apiKey: '...' });
 * const crew = new Crew({ agents: [...], tasks: [...] });
 * instrumentCrew(crew, exe, { agentId: 'my-crew' });
 * await crew.kickoff();
 * ```
 *
 * Implementation: CrewAI exposes `stepCallback` and `taskCallback` hooks
 * on `Agent` and `Crew` objects. We chain our callbacks in front of any
 * existing user callbacks so attaching the instrumentation never
 * overrides user-supplied hooks.
 *
 * Idempotent — `_execlaveInstrumented` marker prevents double-wrapping.
 *
 * Note: CrewAI's first-class JS implementation is still emerging; this
 * helper duck-types the callback shape so it works with both the
 * official package and community ports. No compile-time dependency.
 */

import type { Execlave } from '../client';
import {
  PolicyBlockedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  EnforcementUnavailableError,
  AgentPausedError,
} from '../errors';
import {
  Span,
  SPAN_KIND_AGENT,
  SPAN_KIND_TOOL,
  getSpanTree,
} from '../instrumentation/spans';

const MARKER = '_execlaveInstrumented';

function isEnforcementError(err: unknown): boolean {
  return (
    err instanceof PolicyBlockedError ||
    err instanceof PolicyDeniedError ||
    err instanceof ApprovalTimeoutError ||
    err instanceof EnforcementUnavailableError ||
    err instanceof AgentPausedError
  );
}

export interface InstrumentCrewOptions {
  /** Agent id registered with Execlave. Required for enforcement. */
  agentId: string;
  /** Run `enforcePolicy` on tool steps. Default true. */
  enforce?: boolean;
  sessionId?: string;
  userId?: string;
}

/**
 * Attach Execlave instrumentation to a CrewAI `Crew` instance.
 *
 * Idempotent: calling twice on the same crew is a no-op. Returns the
 * same crew for fluent chaining.
 */
export function instrumentCrew<T>(crew: T, exe: Execlave, opts: InstrumentCrewOptions): T {
  if (crew === null || crew === undefined) {
    throw new Error('instrumentCrew: crew must not be null/undefined');
  }
  if (!exe) throw new Error('instrumentCrew: exe must not be null/undefined');
  if (!opts?.agentId) throw new Error('instrumentCrew: agentId is required');

  const c = crew as any;
  if (c[MARKER]) return crew;

  const tree = getSpanTree(exe);

  const stepCallback = async (step: any): Promise<void> => {
    try {
      await recordStep(tree, exe, step, opts);
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn('[execlave] crewai stepCallback failed:', err);
    }
  };

  const taskCallback = (taskOutput: any): void => {
    try {
      recordTask(tree, taskOutput, opts);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[execlave] crewai taskCallback failed:', err);
    }
  };

  // Chain rather than replace — preserve user-supplied callbacks.
  chainCallback(c, 'stepCallback', stepCallback);
  chainCallback(c, 'step_callback', stepCallback);
  chainCallback(c, 'taskCallback', taskCallback);
  chainCallback(c, 'task_callback', taskCallback);

  // Crew also exposes a list of Agent objects each with their own
  // stepCallback. Instrument them too so tool calls from sub-agents
  // are captured.
  const agents = (c.agents ?? []) as any[];
  for (const inner of agents) {
    chainCallback(inner, 'stepCallback', stepCallback);
    chainCallback(inner, 'step_callback', stepCallback);
  }

  try {
    c[MARKER] = true;
  } catch {
    /* frozen object — double-wrap guard inactive */
  }

  return crew;
}

// ----------------------------------------------------------------------
// Internal: chaining + recording
// ----------------------------------------------------------------------
function chainCallback(obj: any, attr: string, newCb: (payload: any) => void | Promise<void>): void {
  if (!obj || typeof obj !== 'object') return;
  const existing = obj[attr];
  if (existing === undefined || existing === null) {
    try {
      obj[attr] = newCb;
    } catch {
      /* noop */
    }
    return;
  }

  const chained = async (payload: any): Promise<void> => {
    try {
      await newCb(payload);
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[execlave] ${attr} failed:`, err);
    }
    try {
      await existing(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[execlave] user-provided ${attr} raised:`, err);
    }
  };

  try {
    obj[attr] = chained;
  } catch {
    /* noop */
  }
}

async function recordStep(
  tree: ReturnType<typeof getSpanTree>,
  exe: Execlave,
  step: any,
  opts: InstrumentCrewOptions,
): Promise<void> {
  // CrewAI step shapes vary across versions; attribute-detect rather than
  // rely on a particular structure.
  const tool = step?.tool ?? step?.toolName ?? null;
  const toolInput = step?.toolInput ?? step?.tool_input ?? step?.input ?? null;
  const isTool = Boolean(tool);
  const kind: Parameters<typeof tree.start>[0]['kind'] = isTool ? SPAN_KIND_TOOL : SPAN_KIND_AGENT;
  const name = isTool ? String(tool) : 'step';

  if (isTool && opts.enforce !== false) {
    try {
      await exe.enforcePolicy({
        agentId: opts.agentId,
        input: toolInput !== null && toolInput !== undefined ? safeStr(toolInput) : `tool:${tool}`,
        tools: [String(tool)],
      });
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn('[execlave] enforcePolicy failed (non-fatal):', err);
    }
  }

  const span: Span = tree.start({
    kind,
    name,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    metadata: { crewaiStep: true },
  });
  if (toolInput !== null && toolInput !== undefined) {
    try {
      span.setInput(toolInput);
    } catch {
      /* noop */
    }
  }
  const output = step?.output ?? step?.result ?? null;
  if (output !== null && output !== undefined) {
    try {
      span.setOutput(output);
    } catch {
      /* noop */
    }
  }
  span.finish('success');
}

function recordTask(
  tree: ReturnType<typeof getSpanTree>,
  taskOutput: any,
  opts: InstrumentCrewOptions,
): void {
  const description =
    taskOutput?.description ??
    taskOutput?.task ??
    taskOutput?.name ??
    'task';
  const span: Span = tree.start({
    kind: SPAN_KIND_AGENT,
    name: String(description).slice(0, 80),
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    metadata: { crewaiTask: true },
  });
  const raw = taskOutput?.raw ?? taskOutput?.output ?? taskOutput?.result ?? null;
  if (raw !== null && raw !== undefined) {
    try {
      span.setOutput(raw);
    } catch {
      /* noop */
    }
  }
  span.finish('success');
}

function safeStr(value: unknown, limit = 4000): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}
