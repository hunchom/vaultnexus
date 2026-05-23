export const VERSION = '0.0.1';

export interface HealthStatus {
  status: 'ok';
  version: string;
}

/** Pure health/version snapshot. No I/O — the daemon adds runtime fields. */
export function health(): HealthStatus {
  return { status: 'ok', version: VERSION };
}
