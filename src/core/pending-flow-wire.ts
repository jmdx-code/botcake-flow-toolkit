import { z } from "zod";
import { MAX_UNZIPPED_BYTES } from "../shared/constants";
import type { PendingFlowApply } from "../shared/types";
import { base64ToBytes, bytesToBase64 } from "../shared/utils";

const base64 = z.string().max(Math.ceil(MAX_UNZIPPED_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => value.length % 4 === 0);
const wireSchema = z.object({
  sourceName: z.string(), archiveBase64: base64,
  values: z.record(z.string(), z.object({
    text: z.string().optional(), bytesBase64: base64.optional(), fileName: z.string().optional(),
    mime: z.string().optional(), url: z.string().optional(), asset: z.string().optional(),
  })),
  targetPageId: z.string().regex(/^\d+$/), targetFlowId: z.string().regex(/^\d+$/),
  applyWelcome: z.boolean(), target: z.enum(["comment", "defaultReply", "keyword"]),
  keyword: z.object({ id: z.string(), name: z.string(), terms: z.array(z.string()) }).optional(),
  returnUrl: z.string().optional(),
});
export type PendingFlowWire = z.infer<typeof wireSchema>;
export type StoredPendingFlowWire = PendingFlowWire & { id: string; createdAt: number };

export function validatePendingFlowWire(value: unknown): PendingFlowWire {
  const wire = wireSchema.parse(value);
  const total = wire.archiveBase64.length + Object.values(wire.values).reduce((sum, item) => sum + (item.bytesBase64?.length ?? 0), 0);
  if (total > Math.ceil(MAX_UNZIPPED_BYTES / 3) * 4) throw new Error("流程任务体积过大");
  return wire;
}

export function encodePendingFlow(task: Omit<PendingFlowApply, "id" | "createdAt">): PendingFlowWire {
  const { archiveBytes, values, ...rest } = task;
  return validatePendingFlowWire({ ...rest, archiveBase64: bytesToBase64(archiveBytes), values: Object.fromEntries(
    Object.entries(values).map(([key, { bytes, ...value }]) => [key, { ...value, ...(bytes ? { bytesBase64: bytesToBase64(bytes) } : {}) }]),
  ) });
}

export function decodePendingFlow(task: StoredPendingFlowWire): PendingFlowApply {
  const { archiveBase64, values, ...rest } = task;
  return { ...rest, archiveBytes: base64ToBytes(archiveBase64), values: Object.fromEntries(
    Object.entries(values).map(([key, { bytesBase64, ...value }]) => [key, { ...value, ...(bytesBase64 !== undefined ? { bytes: base64ToBytes(bytesBase64) } : {}) }]),
  ) };
}
