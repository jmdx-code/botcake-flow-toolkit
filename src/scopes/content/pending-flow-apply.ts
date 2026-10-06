import type { PendingFlowApply } from "../../shared/types";
import { decodePendingFlow, encodePendingFlow, type StoredPendingFlowWire } from "../../core/pending-flow-wire";
import { callBackground, callBackgroundValue } from "./bridge";

// Website scripts can change this pointer, but cannot change the private task.
// Versioning deliberately invalidates legacy website-owned tasks.
const SESSION_KEY = "botcake-flow-toolkit:private-pending-flow-id-v1";

export async function savePendingFlowApply(task: Omit<PendingFlowApply, "id" | "createdAt">): Promise<string> {
  const id = await callBackgroundValue<string>({ action: "savePendingFlowApply", task: encodePendingFlow(task) });
  sessionStorage.setItem(SESSION_KEY, id);
  return id;
}

export async function readPendingFlowApply(): Promise<PendingFlowApply | undefined> {
  const id = sessionStorage.getItem(SESSION_KEY);
  if (!id) return undefined;
  const task = await callBackgroundValue<StoredPendingFlowWire | null>({ action: "readPendingFlowApply", id });
  if (!task) { sessionStorage.removeItem(SESSION_KEY); return undefined; }
  return decodePendingFlow(task);
}

export async function clearPendingFlowApply(id?: string): Promise<void> {
  const target = id ?? sessionStorage.getItem(SESSION_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  if (target) await callBackground({ action: "clearPendingFlowApply", id: target });
}
