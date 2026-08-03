/**
 * Shared internal instrumentation layer — JS mirror of
 * `sdk-python/execlave/instrumentation/`.
 *
 * Provides nested span primitives + event helpers consumed by
 * framework adapters (LangChain, etc.). Zero runtime deps beyond the
 * base SDK.
 */

export {
  Span,
  SpanTree,
  getSpanTree,
  SPAN_KIND_AGENT,
  SPAN_KIND_CHAIN,
  SPAN_KIND_LLM,
  SPAN_KIND_TOOL,
  SPAN_KIND_RETRIEVER,
  SPAN_KIND_GUARDRAIL,
  SPAN_KIND_HANDOFF,
  type SpanKind,
} from './spans';
export {
  recordLlmCall,
  recordToolCall,
  recordAgentAction,
  recordRetrieval,
} from './events';
