// Deliberately tiny and self-contained: this project does not share a harness with
// onevio-crm. Collect cases at import time, run them in order in run.mjs.
export const CASES = [];
export const test = (name, fn) => CASES.push({ name, fn });

// Test files are imported BEFORE bootstrap() resets the schema, so nothing may touch the
// database at import time -- it would be dropped before the first assertion. Wrap shared
// setup in once() and call it inside each test: the first caller builds it, the rest wait
// on the same promise.
export function once(fn) {
  let p = null;
  return () => (p ??= fn());
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not equal"}: expected ${e}, got ${a}`);
}

// A denial can arrive two ways through PostgREST: an explicit error (insert/update
// blocked by a policy) or a silent empty result (select filtered by a policy). Tests must
// say which they mean, so there are two helpers rather than one fuzzy one.
export function assertDenied(error, msg) {
  if (!error) throw new Error(msg || "expected the write to be denied, but it succeeded");
}

export function assertInvisible(data, msg) {
  // A null/undefined data is PostgREST reporting an unexpected error, not a policy
  // silently filtering rows -- treating it as "[]" would let a broken query pass as a
  // denial. Callers that genuinely expect null (an update/delete outright refused, no
  // rows to select) must assert that explicitly instead of routing through here.
  if (data == null) throw new Error(`${msg || "expected zero visible rows"}: got ${JSON.stringify(data)}`);
  if (!Array.isArray(data)) throw new Error(`expected rows array, got ${JSON.stringify(data)}`);
  if (data.length !== 0) throw new Error(`${msg || "expected zero visible rows"}: saw ${data.length}`);
}
