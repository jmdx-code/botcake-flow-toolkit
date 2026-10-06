import { FLOW_URL_PATTERN } from "./constants";
import type { FlowIdentity, JsonValue } from "./types";

export function getFlowIdentity(url = location.href): FlowIdentity {
  const match = url.match(FLOW_URL_PATTERN);
  if (!match) throw new Error("当前页面不是 Botcake Flow 编辑页");
  return { pageId: match[1], flowId: match[2] };
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function randomId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function walkJson(
  value: unknown,
  visitor: (value: unknown, path: string, parent: unknown, key: string | number | undefined) => void,
  path = "$",
  parent?: unknown,
  key?: string | number,
): void {
  visitor(value, path, parent, key);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visitor, `${path}[${index}]`, value, index));
  } else if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      walkJson(childValue, visitor, `${path}.${escapePathKey(childKey)}`, value, childKey);
    }
  }
}

function escapePathKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : `[${JSON.stringify(key)}]`;
}

export function setByPath(root: unknown, path: string, value: unknown): void {
  const segments = parsePath(path);
  if (segments[0] === "$") segments.shift();
  let current = root as Record<string | number, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segments[i])) throw new Error(`无法写入路径：${path}`);
    current = current[segments[i]] as Record<string | number, unknown>;
  }
  if (!current || typeof current !== "object" || !segments.length) throw new Error(`无法写入路径：${path}`);
  current[segments.at(-1)!] = value;
}

export function getByPath(root: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments[0] === "$") segments.shift();
  return segments.reduce<unknown>((current, segment) => {
    if (current == null || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined;
    return (current as Record<string | number, unknown>)[segment];
  }, root);
}

export function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = ["$"];
  const source = path.startsWith("$") ? path.slice(1) : path;
  const regex = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = regex.exec(source))) {
    if (match.index !== consumed) throw new Error(`路径格式无效：${path}`);
    consumed = regex.lastIndex;
    if (match[1]) segments.push(match[1]);
    else if (match[2]) segments.push(Number(match[2]));
    else segments.push(JSON.parse(`"${match[3]}"`) as string);
  }
  if (consumed !== source.length || segments.some((segment) => typeof segment === "string" && ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw new Error(`路径格式无效或包含原型属性：${path}`);
  }
  return segments;
}

export function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
