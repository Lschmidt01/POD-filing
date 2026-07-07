/**
 * Tests.gs — quick checks runnable from the Apps Script editor. The pure-logic
 * tests need no workbook/Gmail; the smoke test needs install() to have run.
 */

/** Pure functions only — safe to run before install(). */
function test_pureLogic() {
  const cases = [];
  const eq = (label, got, want) => cases.push({ label, ok: got === want, got, want });

  // Match._normalize strips punctuation, case, and corporate suffixes.
  eq('normalize acme', Match._normalize('Acme Produce Co.'), 'acme produce');
  eq('normalize typo casing', Match._normalize('ACME  produce'), 'acme produce');

  // Naming._clean turns separators into hyphens.
  eq('clean slashes', Naming._clean('A/B_C'), 'A-B-C');

  // Suffix is deterministic for a given item key.
  eq('suffix stable',
    Naming._shortSuffix('msg1::abc'), Naming._shortSuffix('msg1::abc'));

  const failed = cases.filter(c => !c.ok);
  cases.forEach(c => Logger.log('%s %s', c.ok ? 'PASS' : 'FAIL', c.label
    + (c.ok ? '' : ' got=' + c.got + ' want=' + c.want)));
  Logger.log(failed.length ? failed.length + ' FAILED' : 'all pure-logic tests passed');
}

/**
 * Smoke test: requires install(). Adds a temp customer, resolves a name, and
 * logs the filename that would be produced. Does not touch Gmail.
 */
function test_smoke() {
  const decision = Match.resolve('Acme Produce Co');
  Logger.log('match decision: %s', JSON.stringify(decision));
  const stem = Naming.buildBaseName({
    date: '2026-06-30', po: '9371944H', invoice: '2178881', itemKey: 'smoke::1' });
  Logger.log('filename stem: %s.pdf', stem);
}
