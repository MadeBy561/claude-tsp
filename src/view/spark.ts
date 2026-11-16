/**
 * Claude's spark, alive: twelve rays as nodes of their own, so the surface's
 * stylesheet can colour them from the theme and move each one. What the spark
 * is doing is the end of its role (Tern keeps only the tones it knows, so a
 * tone cannot carry it): `rest` (still), `think` (the rays breathe in a wave),
 * `work` (it turns while a tool runs), `wait` (it holds its breath for an
 * answer), `flare` (Ultracode), `warn` (a retry).
 */
import { h, type Node } from "./h.js";

export type SparkState = "rest" | "think" | "work" | "wait" | "flare" | "warn";
export const RAYS = 12;

export function spark(key: string, state: SparkState, label = "Claude"): Node {
  return h(
    "row",
    { key, role: `claude.spark.${state}`, aria: label },
    Array.from({ length: RAYS }, (_, index) => h("text", { key: `r${index}`, role: `claude.ray.${index}`, text: "\u200b" })),
  );
}

/** The effort gauge: the same twelve rays, lit as far as the level reaches (the stylesheet knows how far). */
export function gauge(key: string, level: string): Node {
  return h(
    "row",
    { key, role: `claude.gauge.${level || "auto"}` },
    Array.from({ length: RAYS }, (_, index) => h("text", { key: `r${index}`, role: `claude.ray.${index}`, text: "\u200b" })),
  );
}
