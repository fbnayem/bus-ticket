import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:jatra_core/jatra_core.dart';

import 'boarding.dart';
import 'screens/sign_in.dart';
import 'screens/me.dart';
import 'screens/money.dart';
import 'screens/sell.dart';
import 'screens/trips.dart';
import 'session.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await Store.open();
  final client = ApiClient();
  final session = Session(api: CrewApi(client), store: store);
  runApp(CrewApp(session: session, store: store));
}

class CrewApp extends StatefulWidget {
  const CrewApp({super.key, required this.session, required this.store});

  final Session session;
  final Store store;

  @override
  State<CrewApp> createState() => _CrewAppState();
}

class _CrewAppState extends State<CrewApp> {
  late Lang _lang = widget.store.lang;
  late final Boarding _boarding =
      Boarding(api: widget.session.api, store: widget.store);

  @override
  void initState() {
    super.initState();
    widget.session.restore();
  }

  void _setLang(Lang l) {
    setState(() => _lang = l);
    widget.store.setLang(l);
  }

  @override
  Widget build(BuildContext context) {
    return LangScope(
      lang: _lang,
      setLang: _setLang,
      child: SessionScope(
        session: widget.session,
        child: MaterialApp(
          title: 'Jatra Crew',
          debugShowCheckedModeBanner: false,
          // The crew's own chrome: graphite. Every workplace on this platform
          // has a colour of its own, and this one has to stay legible on a
          // cheap screen held at arm's length in daylight.
          theme: jatraTheme(seed: J.crew),
          home: _Root(boarding: _boarding),
          builder: (context, child) => MediaQuery.withClampedTextScaling(
            // Honour the reader's own text size, up to a point that still lets
            // a seat number and a verdict share a screen.
            minScaleFactor: 1.0,
            maxScaleFactor: 1.35,
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      ),
    );
  }
}

class _Root extends StatelessWidget {
  const _Root({required this.boarding});

  final Boarding boarding;

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.of(context);
    // A blank field-coloured screen rather than a spinner: this state lasts as
    // long as one request to /staff/me, and a spinner that flashes for 200ms
    // reads as a stutter rather than as progress.
    if (!session.ready) {
      return const Scaffold(backgroundColor: J.crew, body: SizedBox.shrink());
    }
    if (!session.signedIn) return const SignInScreen();
    return CrewShell(boarding: boarding);
  }
}

/// Four places a crew member goes, and no more.
///
/// The trip in front of them, selling a seat on it, the money that came of it,
/// and their own account. A fifth would have to displace one of those.
///
/// Each tab owns a Navigator rather than sharing the root one, which is what
/// keeps the bottom bar painted while somebody is deep inside a sale. The
/// passenger app learned this the hard way a release ago: pushes went to the
/// navigator ABOVE the Scaffold, so every screen past the first covered the
/// bar, and the app lost its navigation exactly when somebody was furthest
/// into it.
///
/// The screens themselves needed no change for this. Navigator.of(context)
/// resolves to the nearest navigator, which is now the tab's own.
class CrewShell extends StatefulWidget {
  const CrewShell({super.key, required this.boarding});
  final Boarding boarding;

  @override
  State<CrewShell> createState() => CrewShellState();
}

class CrewShellState extends State<CrewShell> {
  int _tab = 0;

  static const _tabs = 4;
  final _navs = List.generate(_tabs, (_) => GlobalKey<NavigatorState>());

  /// Which tab is on screen, for the tabs that need to know.
  ///
  /// An IndexedStack keeps every tab alive, so initState runs once and never
  /// again. That is what makes switching tabs instant, and it is also why the
  /// money screen sat there showing zero takings straight after a sale: the
  /// numbers were fetched when the app started and nothing asked for them
  /// again. Screens whose content can go stale while somebody is on another
  /// tab listen to this and reload when they are shown.
  final _shown = ValueNotifier<int>(0);

  @override
  void dispose() {
    _shown.dispose();
    super.dispose();
  }

  NavigatorState? get _current => _navs[_tab].currentState;

  void _select(int i) {
    // Tapping the tab you are already on pops it back to its root: the way out
    // of a half-finished sale that is not pressing back four times.
    if (i == _tab) {
      _current?.popUntil((r) => r.isFirst);
      _shown.value = i;
      return;
    }
    setState(() => _tab = i);
    _shown.value = i;
  }

  Widget _tabNavigator(int i, Widget root) => Navigator(
        key: _navs[i],
        onGenerateRoute: (settings) =>
            MaterialPageRoute(settings: settings, builder: (_) => root),
      );

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final session = SessionScope.of(context);
    // Selling is a permission, not a given. A crew member whose operator has
    // not granted it never sees the tab — and the server would refuse the sale
    // anyway, which is what actually stops them.
    final maySell = session.identity?.can('crew.sell') ?? false;

    return PopScope(
      // Back belongs to the tab first. Only once a tab is at its root does back
      // mean leave the app, otherwise backing out of a seat map would close
      // everything mid-sale.
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
            _tabNavigator(0, TripsScreen(boarding: widget.boarding)),
            _tabNavigator(1, SellScreen(shown: _shown, index: 1)),
            _tabNavigator(2, MoneyScreen(shown: _shown, index: 2)),
            _tabNavigator(3, const MeScreen()),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _select,
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.directions_bus_outlined),
              selectedIcon: const Icon(Icons.directions_bus),
              label: l('nav.trips'),
            ),
            NavigationDestination(
              icon: Icon(maySell ? Icons.confirmation_number_outlined : Icons.lock_outline),
              selectedIcon: const Icon(Icons.confirmation_number),
              label: l('nav.sell'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.account_balance_wallet_outlined),
              selectedIcon: const Icon(Icons.account_balance_wallet),
              label: l('nav.money'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.person_outline),
              selectedIcon: const Icon(Icons.person),
              label: l('nav.me'),
            ),
          ],
        ),
      ),
    );
  }
}
