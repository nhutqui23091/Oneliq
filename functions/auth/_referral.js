/**
 * Shared helper: Portal referrals + the "Connector" badge.
 *
 * Trust-based, no reward — the count is purely a vanity/engagement metric.
 * Flow (two stages):
 *   1. recordReferral() binds the referrer onto the referee (referred_by) when
 *      they open Portal with ?ref=<code>. This does NOT yet count.
 *   2. creditReferrerOnWelcome() runs when the referee earns the "Welcome to
 *      Oneliq" badge — only then is the referee counted toward the referrer's
 *      total. There is no cap on invites; the Connector badge unlocks at
 *      REFERRAL_GOAL credited invites.
 *
 * Storage (PROFILE_KV, key gm:${addr}):
 *   referred_by        - wallet that referred this one (set once, immutable)
 *   referral_credited  - true once this wallet's Welcome has credited referrer
 *   referrals          - array of credited referees (deduped)
 *   referral_count     - referrals.length
 */

export const REFERRAL_GOAL = 10;

// Stage 1: bind the referrer on the referee. If the referee somehow already
// holds the Welcome badge, credit immediately.
export async function recordReferral(kv, refereeAddr, refRaw) {
  const referee = (refereeAddr || '').toLowerCase();
  let referrer  = (refRaw || '').toLowerCase();

  // The ref param is normally a short code; resolve it to an address. A raw
  // 0x address (legacy links) is accepted as-is.
  if (referrer && !/^0x[0-9a-f]{40}$/.test(referrer)) {
    const resolved = await kv.get('refcode:' + referrer);
    referrer = (resolved || '').toLowerCase();
  }

  // Reject self-referrals and unresolved/malformed referrers.
  if (!/^0x[0-9a-f]{40}$/.test(referrer) || referee === referrer) {
    return { recorded: false, reason: 'invalid' };
  }

  let refereeState = {};
  try { const raw = await kv.get('gm:' + referee); if (raw) refereeState = JSON.parse(raw); } catch {}
  if (refereeState.referred_by) {
    return { recorded: false, reason: 'already' };
  }

  refereeState.referred_by = referrer;
  await kv.put('gm:' + referee, JSON.stringify(refereeState));

  // Edge case: referee already earned Welcome before being referred.
  const badges = Array.isArray(refereeState.badges) ? refereeState.badges : [];
  if (badges.includes('welcome')) {
    await creditReferrerOnWelcome(kv, referee, refereeState);
  }

  return { recorded: true };
}

// Stage 2: credit the referrer once the referee has earned Welcome. Idempotent
// via referral_credited on the referee. `refereeState` is the referee's current
// gm state (with referred_by). Returns nothing meaningful to the caller.
export async function creditReferrerOnWelcome(kv, refereeAddr, refereeState) {
  const referee  = (refereeAddr || '').toLowerCase();
  const referrer = (refereeState?.referred_by || '').toLowerCase();

  if (!/^0x[0-9a-f]{40}$/.test(referrer) || referee === referrer) return;
  if (refereeState.referral_credited) return;

  // Mark the referee credited so this never double-counts.
  await kv.put('gm:' + referee, JSON.stringify({ ...refereeState, referral_credited: true }));

  // Append to the referrer's credited list + maybe award the Connector badge.
  let st = {};
  try { const raw = await kv.get('gm:' + referrer); if (raw) st = JSON.parse(raw); } catch {}

  const list = Array.isArray(st.referrals) ? st.referrals : [];
  if (!list.includes(referee)) list.push(referee);
  st.referrals      = list;
  st.referral_count = list.length;

  const badges = Array.isArray(st.badges) ? st.badges : [];
  if (list.length >= REFERRAL_GOAL && !badges.includes('referral')) {
    badges.push('referral');
    st.badges = badges;
  }

  await kv.put('gm:' + referrer, JSON.stringify(st));
}
