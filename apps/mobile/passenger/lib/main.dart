import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:local_auth/local_auth.dart';

import 'app_state.dart';
import 'reminders.dart';
import 'screens/account.dart';
import 'screens/home.dart';
import 'screens/offers.dart';
import 'screens/tickets.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final store = await Store.open();
  final reminders = await Reminders.start(store);
  final state = AppState(
    api: PassengerApi(ApiClient()),
    store: store,
    reminders: reminders,
  );
  runApp(PassengerApp(state: state));
}

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
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: const [
          HomeScreen(),
          TicketsScreen(),
          OffersScreen(),
          AccountScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
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
    );
  }
}
