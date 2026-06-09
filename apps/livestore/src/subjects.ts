// Subject conventions live in @rw/runtime so the metrics worker (producer) and
// livestore (consumer) derive identical subjects. Re-exported here so local
// imports stay stable.
export { deriveMetricSubject, deriveTagSubject } from "@rw/runtime/graph-subjects";
