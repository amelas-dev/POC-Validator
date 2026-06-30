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
export const TIER_RANK = { Use: 0, Register: 1, Approve: 2 };

// True when applying the AI's suggestions would make the verdict LIGHTER than the
// code-certain baseline — the one move the app refuses to make silently.
export function wouldDeEscalate(baselineKey, withAiKey) {
  return (LANE_RANK[withAiKey] ?? 0) < (LANE_RANK[baselineKey] ?? 0);
}

// The FULL clamp. The coarse lane key (lane1/lane2/approve) can stay pinned by a
// code-certain fact (e.g. a direct AI call pins Lane 2) while the prompt-injectable
// model still quietly relaxes the *tier* (Approve→Register→Use) or flips a §5 condition
// from fail to pass — both of which are surfaced in the footer and the hand-off packet.
// So "lighter than baseline" must be judged on the whole ordered state, not just the
// lane key: hold the AI read if it lowers the lane rank OR the tier rank OR turns ANY
// failing condition into a pass. Conditions are emitted in a fixed order by resolve(),
// so index alignment is valid. Escalation (more caution) is always allowed through.
export function wouldRelax(baseline, withAi) {
  if (!baseline || !withAi) return false;
  if ((LANE_RANK[withAi.verdict && withAi.verdict.key] ?? 0) < (LANE_RANK[baseline.verdict && baseline.verdict.key] ?? 0)) return true;
  if ((TIER_RANK[withAi.tier] ?? 0) < (TIER_RANK[baseline.tier] ?? 0)) return true;
  const bc = baseline.conditions || [], wc = withAi.conditions || [];
  const failed = (s) => s === 'lane2' || s === 'review';
  for (let i = 0; i < bc.length; i++) {
    if (wc[i] && failed(bc[i].status) && !failed(wc[i].status)) return true; // a fail flipped to pass
  }
  return false;
}
