import client from 'prom-client';

// Collect default NodeJS runtime metrics (memory, event loop lag, GC)
client.collectDefaultMetrics({ prefix: 'amrutam_' });

export const httpRequestDurationHistogram = new client.Histogram({
  name: 'amrutam_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds for latency SLA tracking (p95 < 200ms reads, < 500ms writes)',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1.0, 2.5, 5.0], // 10ms to 5s
});

export const httpRequestsTotal = new client.Counter({
  name: 'amrutam_http_requests_total',
  help: 'Total number of HTTP requests processed',
  labelNames: ['method', 'route', 'status_code'],
});

export const consultationsTotalCounter = new client.Counter({
  name: 'amrutam_consultations_total',
  help: 'Total consultations processed partitioned by action status',
  labelNames: ['status'], // 'INITIATED', 'CONFIRMED', 'CANCELLED', 'COMPLETED'
});

export const activeConsultationsGauge = new client.Gauge({
  name: 'amrutam_active_consultations_gauge',
  help: 'Current count of active in-progress consultations',
});

export const idempotencyHitsCounter = new client.Counter({
  name: 'amrutam_idempotency_hits_total',
  help: 'Total number of idempotent duplicate requests intercepted and replayed',
  labelNames: ['outcome'], // 'REPLAYED', 'CONFLICT_IN_PROGRESS', 'NEW'
});

export const lockContentionCounter = new client.Counter({
  name: 'amrutam_lock_contentions_total',
  help: 'Total number of times a distributed lock acquisition contended',
  labelNames: ['resource'],
});

export const securityEventsCounter = new client.Counter({
  name: 'amrutam_security_events_total',
  help: 'Security events such as rate limits and authorization violations',
  labelNames: ['event_type'], // 'RATE_LIMIT_EXCEEDED', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID_SIGNATURE'
});

export const prometheusRegister = client.register;
