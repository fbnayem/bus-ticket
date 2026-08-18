import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:local_auth/local_auth.dart';

import 'app_state.dart';
import 'reminders.dart';
import 'screens/account.dart';
import 'screens/home.dart';
import 'screens/offers.dart';
import 'screens/tickets.dart';
import 'screens/voice.dart';

Future<void> main() async {
  final client = ApiClient();
  // Start-up is inside the guard too. A crash while opening the store or
  // starting reminders used to be a black screen with nothing to report.
  await CrashGuard(app: 'passenger', client: client, version: kAppVersion).run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    final store = await Store.open();
    CrashGuard.lang = store.lang;
    final reminders = await Reminders.start(store);
    final state = AppState(
      api: PassengerApi(client),
      store: store,
      reminders: reminders,
    );
    runApp(PassengerApp(state: state));
  });
}

/// Reported with every crash, so a bug can be tied to a release rather than to
/// "the version that was on the phone in June".
const kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: 'dev');

class PassengerApp extends StatefulWidget {
  const PassengerApp({super.key, required this.state});
  final AppState state;

  @override
  State<PassengerApp> createState() => _PassengerAppState();
}

class _PassengerAppState extends State<PassengerApp> {
  late Lang _lang = widget.state.store.lang;
  late bool _locked = widget.state.store.biometricOn;

  @override
  void initState() {
    super.initState();
    if (_locked) _unlock();
    // Refresh what is in the pocket. Failures are silent by design: the cached
    // tickets are already on screen and a network error must not replace them.
    widget.state.refreshTickets();
  }

  /// Guards the app, not the platform.
  ///
  /// The session token is what the server checks; this only keeps a stranger
  /// holding an unlocked phone out of somebody's travel history. So a device
  /// that cannot do biometrics simply opens — refusing entry would lock a
  /// passenger out of a ticket they have already paid for.
  Future<void> _unlock() async {
    try {
      final auth = LocalAuthentication();
      final supported = await auth.isDeviceSupported();
      if (!supported) {
        if (mounted) setState(() => _locked = false);
        return;
      }
      final ok = await auth.authenticate(
        localizedReason: L(_lang)('ac.biometricPrompt'),
        options: const AuthenticationOptions(stickyAuth: true),
      );
      if (mounted && ok) setState(() => _locked = false);
    } catch (_) {
      if (mounted) setState(() => _locked = false);
    }
  }

  void _setLang(Lang l) {
    setState(() => _lang = l);
    widget.state.store.setLang(l);
    CrashGuard.lang = l;
  }

  @override
  Widget build(BuildContext context) {
    return LangScope(
      lang: _lang,
      setLang: _setLang,
      child: AppScope(
        state: widget.state,
        child: MaterialApp(
          title: 'Jatra',
          debugShowCheckedModeBanner: false,
          theme: jatraTheme(),
          home: _locked ? _LockScreen(onUnlock: _unlock) : const Shell(),
          builder: (context, child) => MediaQuery.withClampedTextScaling(
            minScaleFactor: 1.0,
            maxScaleFactor: 1.4,
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      ),
    );
  }
}

class _LockScreen extends StatelessWidget {
  const _LockScreen({required this.onUnlock});
  final VoidCallback onUnlock;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      backgroundColor: J.field,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.lock_outline, color: Colors.white70, size: 40),
            const SizedBox(height: 16),
            Text(l('ac.biometricPrompt'),
                style: const TextStyle(color: Colors.white, fontSize: 18)),
            const SizedBox(height: 20),
            OutlinedButton(
              onPressed: onUnlock,
              style: OutlinedButton.styleFrom(
                foregroundColor: Colors.white,
                side: const BorderSide(color: Colors.white54),
              ),
              child: Text(l('common.retry')),
            ),
          ],
        ),
      ),
    );
  }
}

/// Four destinations, and no more.
///
/// Everything a passenger does is a search, a ticket, an offer or a setting.
/// A fifth tab would have to displace one of those.
///
/// Each tab owns a Navigator rather than sharing the root one. That is what
/// keeps the bottom bar on screen: a push used to go to the navigator ABOVE
/// this Scaffold, so results, seats, passengers, payment and the ticket all
/// covered the bar — the app lost its navigation exactly when somebody was
/// deepest inside it, which is when they are most likely to want out.
///
/// The screens themselves needed no change for this. `Navigator.of(context)`
/// resolves to the nearest navigator, which is now the tab's own.
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => ShellState();
}

class ShellState extends State<Shell> {
  int _tab = 0;

  static const _tabs = 4;
  final _navs = List.generate(_tabs, (_) => GlobalKey<NavigatorState>());

  NavigatorState? get _current => _navs[_tab].currentState;

  void _select(int i) {
    // Tapping the tab you are already on pops it back to its root. It is what
    // every other app does, and it is the way out of a deep flow that does not
    // involve pressing back five times.
    if (i == _tab) {
      _current?.popUntil((r) => r.isFirst);
      return;
    }
    setState(() => _tab = i);
  }

  Widget _tabNavigator(int i, Widget root) => Navigator(
        key: _navs[i],
        onGenerateRoute: (settings) =>
            MaterialPageRoute(settings: settings, builder: (_) => root),
      );

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return PopScope(
      // The back button belongs to the tab first. Only once a tab is at its
      // root does back mean "leave the app" — otherwise backing out of the
      // seat map would close the whole thing.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final nav = _current;
        if (nav != null && nav.canPop()) {
          nav.pop();
        } else if (_tab != 0) {
          setState(() => _tab = 0);
        } else {
          await SystemNavigator.pop();
        }
      },
      child: Scaffold(
        body: IndexedStack(
          index: _tab,
          children: [
            _tabNavigator(0, const HomeScreen()),
            _tabNavigator(1, const TicketsScreen()),
            _tabNavigator(2, const OffersScreen()),
            _tabNavigator(3, const AccountScreen()),
          ],
        ),
        // The mic lives in the shell rather than on the home screen, which is
        // only possible because the shell is now always on screen. Somebody
        // halfway through choosing a seat can say "the morning one instead"
        // without first finding their way back.
        floatingActionButton: FloatingActionButton(
          heroTag: 'voice',
          // The sheet pushes its follow-on screens into the tab that is on
          // screen, not above the shell — otherwise finishing a spoken booking
          // would lose the bottom bar for the rest of the journey.
          onPressed: () => showVoiceSheet(context, intoTab: () => _current),
          backgroundColor: J.field,
          foregroundColor: Colors.white,
          tooltip: l('vo.title'),
          child: const Icon(Icons.mic),
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _select,
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.search),
              label: l('nav.search'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.confirmation_number_outlined),
              selectedIcon: const Icon(Icons.confirmation_number),
              label: l('nav.tickets'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.local_offer_outlined),
              selectedIcon: const Icon(Icons.local_offer),
              label: l('nav.offers'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.person_outline),
              selectedIcon: const Icon(Icons.person),
              label: l('nav.account'),
            ),
          ],
        ),
      ),
    );
  }
}
