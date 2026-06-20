/**
 * Deterministic streak computation from check-in history (freeze-budget rule).
 *
 * Shared by the live check-in (functions/auth/gm.js) and the one-time repair
 * (functions/auth/admin/repair-streaks.js) so both always agree. Computing the
 * streak from the FULL history each time — rather than a single-step compare
 * against last_checkin — makes it self-healing: one bad write can never
 * permanently truncate a streak, because the next check-in rebuilds it.
 *
 * Rule (freeze-budget):
 *   - Consecutive UTC day  → streak += 1.
 *   - A gap of N missed days consumes N freezes if enough remain (streak
 *     continues); otherwise the streak resets to 1 at that day.
 *   - Everyone starts with 3 freezes. Reaching streak 7 / 30 / 100 grants
 *     +1 freeze (capped at 5). Freezes are never reset by a streak reset.
 *
 * Days are UTC ("YYYY-MM-DD"), matching utcToday() in gm.js and the on-chain
 * OneliqCheckIn contract (block.timestamp / 1 days).
 *
 * @param {string[]} history  check-in date strings, any order, dupes tolerated.
 * @returns {{streak:number, freezes_left:number, longest:number}}
 */
export function computeStreak(history) {
  const days = [...new Set((Array.isArray(history) ? history : [])
    .filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (days.length === 0) return { streak: 0, freezes_left: 3, longest: 0 };

  const idx = d => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);

  let freezes = 3, streak = 1, longest = 1;
  const grantMilestone = () => {
    if ((streak === 7 || streak === 30 || streak === 100) && freezes < 5) {
      freezes = Math.min(freezes + 1, 5);
    }
  };
  grantMilestone();

  for (let i = 1; i < days.length; i++) {
    const gap = idx(days[i]) - idx(days[i - 1]);
    if (gap === 1) {
      streak += 1;
    } else {
      const missed = gap - 1;            // gap >= 2 here (days are unique + sorted)
      if (missed <= freezes) { freezes -= missed; streak += 1; }
      else { streak = 1; }
    }
    grantMilestone();
    if (streak > longest) longest = streak;
  }

  return { streak, freezes_left: freezes, longest };
}
