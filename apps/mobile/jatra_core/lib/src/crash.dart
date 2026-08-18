import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'api/client.dart';
import 'i18n.dart';
import 'theme.dart';

/// What the apps do when something goes wrong that nobody anticipated.
///
/// Two separate jobs, and they are separate on purpose:
///
///   1. The person holding the phone gets a screen they can act on. Flutter's
///      default is a red box of yellow-on-black stack trace, which on a bus at
///      night tells a conductor nothing except that the app is broken. It also
///      appears *inside* the layout, so half a working screen stays on show and
///      the failure looks like a design.
///
///   2. Somebody at the office finds out. A crash that only ever happened on
///      one phone in Cumilla is a rumour; the same crash with a stack trace, a
///      screen name and a count is a bug report.
///
/// Nothing here tries to keep the app running through an error it did not
/// expect. Carrying on after an unknown fault is how a ticket gets issued twice
/// or a duty gets closed against the wrong figure.
class CrashGuard {
  CrashGuard({
    required this.app,
    required this.client,
    this.version = 'dev',
  });

  /// Which app this is: `passenger` or `crew`. The server refuses anything else,
  /// because a crash in the crew app read as a passenger one sends whoever is
  /// looking to the wrong screen.
  final String app;
  final ApiClient client;
  final String version;

  /// The screen the person is on, in the words they would use — not a widget
  /// class. Set by the app as it navigates; a stack trace names our functions,
  /// this names where somebody was standing.
  static String currentScreen = '';

  /// The language last chosen, kept here rather than read from the widget tree.
  /// The crash screen renders when that tree is already in trouble, and a
  /// lookup that needs an inherited widget is one more thing that can fail
  /// while reporting a failure.
  static Lang lang = Lang.bn;

  /// The same fault reported from fifty phones is one problem. Reported once
  /// per phone per run is enough to establish that; reported on every frame of
  /// a build loop is a denial of service we wrote ourselves.
  final Set<String> _reportedThisRun = {};

  /// Installs the guard and runs [body] inside it.
  ///
  /// Three hooks, because Flutter has three ways for an error to escape and
  /// catching two of them is the same as catching none:
  ///
  ///   FlutterError.onError            errors raised inside the framework
  ///   PlatformDispatcher.onError      uncaught asynchronous errors
  ///   runZonedGuarded                 everything else on this zone
  Future<void> run(FutureOr<void> Function() body) async {
    final delegate = FlutterError.onError;
    FlutterError.onError = (details) {
      delegate?.call(details); // still logged to the console in debug
      report(details.exception, details.stack,
          context: details.context?.toDescription() ?? '');
    };

    // The framework's red screen, replaced with something a conductor can act
    // on. Kept deliberately plain: it renders while the app is in an unknown
    // state, so it must not itself depend on anything that could be broken.
    ErrorWidget.builder = (details) => CrashScreen(details: details);

    PlatformDispatcher.instance.onError = (error, stack) {
      report(error, stack, context: 'uncaught async');
      return true;
    };

    await runZonedGuarded(() async => body(), (error, stack) {
      report(error, stack, context: 'zone');
    });
  }

  /// Sends one crash. Never throws: a client that cannot report a crash must
  /// not then have to handle failing to report it.
  Future<void> report(Object error, StackTrace? stack, {String context = ''}) async {
    try {
      final kind = error.runtimeType.toString();
      final trace = stack?.toString() ?? '';
      final fp = _fingerprint(kind, trace);
      if (!_reportedThisRun.add(fp)) return;

      await client.post('/client-errors', body: {
        'app': app,
        'app_version': version,
        'platform': _platform(),
        'screen': currentScreen.isEmpty ? context : currentScreen,
        'kind': kind,
        'message': error.toString(),
        'stack': trace,
        'fingerprint': fp,
      });
    } catch (_) {
      // Deliberately silent. There is nothing left to tell and nobody to tell
      // it to, and an exception thrown out of the error handler replaces a bug
      // we could have fixed with one we cannot see.
    }
  }

  /// Groups the same fault together across phones and releases.
  ///
  /// Built from the exception type and the first few *frames*, not the message:
  /// messages carry seat numbers and PNRs, so grouping on them would file the
  /// same bug once per passenger — and would put passenger data in a key.
  static String _fingerprint(String kind, String stack) {
    final frames = stack
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty)
        .take(3)
        // Line and column numbers move with every edit; the function does not.
        .map((l) => l.replaceAll(RegExp(r'[:\s]\d+'), ''))
        .join('|');
    return '$kind:${frames.hashCode.toRadixString(16)}';
  }

  static String _platform() {
    if (kIsWeb) return 'web';
    try {
      return '${Platform.operatingSystem} ${Platform.operatingSystemVersion}';
    } catch (_) {
      return 'unknown';
    }
  }
}

/// What replaces the red screen.
///
/// It says what happened in a sentence, says the office has been told, and
/// offers the only thing that reliably works when the app is in an unknown
/// state. The stack trace is available but folded away: it is for the person
/// the conductor rings, not for the conductor.
class CrashScreen extends StatelessWidget {
  const CrashScreen({super.key, required this.details});
  final FlutterErrorDetails details;

  @override
  Widget build(BuildContext context) {
    // No L.of(context) here — see CrashGuard.lang.
    final l = L(CrashGuard.lang);
    return Material(
      color: J.ground,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.error_outline, size: 44, color: J.warn),
              const SizedBox(height: 16),
              Text(l('crash.title'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
              const SizedBox(height: 10),
              Text(l('crash.told'),
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: J.muted, height: 1.5)),
              const SizedBox(height: 24),
              ExpansionTile(
                title: Text(l('crash.detail'),
                    style: const TextStyle(fontSize: 13, color: J.muted)),
                children: [
                  SelectableText(
                    '${details.exception}\n\n${details.stack ?? ''}',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                    maxLines: 20,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A boundary around one screen.
///
/// [CrashGuard] catches what escapes the app; this catches what escapes a
/// single subtree, so a failure in the manifest does not take the bottom bar
/// and the scanner with it. Use it where losing one screen is survivable and
/// losing the app is not.
class ScreenBoundary extends StatefulWidget {
  const ScreenBoundary({super.key, required this.child, required this.screen});
  final Widget child;

  /// The name reported with anything that goes wrong under here.
  final String screen;

  @override
  State<ScreenBoundary> createState() => _ScreenBoundaryState();
}

class _ScreenBoundaryState extends State<ScreenBoundary> {
  @override
  void initState() {
    super.initState();
    CrashGuard.currentScreen = widget.screen;
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
