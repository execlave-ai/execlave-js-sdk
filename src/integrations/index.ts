/**
 * Framework adapters for @execlave/sdk.
 *
 * Each integration is intentionally not re-exported from the SDK root
 * so installing `@execlave/sdk` does not pull framework peerDeps.
 * Import directly:
 *
 *     import { ExeclaveCallbackHandler } from '@execlave/sdk/integrations/langchain';
 */

export { ExeclaveCallbackHandler } from './langchain';
export type { ExeclaveCallbackHandlerOptions } from './langchain';

export { ExeclaveTracingProcessor } from './openai-agents';
export type { ExeclaveTracingProcessorOptions } from './openai-agents';

export { instrumentCrew } from './crewai';
export type { InstrumentCrewOptions } from './crewai';
