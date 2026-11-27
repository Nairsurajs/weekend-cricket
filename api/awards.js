// Match awards: Man of the Match, best batter, best bowler.
// The same function is copied into index.html, so the app and the server always agree.
// Contribution points:
//   Batting : 1/run, +1 per four, +2 per six, strike-rate bonus (−6..+10 once 6+ balls faced),
//             +6 for 25+, +15 for 50+, −4 for a duck
//   Bowling : 20/wicket, +10 per maiden, economy vs match run rate ×3 (−10..+15 once 1+ over),
//             +10 for 3+ wickets, −1 per wide/no-ball
//   Fielding: 8 per catch or run-out (when the fielder's name was entered)
//   Winning team: +5
// Fun (desi) awards:
//   Daanveer    : bowler who gave away the most runs (at least 2 bowlers used)
//   Anda club   : every batter out for 0 — "golden" if out on the first ball faced
//   Jaadu Haath : most catches + run-outs (needs the fielder picked when recording the wicket)
function matchAwards(st) {
  if (!st || !Array.isArray(st.inns) || !st.inns.length || !Array.isArray(st.teams)) return null;
  const P = new Map();
  const get = (n, team) => { const k = team + '|' + String(n).toLowerCase(); if (!P.has(k)) P.set(k, { name: n, team, bat: null, bowl: null, fld: 0, pb: 0, pw: 0, pf: 0, pv: 0 }); return P.get(k); };
  const anda = [];
  let tr = 0, tb = 0; for (const i of st.inns) { tr += i.runs | 0; tb += i.balls | 0; }
  const avgRate = tb ? tr * 6 / tb : 6;
  for (const i of st.inns) {
    const bt = st.teams[i.bat].name, wt = st.teams[i.bowl].name;
    for (const b of i.bats || []) {
      const p = get(b.n, bt), sr = b.b ? b.r * 100 / b.b : 0, out = !!b.out && !b.ret;
      let pts = (b.r | 0) + (b.f4 | 0) + 2 * (b.f6 | 0);
      if (b.b >= 6) pts += Math.max(-6, Math.min(10, (sr - 120) / 10));
      if (b.r >= 50) pts += 15; else if (b.r >= 25) pts += 6;
      if (out && !b.r) { pts -= 4; anda.push({ name: b.n, team: bt, golden: (b.b | 0) <= 1 }); }
      p.bat = { r: b.r | 0, b: b.b | 0, f4: b.f4 | 0, f6: b.f6 | 0, out }; p.pb += pts;
      if (b.fld) { const f = get(b.fld, wt); f.fld++; f.pf += 8; }
    }
    for (const w of i.bowls || []) {
      const p = get(w.n, wt), econ = w.balls ? w.r * 6 / w.balls : 0;
      let pts = (w.w | 0) * 20 + (w.md | 0) * 10 - ((w.wd | 0) + (w.nb | 0));
      if (w.balls >= 6) pts += Math.max(-10, Math.min(15, (avgRate - econ) * 3));
      if (w.w >= 3) pts += 10;
      p.bowl = { balls: w.balls | 0, r: w.r | 0, w: w.w | 0, md: w.md | 0 }; p.pw += pts;
    }
  }
  let win = null;
  if (st.phase === 'over' && st.inns.length === 2) {
    const [a, b] = st.inns;
    if (a.runs > b.runs) win = st.teams[a.bat].name; else if (b.runs > a.runs) win = st.teams[b.bat].name;
  }
  const list = [...P.values()];
  for (const p of list) { if (win && p.team === win) p.pv = 5; p.total = Math.round((p.pb + p.pw + p.pf + p.pv) * 10) / 10; }
  const ov = b => Math.floor(b / 6) + (b % 6 ? '.' + (b % 6) : '');
  const batLine = x => `${x.r}${x.out ? '' : '*'} (${x.b})` + (x.f4 || x.f6 ? ' · ' + [x.f4 ? x.f4 + '×4' : '', x.f6 ? x.f6 + '×6' : ''].filter(Boolean).join(' ') : '');
  const bowlLine = x => `${x.w}/${x.r} (${ov(x.balls)} ov)` + (x.md ? ` · ${x.md} maiden${x.md > 1 ? 's' : ''}` : '');
  const line = p => [p.bat && (p.bat.b || p.bat.out) ? batLine(p.bat) : '', p.bowl && p.bowl.balls ? bowlLine(p.bowl) : '', p.fld ? `${p.fld} catch/run-out${p.fld > 1 ? 's' : ''}` : ''].filter(Boolean).join(' & ');
  const pick = (arr, v, tie) => arr.slice().sort((x, y) => v(y) - v(x) || tie(y) - tie(x))[0] || null;
  const mom = pick(list.filter(p => line(p)), p => p.total, p => (p.bat ? p.bat.r : 0) + (p.bowl ? p.bowl.w * 20 : 0));
  const bb = pick(list.filter(p => p.bat && p.bat.b), p => p.pb, p => p.bat.r);
  const bw = pick(list.filter(p => p.bowl && p.bowl.balls), p => p.pw, p => p.bowl.w);
  const r1 = x => Math.round(x * 10) / 10;
  const bowlers = list.filter(p => p.bowl && p.bowl.balls);
  const daan = bowlers.length >= 2 ? pick(bowlers, p => p.bowl.r, p => p.bowl.r * 6 / p.bowl.balls) : null;
  const jaadu = pick(list.filter(p => p.fld), p => p.fld, p => p.total);
  return {
    winner: win,
    mom: mom && { name: mom.name, team: mom.team, points: mom.total, line: line(mom), parts: { batting: r1(mom.pb), bowling: r1(mom.pw), fielding: mom.pf, win: mom.pv } },
    bestBat: bb && { name: bb.name, team: bb.team, points: r1(bb.pb), line: batLine(bb.bat) },
    bestBowl: bw && { name: bw.name, team: bw.team, points: r1(bw.pw), line: bowlLine(bw.bowl) },
    daanveer: daan && daan.bowl.r > 0 ? { name: daan.name, team: daan.team, line: `${daan.bowl.r} runs in ${ov(daan.bowl.balls)} ov` } : null,
    andaClub: anda,
    jaaduHaath: jaadu ? { name: jaadu.name, team: jaadu.team, line: `${jaadu.fld} catch${jaadu.fld > 1 ? 'es' : ''}/run-out${jaadu.fld > 1 ? 's' : ''}` } : null,
  };
}
if (typeof module !== 'undefined') module.exports = { matchAwards };
