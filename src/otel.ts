/**
 * OpenTelemetry adapter for Execlave SDK.
 *
 * Converts Execlave trace payloads to OTel spans and exports
 * them using OTLP/HTTP. Requires optional peer dependencies:
 *   npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/api
 */

import type { TracePayload } from './types';

// Types only — actual modules loaded dynamically
let otelApi: any;
let otelSdk: any;
let otelExporter: any;
let otelResources: any;

async function ensureImports(): Promise<void> {
  if (otelApi) return;
  try {
    otelApi = await import('@opentelemetry/api');
    otelSdk = await import('@opentelemetry/sdk-trace-base');
    otelExporter = await import('@opentelemetry/exporter-trace-otlp-http');
    otelResources = await import('@opentelemetry/resources');
  } catch {
    throw new Error(
      'OpenTelemetry packages required for OTLP mode. Install with: ' +
        'npm install @opentelemetry/sdk-trace-base @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/api',
    );
  }
}

export class OTelExporter {
  private provider: any;
  private tracer: any;

  private constructor() {}

  static async create(endpoint: string, apiKey: string, serviceName: string): Promise<OTelExporter> {
    await ensureImports();
    const instance = new OTelExporter();

    const resource = new otelResources.Resource({
      'service.name': serviceName,
      'execlave.api_key_prefix': apiKey ? apiKey.substring(0, 10) + '...' : 'unknown',
    });

    const exporter = new otelExporter.OTLPTraceExporter({
      url: endpoint.replace(/\/$/, '') + '/v1/traces',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    instance.provider = new otelSdk.BasicTracerProvider({ resource });
    instance.provider.addSpanProcessor(new otelSdk.BatchSpanProcessor(exporter));
    instance.provider.register();
    instance.tracer = otelApi.trace.getTracer('Execlave', '1.0.0');

    return instance;
  }

  exportTraces(traces: TracePayload[]): void {
    for (const payload of traces) {
      const span = this.tracer.startSpan(payload.agentId || 'unknown', {
        kind: otelApi.SpanKind.INTERNAL,
        attributes: this.payloadToAttributes(payload),
      });

      const status = payload.status || 'success';
      if (status === 'error') {
        span.setStatus({ code: otelApi.SpanStatusCode.ERROR, message: payload.errorMessage || '' });
      } else {
        span.setStatus({ code: otelApi.SpanStatusCode.OK });
      }

      span.end();
    }
  }

  private payloadToAttributes(payload: TracePayload): Record<string, string | number | boolean> {
    const attrs: Record<string, string | number | boolean> = {};

    const mapping: Record<string, string> = {
      traceId: 'execlave.trace_id',
      agentId: 'execlave.agent_id',
      sessionId: 'execlave.session_id',
      environment: 'deployment.environment',
      modelName: 'gen_ai.request.model',
      status: 'execlave.status',
      durationMs: 'execlave.duration_ms',
      errorMessage: 'error.message',
      errorType: 'error.type',
      userId: 'enduser.id',
    };

    for (const [key, attrName] of Object.entries(mapping)) {
      const val = (payload as any)[key];
      if (val != null) {
        attrs[attrName] = typeof val === 'object' ? JSON.stringify(val) : val;
      }
    }

    if (payload.promptTokens) attrs['gen_ai.usage.prompt_tokens'] = payload.promptTokens;
    if (payload.completionTokens) attrs['gen_ai.usage.completion_tokens'] = payload.completionTokens;
    if (payload.totalTokens) attrs['gen_ai.usage.total_tokens'] = payload.totalTokens;
    if (payload.costUsd) attrs['execlave.cost_usd'] = payload.costUsd;

    if (payload.input) {
      const inp = typeof payload.input === 'string' ? payload.input : JSON.stringify(payload.input);
      attrs['gen_ai.prompt'] = inp.length > 4096 ? inp.substring(0, 4096) : inp;
    }
    if (payload.output) {
      const out = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output);
      attrs['gen_ai.completion'] = out.length > 4096 ? out.substring(0, 4096) : out;
    }

    return attrs;
  }

  async shutdown(): Promise<void> {
    try {
      await this.provider?.forceFlush();
      await this.provider?.shutdown();
    } catch {
      // Best-effort shutdown
    }
  }
}
