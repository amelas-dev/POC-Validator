// clamp.js — the safety floor governing how the (untrusted) AI advisor may move
// the verdict.
//
// The analyzed code is untrusted and the local model is prompt-injectable, so a
// judged read may ADD caution but must NEVER, on its own, push the verdict BELOW
// the deterministic engine's baseline. Only a human (a manual assumption toggle)
// may choose a lighter read. That rule lives here, in a DOM-free module, so it is
// unit-testable in Node and is the single source of truth shared between app.js
// (the live clamp in computeView) and the test suite.

export const LANE_RANK = { lane1: 0, lane2: 1, approve: 2 };

// True when applying the AI's suggestions would make the verdict LIGHTER than the
// code-certain baseline — the one move the app refuses to make silently.
export function wouldDeEscalate(baselineKey, withAiKey) {
  return (LANE_RANK[withAiKey] ?? 0) < (LANE_RANK[baselineKey] ?? 0);
}
