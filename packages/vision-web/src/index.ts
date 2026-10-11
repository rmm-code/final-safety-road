/**
 * Browser vision package.
 *
 * Owns model loading, execution-provider selection, pre/post-processing and the local
 * detection pipeline (tracking, visual severity, best-frame selection). Product code
 * depends on this package's normalised types, never on a model runtime.
 */
export * from "./config/vision-config";
export * from "./postprocess";
export * from "./pipeline";
export * from "./engines";
export { createPrng, randomBetween } from "./util/prng";
export { createSequentialIdFactory } from "./util/id";
