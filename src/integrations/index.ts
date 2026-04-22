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
