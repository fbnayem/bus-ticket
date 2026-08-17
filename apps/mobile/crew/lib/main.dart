import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import 'boarding.dart';
import 'screens/sign_in.dart';
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
          home: const _Root(),
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
  const _Root();

  @override
  Widget build(BuildContext context) {
    final session = SessionScope.of(context);
    if (!session.ready) {
      return const Scaffold(backgroundColor: J.crew, body: SizedBox.shrink());
    }
    if (!session.signedIn) return const SignInScreen();

    final app = context.findAncestorStateOfType<_CrewAppState>()!;
    return TripsScreen(boarding: app._boarding);
  }
}
