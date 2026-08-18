import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:jatra_core/jatra_core.dart';

/// Every string the crew app asks for must exist.
///
/// A missing key does not throw. It renders the key itself, so a dialog button
/// reads `common.ok` and a Bangla screen suddenly has a dotted English
/// identifier on it. That is exactly how it was found: not by a test, not by
/// reading the code, but by opening the app on a device and looking at a
/// button.
///
/// This walks the source instead, so the next one is caught before anybody has
/// to see it.

void main() {
  test('no screen asks for a string that does not exist', () {
    final dirs = [Directory('lib'), Directory('../jatra_core/lib')];
    // Matches l('x'), L(lang)('x') and l("x") — the three ways this codebase
    // reaches for a string.
    final pattern = RegExp(r"""\bl\(\s*['"]([a-zA-Z][\w.]*)['"]""");

    final missing = <String, List<String>>{};
    var scanned = 0;

    for (final dir in dirs) {
      if (!dir.existsSync()) continue;
      for (final entity in dir.listSync(recursive: true)) {
        if (entity is! File || !entity.path.endsWith('.dart')) continue;
        scanned++;
        final text = entity.readAsStringSync();
        for (final m in pattern.allMatches(text)) {
          final key = m.group(1)!;
          // Keys built at runtime from a server value — 'cr.role.$r' and the
          // like — are not literals and cannot be checked here. Those are
          // covered by the roster tests, which assert no pill is ever raw.
          if (key.contains(r'$')) continue;
          if (!kStrings.containsKey(key)) {
            missing.putIfAbsent(key, () => []).add(entity.path);
          }
        }
      }
    }

    expect(scanned, greaterThan(5), reason: 'the scan found almost no source; '
        'the working directory is probably wrong and this test is proving nothing');
    expect(missing, isEmpty,
        reason: 'these keys are asked for but never defined, so they render as '
            'themselves on screen:\n'
            '${missing.entries.map((e) => '  ${e.key}  ← ${e.value.first}').join('\n')}');
  });

  test('every string defined has both languages filled in', () {
    final empty = <String>[];
    kStrings.forEach((key, str) {
      if (str.en.trim().isEmpty || str.bn.trim().isEmpty) empty.add(key);
    });
    // A blank Bangla side is worse than an English one: it renders as nothing
    // at all, and a button with no words on it is not a button.
    expect(empty, isEmpty, reason: 'half-translated keys: ${empty.join(', ')}');
  });
}
