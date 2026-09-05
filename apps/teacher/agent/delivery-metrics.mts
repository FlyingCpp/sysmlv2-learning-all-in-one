export interface DeliveryTelemetrySnapshot {
  readonly workspaceHashComputeCount: number;
  readonly adapterLedgerRebuildCount: number;
  readonly adapterWorkspaceHashRecomputeCount: number;
}

const telemetry = {
  workspaceHashComputeCount: 0,
  adapterLedgerRebuildCount: 0,
  adapterWorkspaceHashRecomputeCount: 0,
};

export function recordWorkspaceHashCompute(): void {
  telemetry.workspaceHashComputeCount += 1;
}

export function recordAdapterLedgerRebuild(): void {
  telemetry.adapterLedgerRebuildCount += 1;
}

export function recordAdapterWorkspaceHashRecompute(): void {
  telemetry.adapterWorkspaceHashRecomputeCount += 1;
}

export function getDeliveryTelemetry(): DeliveryTelemetrySnapshot {
  return Object.freeze({ ...telemetry });
}

export function resetDeliveryTelemetry(): void {
  telemetry.workspaceHashComputeCount = 0;
  telemetry.adapterLedgerRebuildCount = 0;
  telemetry.adapterWorkspaceHashRecomputeCount = 0;
}
