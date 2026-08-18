import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:jatra_core/jatra_core.dart';

import 'owner_api.dart';
import 'screens/costs.dart';
import 'screens/me.dart';
import 'screens/pnl.dart';
import 'screens/sign_in.dart';
import 'screens/staff_sales.dart';
import 'session.dart';

Future<void> main() async {
  final client = ApiClient();
  // Everything happens inside the crash guard, start-up included: a crash while
  // opening the store is a sentence and a report, not a black screen.
  await CrashGuard(app: 'owner', client: client, version: kAppVersion).run(() async {
    WidgetsFlutterBinding.ensureInitialized();
    final store = await Store.open();
    CrashGuard.lang = store.lang;
    final session = Session(api: OwnerApi(client), store: store);
    runApp(OwnerApp(session: session, store: store));
  });
}

/// Reported with every crash, so a bug is tied to a release, not to "the
/// version that was on the phone in August".
const kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: 'dev');

class OwnerApp extends StatefulWidget {
  const OwnerApp({super.key, required this.session, required this.store});

  final Session session;
  final Store store;

  @override
  State<OwnerApp> createState() => _OwnerAppState();
}

class _OwnerAppState extends State<OwnerApp> {
  late Lang _lang = widget.store.lang;

  @override
  void initState() {
    super.initState();
    widget.session.restore();
  }

  void _setLang(Lang l) {
    setState(() => _lang = l);
    widget.store.setLang(l);
    CrashGuard.lang = l;
  }

  @override
  Widget build(BuildContext context) {
    return LangScope(
      lang: _lang,
      setLang: _setLang,
      child: SessionScope(
        session: widget.session,
        child: MaterialApp(
          title: 'Jatra Owner',
          debugShowCheckedModeBanner: false,
          theme: jatraTheme(seed: J.owner),
          home: const _Root(),
          builder: (context, child) => MediaQuery.withClampedTextScaling(
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
  const _Root();

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.of(context);
    if (!session.ready) {
      return const Scaffold(backgroundColor: J.owner, body: SizedBox.shrink());
    }
    if (!session.signedIn) return const SignInScreen();
    return const OwnerShell();
  }
}

/// Four places an owner goes: the profit, who earned it, what it cost, and
/// their own account. The same nested-Navigator-per-tab shape the crew and
/// passenger apps use, so the bottom bar stays painted however deep a report is.
class OwnerShell extends StatefulWidget {
  const OwnerShell({super.key});

  @override
  State<OwnerShell> createState() => OwnerShellState();
}

class OwnerShellState extends State<OwnerShell> {
  int _tab = 0;

  static const _tabs = 4;
  final _navs = List.generate(_tabs, (_) => GlobalKey<NavigatorState>());

  /// Which tab is on screen, so a report can reload when it is shown again
  /// rather than sitting on numbers fetched at launch.
  final _shown = ValueNotifier<int>(0);

  @override
  void dispose() {
    _shown.dispose();
    super.dispose();
  }

  NavigatorState? get _current => _navs[_tab].currentState;

  void _select(int i) {
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

    return PopScope(
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
            _tabNavigator(0, PnlScreen(shown: _shown, index: 0)),
            _tabNavigator(1, StaffSalesScreen(shown: _shown, index: 1)),
            _tabNavigator(2, CostsScreen(shown: _shown, index: 2)),
            _tabNavigator(3, const MeScreen()),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _tab,
          onDestinationSelected: _select,
          destinations: [
            NavigationDestination(
              icon: const Icon(Icons.trending_up_outlined),
              selectedIcon: const Icon(Icons.trending_up),
              label: l('nav.pnl'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.groups_outlined),
              selectedIcon: const Icon(Icons.groups),
              label: l('nav.staff'),
            ),
            NavigationDestination(
              icon: const Icon(Icons.receipt_long_outlined),
              selectedIcon: const Icon(Icons.receipt_long),
              label: l('nav.costs'),
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
