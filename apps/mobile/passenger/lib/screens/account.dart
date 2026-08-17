import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:local_auth/local_auth.dart';

import '../app_state.dart';

/// The account, and the two switches that make this an app rather than a
/// bookmark.
///
/// Signing in is optional and says so. Guest checkout is the platform's default
/// path and stays the default here — a shopkeeper buying a ticket for a
/// customer should not have to make an account first, and a screen that implies
/// otherwise loses the sale.
class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key});

  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();

  bool _codeSent = false;
  bool _busy = false;
  String _error = '';
  String _debugCode = '';

  @override
  void initState() {
    super.initState();
    _phone.text = AppScope.read(context).phone ?? '';
  }

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _sendCode() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      final r = await AppScope.of(context).api.requestOtp(_phone.text.trim());
      if (!mounted) return;
      setState(() {
        _codeSent = true;
        _busy = false;
        // Only ever present when the platform is running with SHOW_OTP on,
        // which is a local-build setting. In production this is absent and the
        // code arrives by SMS.
        _debugCode = '${r['debug_code'] ?? ''}';
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _verify() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final app = AppScope.of(context);
    try {
      final r = await app.api.verifyOtp(
        _phone.text.trim(),
        _code.text.trim(),
        app.store.deviceRef,
      );
      final identity = r['identity'] as Map<String, dynamic>?;
      await app.signedInAs(
        token: '${r['access_token']}',
        refresh: r['refresh_token'] as String?,
        phone: '${identity?['phone'] ?? _phone.text.trim()}',
        name: identity?['display_name'] as String?,
      );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _codeSent = false;
        _code.clear();
      });
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.status == 401 ? L.of(context)('ac.wrongCode') : L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _toggleBiometric(bool on) async {
    final app = AppScope.of(context);
    // Read before any await: the prompt below is shown by the operating system
    // and can sit there for as long as somebody stares at it.
    final reason = L.of(context)('ac.biometricPrompt');
    if (!on) {
      await app.store.setBiometric(false);
      if (mounted) setState(() {});
      return;
    }
    final auth = LocalAuthentication();
    try {
      final can = await auth.canCheckBiometrics || await auth.isDeviceSupported();
      if (!can) return;
      final ok = await auth.authenticate(
        localizedReason: reason,
        options: const AuthenticationOptions(stickyAuth: true, biometricOnly: false),
      );
      if (ok) await app.store.setBiometric(true);
    } catch (_) {
      // No enrolled biometric, or the platform refused. The switch simply does
      // not turn on; nothing is broken and nothing needs explaining.
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggleReminders(bool on) async {
    final app = AppScope.of(context);
    if (on) {
      final granted = await app.reminders.askPermission();
      if (!granted) return;
      await app.store.setReminders(true);
      // Schedule for what is already in the pocket, not only for what is bought
      // next — otherwise turning this on appears to do nothing.
      for (final b in app.tickets) {
        if (b.confirmed) await app.reminders.scheduleFor(b);
      }
    } else {
      await app.store.setReminders(false);
      await app.reminders.cancelAll();
    }
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final app = AppScope.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(l('nav.account')),
        actions: const [
          Padding(padding: EdgeInsets.only(right: 12), child: Center(child: LanguageToggle(onLight: true))),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
        children: [
          if (app.signedIn) _signedIn(l, app) else _signIn(l),
          const SizedBox(height: 18),

          Card(
            child: Column(
              children: [
                SwitchListTile(
                  value: app.store.remindersOn,
                  onChanged: _toggleReminders,
                  activeThumbColor: J.field,
                  title: Text(l('ac.reminders'),
                      style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
                  subtitle: Text(l('ac.remindersOn'),
                      style: const TextStyle(fontSize: 13, height: 1.35)),
                ),
                const Divider(height: 1),
                SwitchListTile(
                  value: app.store.biometricOn,
                  onChanged: _toggleBiometric,
                  activeThumbColor: J.field,
                  title: Text(l('ac.biometric'),
                      style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600)),
                  subtitle: app.store.biometricOn
                      ? Text(l('ac.biometricOn'),
                          style: const TextStyle(fontSize: 13, height: 1.35))
                      : null,
                ),
              ],
            ),
          ),

          if (app.store.savedRoutes().isNotEmpty) ...[
            const SizedBox(height: 18),
            Text(l('ac.savedRoutes'),
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Card(
              child: Column(
                children: [
                  for (final r in app.store.savedRoutes())
                    ListTile(
                      leading: const Icon(Icons.directions_bus_outlined, color: J.muted),
                      title: Text('${r.from} → ${r.to}'),
                      trailing: IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () => app.forgetRoute(r.from, r.to),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _signedIn(L l, AppState app) => Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(app.displayName?.isNotEmpty == true ? app.displayName! : (app.phone ?? ''),
                  style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
              if (app.displayName?.isNotEmpty == true && app.phone != null)
                Text(app.phone!,
                    style: const TextStyle(
                        color: J.muted,
                        fontSize: 14,
                        fontFeatures: [FontFeature.tabularFigures()])),
              const SizedBox(height: 14),
              OutlinedButton(
                onPressed: () async {
                  await app.signOut();
                  if (mounted) setState(() {});
                },
                child: Text(l('common.signOut')),
              ),
            ],
          ),
        ),
      );

  Widget _signIn(L l) => Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l('ac.signIn'),
                  style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
              const SizedBox(height: 6),
              Text(l('ac.signInWhy'),
                  style: const TextStyle(color: J.muted, fontSize: 14, height: 1.45)),
              const SizedBox(height: 16),
              if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                enabled: !_codeSent,
                decoration: InputDecoration(labelText: l('common.phone'), hintText: '01700000000'),
              ),
              if (_codeSent) ...[
                const SizedBox(height: 10),
                Text(l('ac.codeSent', {'phone': _phone.text.trim()}),
                    style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.35)),
                const SizedBox(height: 10),
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofocus: true,
                  decoration: InputDecoration(labelText: l('ac.code'), counterText: ''),
                  style: const TextStyle(
                      fontSize: 22, letterSpacing: 5, fontFeatures: [FontFeature.tabularFigures()]),
                ),
                if (_debugCode.isNotEmpty)
                  Text(_debugCode,
                      style: const TextStyle(
                          color: J.muted,
                          fontSize: 12,
                          fontFeatures: [FontFeature.tabularFigures()])),
              ],
              const SizedBox(height: 14),
              FilledButton(
                onPressed: _busy ? null : (_codeSent ? _verify : _sendCode),
                child: Text(_codeSent ? l('ac.verify') : l('ac.sendCode')),
              ),
            ],
          ),
        ),
      );
}
