import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { SpaceMonitor } from "../protocol/panel.js";
import { https } from "./source.js";

type JsonSchema = SpaceMonitor["schema"];
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "description"]);
const object = (value: unknown): value is JsonSchema => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_SCHEMA_BYTES = 10_000;
const MAX_DATA_BYTES = 64 * 1024;
const encoder = new TextEncoder();

function supported(value: unknown, depth: number): value is JsonSchema {
  if (!object(value) || depth > 8 || typeof value.type !== "string" || !TYPES.has(value.type)) return false;
  if (Object.keys(value).some((key) => !KEYWORDS.has(key))) return false;
  if (value.type === "object") {
    const fields = value.properties;
    return object(fields) && Object.values(fields).every((field) => supported(field, depth + 1)) &&
      (value.required === undefined || Array.isArray(value.required) &&
        value.required.every((field) => typeof field === "string" && Object.hasOwn(fields, field))) &&
      (value.additionalProperties === undefined || typeof value.additionalProperties === "boolean");
  }
  if (value.type === "array") {
    return supported(value.items, depth + 1) &&
      (value.minItems === undefined || typeof value.minItems === "number" && Number.isInteger(value.minItems) && value.minItems >= 0);
  }
  return true;
}

export function monitorProblem(monitor: SpaceMonitor): string | undefined {
  if (!https(monitor.url) || !monitor.goal.trim()) return "A monitored Space needs a public HTTPS page and an extraction goal.";
  if (encoder.encode(JSON.stringify(monitor.schema)).length > MAX_SCHEMA_BYTES ||
      monitor.schema.type !== "object" || !supported(monitor.schema, 0)) {
    return "The Space monitor schema needs an object with explicit properties and supported JSON Schema types.";
  }
}

export function monitorDataProblem(schema: JsonSchema, data: unknown): string | undefined {
  if (encoder.encode(JSON.stringify(data)).length > MAX_DATA_BYTES) return "Data exceeds 64 KiB.";
  if (Value.Check(schema as TSchema, data)) return;
  const issues = new Set<string>();
  for (const error of Value.Errors(schema as TSchema, data)) {
    const path = error.instancePath.replace(/\/\d+(?=\/|$)/g, "/*") || "/";
    issues.add(path + " (" + error.message.slice(0, 150) + ")");
    if (issues.size >= 8) break;
  }
  return "Data does not match the Space schema at " + [...issues].sort().join(", ") + ".";
}
