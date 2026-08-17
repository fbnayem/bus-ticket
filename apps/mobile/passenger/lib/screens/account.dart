import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';
import 'package:local_auth/local_auth.dart';

import '../app_state.dart';
import 'ticket.dart';

/// The profile.
///
/// Three states live on this one screen, and keeping them apart is most of the
/// design:
///
///   a stranger      — has never bought anything here. Offered a sign-in, and
///                     told plainly they do not need one to buy a ticket.
///   known           — has bought a ticket on this device. The app greets them
///                     and pre-fills their next checkout, but the platform has
///                     verified nothing, so nothing here reaches account data.
///                     One action turns this into an account.
///   signed in       — verified. Trips from every device, saved companions,
///                     editable details, sessions.
///
/// The middle state is the one worth being careful about. Typing a phone number
/// at checkout is not proof of owning it, and `catalog.saved_passengers` holds
/// NID numbers — so "known" must never be allowed to read anything the platform
/// would only give to a verified account.
class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key});

  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

enum _SignInWith { code, password }

class _AccountScreenState extends State<AccountScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();

  _SignInWith _with = _SignInWith.code;
  bool _codeSent = false;
  bool _busy = false;
  String _error = '';
  String _debugCode = '';

  bool _hasPassword = false;
  List<AccountBooking> _trips = const [];
  List<SavedPassenger> _people = const [];
  List<Map<String, dynamic>> _sessions = const [];
  String? _email;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    final app = AppScope.read(context);
    _phone.text = app.phone ?? '';
    if (app.signedIn) _load();
  }

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _password.dispose();
    super.dispose();
  }

  /// Everything the profile shows that only a verified account may see.
  ///
  /// Each piece is fetched independently and failures are swallowed per piece:
  /// a passenger whose saved-companion list fails to load should still get
  /// their trips, and somebody offline should still get the screen.
  Future<void> _load() async {
    final app = AppScope.read(context);
    if (!app.signedIn) return;
    setState(() => _loading = true);

    try {
      final p = await app.api.profile();
      // The platform's copy of the name wins over the device's, so an edit made
      // on another phone shows up here rather than being quietly overwritten by
      // whatever this device last remembered.
      final name = (p['display_name'] as String?)?.trim() ?? '';
      if (name.isNotEmpty) await app.store.saveSession(name: name);
      if (mounted) {
        setState(() {
          _hasPassword = p['has_password'] == true;
          _email = (p['email'] as String?)?.trim();
        });
      }
    } on ApiError {/* the header falls back to what the device knows */}

    try {
      final r = await app.api.accountBookings();
      final rows = [
        ...(r['upcoming'] as List? ?? const []),
        ...(r['past'] as List? ?? const []),
      ].map((e) => AccountBooking.fromJson(e as Map<String, dynamic>)).toList();
      if (mounted) setState(() => _trips = rows);
    } on ApiError {/* the device's own tickets are shown instead */}

    try {
      final people = await app.api.savedPassengers();
      if (mounted) setState(() => _people = people);
    } on ApiError {/* section simply does not appear */}

    try {
      final s = await app.api.sessions();
      final rows = (s['sessions'] as List? ?? const [])
          .cast<Map<String, dynamic>>()
          .toList(growable: false);
      if (mounted) setState(() => _sessions = rows);
    } on ApiError {/* ditto */}

    if (mounted) setState(() => _loading = false);
  }

  /* ------------------------------------------------------------ signing in */

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
      await _acceptTokens(app, r);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.status == 401 ? L.of(context)('ac.wrongCode') : L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _passwordLogin() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    final app = AppScope.of(context);
    try {
      final r = await app.api.passwordLogin(
        _phone.text.trim(),
        _password.text,
        app.store.deviceRef,
      );
      await _acceptTokens(app, r);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        // The platform answers the same way for "no such account" and "wrong
        // password" on purpose, so this screen must not guess which it was.
        _error = e.status == 401 ? L.of(context)('ac.badLogin') : L.of(context).error(e);
        _busy = false;
      });
    }
  }

  Future<void> _acceptTokens(AppState app, Map<String, dynamic> r) async {
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
      _password.clear();
    });
    await _load();
    if (!mounted) return;
    // Offered, never forced, and only to somebody who has none.
    if (!_hasPassword) await _offerPassword();
  }

  Future<void> _offerPassword() async {
    final l = L.of(context);
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => _PasswordSheet(
        title: l('ac.setPassword'),
        note: l('ac.setPasswordWhy'),
        onSave: (pw) async {
          await AppScope.of(context).api.setPassword(pw);
          if (mounted) setState(() => _hasPassword = true);
        },
      ),
    );
  }

  /* -------------------------------------------------------------- editing */

  Future<void> _editDetails() async {
    final app = AppScope.of(context);
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => _DetailsSheet(
        name: app.displayName ?? '',
        email: _email ?? '',
        onSave: (name, email) => app.api.updateProfile(name: name, email: email),
      ),
    );
    if (saved == true) {
      await _load();
      if (mounted) setState(() {});
    }
  }

  Future<void> _editPerson([SavedPassenger? existing]) async {
    final app = AppScope.of(context);
    final done = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => _PersonSheet(
        person: existing,
        onSave: (p) => existing == null
            ? app.api.addSavedPassenger(p)
            : app.api.updateSavedPassenger(p),
      ),
    );
    if (done == true) await _load();
  }

  Future<void> _removePerson(SavedPassenger p) async {
    try {
      await AppScope.of(context).api.deleteSavedPassenger(p.id);
      await _load();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = L.of(context).error(e));
    }
  }

  /* ----------------------------------------------------------- preferences */

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

  /* ------------------------------------------------------------------ view */

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final app = AppScope.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(app.known || app.signedIn ? l('ac.profile') : l('nav.account')),
        actions: const [
          Padding(
              padding: EdgeInsets.only(right: 12),
              child: Center(child: LanguageToggle(onLight: true))),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 28),
          children: [
            if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

            if (app.signedIn)
              _header(l, app)
            else if (app.known)
              _knownHeader(l, app)
            else
              _signIn(l),

            if (app.signedIn || app.known) ...[
              const SizedBox(height: 18),
              _trips_(l, app),
            ],

            if (app.signedIn) ...[
              const SizedBox(height: 18),
              _companions(l),
              const SizedBox(height: 18),
              _gettingIn(l),
            ],

            const SizedBox(height: 18),
            _prefs(l, app),

            if (app.store.savedRoutes().isNotEmpty) ...[
              const SizedBox(height: 18),
              _sectionTitle(l('ac.savedRoutes')),
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

            if (app.signedIn || app.known) ...[
              const SizedBox(height: 22),
              Center(
                child: TextButton(
                  onPressed: () async {
                    await app.forgetMe();
                    if (mounted) setState(() => _trips = const []);
                  },
                  child: Text(app.signedIn ? l('common.signOut') : l('ac.forgetMe'),
                      style: const TextStyle(color: J.danger)),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(String s) =>
      Text(s, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700));

  /* ---------------------------------------------------------------- header */

  Widget _header(L l, AppState app) => Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const CircleAvatar(
                    radius: 22,
                    backgroundColor: J.fieldTint,
                    child: Icon(Icons.person, color: J.field),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          app.displayName?.isNotEmpty == true
                              ? app.displayName!
                              : (app.phone ?? ''),
                          style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
                        ),
                        if (app.phone != null)
                          Text(app.phone!,
                              style: const TextStyle(
                                  color: J.muted,
                                  fontSize: 14,
                                  fontFeatures: [FontFeature.tabularFigures()])),
                        if (_email != null && _email!.isNotEmpty)
                          Text(_email!,
                              style: const TextStyle(color: J.muted, fontSize: 13)),
                      ],
                    ),
                  ),
                  TextButton(onPressed: _editDetails, child: Text(l('ac.edit'))),
                ],
              ),
            ],
          ),
        ),
      );

  /// Known, not verified. The wording has to carry that difference without
  /// making it sound like a failure.
  Widget _knownHeader(L l, AppState app) => Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const CircleAvatar(
                    radius: 22,
                    backgroundColor: J.fieldTint,
                    child: Icon(Icons.person_outline, color: J.field),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(l('ac.travellingAs'),
                            style: const TextStyle(color: J.muted, fontSize: 12.5)),
                        Text(
                          app.displayName?.isNotEmpty == true
                              ? app.displayName!
                              : (app.phone ?? ''),
                          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                        ),
                        if (app.phone != null)
                          Text(app.phone!,
                              style: const TextStyle(
                                  color: J.muted,
                                  fontSize: 13.5,
                                  fontFeatures: [FontFeature.tabularFigures()])),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(l('ac.onThisPhone'),
                  style: const TextStyle(color: J.muted, fontSize: 13, height: 1.35)),
              const SizedBox(height: 14),
              Text(l('ac.keepWhy'),
                  style: const TextStyle(fontSize: 13.5, height: 1.45, color: J.ink2)),
              const SizedBox(height: 12),
              if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 10)],
              if (!_codeSent)
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () {
                          _phone.text = app.phone ?? '';
                          _sendCode();
                        },
                  child: Text(l('ac.keepEverywhere')),
                )
              else ...[
                Text(l('ac.codeSent', {'phone': _phone.text.trim()}),
                    style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.35)),
                const SizedBox(height: 10),
                _codeField(l),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy ? null : _verify,
                  child: Text(l('ac.verify')),
                ),
              ],
            ],
          ),
        ),
      );

  Widget _codeField(L l) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
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
                    color: J.muted, fontSize: 12, fontFeatures: [FontFeature.tabularFigures()])),
        ],
      );

  /* -------------------------------------------------------------- sign in */

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

              // Two ways in. A code needs no memory and works on a new phone; a
              // password is one step for somebody who comes back often.
              SegmentedButton<_SignInWith>(
                segments: [
                  ButtonSegment(value: _SignInWith.code, label: Text(l('ac.withCode'))),
                  ButtonSegment(value: _SignInWith.password, label: Text(l('ac.withPassword'))),
                ],
                selected: {_with},
                onSelectionChanged: (v) => setState(() {
                  _with = v.first;
                  _codeSent = false;
                  _error = '';
                }),
              ),
              const SizedBox(height: 14),

              if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],

              TextField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                enabled: !_codeSent,
                decoration:
                    InputDecoration(labelText: l('common.phone'), hintText: '01700000000'),
              ),

              if (_with == _SignInWith.password) ...[
                const SizedBox(height: 10),
                TextField(
                  controller: _password,
                  obscureText: true,
                  decoration: InputDecoration(labelText: l('ac.password')),
                  onSubmitted: (_) => _passwordLogin(),
                ),
              ] else if (_codeSent) ...[
                const SizedBox(height: 10),
                Text(l('ac.codeSent', {'phone': _phone.text.trim()}),
                    style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.35)),
                const SizedBox(height: 10),
                _codeField(l),
              ],

              const SizedBox(height: 14),
              FilledButton(
                onPressed: _busy
                    ? null
                    : _with == _SignInWith.password
                        ? _passwordLogin
                        : (_codeSent ? _verify : _sendCode),
                child: Text(_with == _SignInWith.password
                    ? l('ac.verify')
                    : (_codeSent ? l('ac.verify') : l('ac.sendCode'))),
              ),
            ],
          ),
        ),
      );

  /* ---------------------------------------------------------------- trips */

  Widget _trips_(L l, AppState app) {
    // Signed in: everything on this number from any device. Known only: what
    // this device itself holds, and it says which so nobody thinks a trip is
    // missing.
    final fromServer = app.signedIn && _trips.isNotEmpty;
    final upcoming = _trips.where((t) => t.upcoming).toList(growable: false);
    final past = _trips.where((t) => !t.upcoming).toList(growable: false);
    final cached = app.tickets;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: _sectionTitle(l('ac.myTrips'))),
            if (_loading)
              const SizedBox(
                  width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2)),
          ],
        ),
        if (!app.signedIn)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(l('ac.fromThisPhone'),
                style: const TextStyle(color: J.muted, fontSize: 12.5, height: 1.35)),
          ),
        const SizedBox(height: 8),
        if (!fromServer && cached.isEmpty)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Text(l('ac.noTrips'), style: const TextStyle(color: J.muted)),
            ),
          )
        else if (!fromServer)
          Card(
            child: Column(
              children: [
                for (final b in cached)
                  ListTile(
                    onTap: () => _openTrip(b.pnr),
                    leading: const Icon(Icons.confirmation_number_outlined, color: J.muted),
                    title: Text('${b.origin} → ${b.destination}'),
                    subtitle: Text(dateTimeOf(b.departAt, l.lang),
                        style: const TextStyle(fontSize: 12.5)),
                    trailing: Text(b.pnr,
                        style: const TextStyle(
                            fontSize: 12.5,
                            color: J.muted,
                            fontFeatures: [FontFeature.tabularFigures()])),
                  ),
              ],
            ),
          )
        else ...[
          if (upcoming.isNotEmpty) ...[
            _subTitle(l('ac.upcoming')),
            _tripCard(l, upcoming),
            const SizedBox(height: 12),
          ],
          if (past.isNotEmpty) ...[
            _subTitle(l('ac.past')),
            _tripCard(l, past),
          ],
        ],
      ],
    );
  }

  Widget _subTitle(String s) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Text(s,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: J.muted)),
      );

  Widget _tripCard(L l, List<AccountBooking> rows) => Card(
        child: Column(
          children: [
            for (final t in rows)
              ListTile(
                onTap: () => _openTrip(t.pnr),
                leading: Icon(
                  t.upcoming ? Icons.directions_bus : Icons.history,
                  color: t.upcoming ? J.field : J.muted,
                ),
                title: Text('${t.origin} → ${t.destination}'),
                subtitle: Text(
                  '${t.brand} · ${dateTimeOf(t.departAt, l.lang)}',
                  style: const TextStyle(fontSize: 12.5),
                ),
                trailing: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(taka(t.totalPoisha),
                        style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontFeatures: [FontFeature.tabularFigures()])),
                    Text(t.pnr,
                        style: const TextStyle(
                            fontSize: 11.5,
                            color: J.muted,
                            fontFeatures: [FontFeature.tabularFigures()])),
                  ],
                ),
              ),
          ],
        ),
      );

  /// The ticket screen reads its own booking from the PNR, device cache first,
  /// so an old trip opens with no signal the same way a new one does.
  void _openTrip(String pnr) {
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => TicketScreen(pnr: pnr)));
  }

  /* ----------------------------------------------------------- companions */

  Widget _companions(L l) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _sectionTitle(l('ac.companions')),
          const SizedBox(height: 4),
          Text(l('ac.companionsWhy'),
              style: const TextStyle(color: J.muted, fontSize: 12.5, height: 1.35)),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                for (final p in _people)
                  ListTile(
                    onTap: () => _editPerson(p),
                    leading: const Icon(Icons.person_outline, color: J.muted),
                    title: Text(p.fullName),
                    subtitle: _personLine(p) == null
                        ? null
                        : Text(_personLine(p)!, style: const TextStyle(fontSize: 12.5)),
                    trailing: IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      tooltip: l('ac.remove'),
                      onPressed: () => _removePerson(p),
                    ),
                  ),
                ListTile(
                  onTap: () => _editPerson(),
                  leading: const Icon(Icons.add, color: J.field),
                  title: Text(l('ac.addPerson'),
                      style: const TextStyle(color: J.field, fontWeight: FontWeight.w600)),
                ),
              ],
            ),
          ),
        ],
      );

  String? _personLine(SavedPassenger p) {
    final bits = <String>[
      if (p.age > 0) '${p.age}',
      if (p.idNumber.isNotEmpty) '${p.idType.isEmpty ? 'ID' : p.idType} ${p.idNumber}',
    ];
    return bits.isEmpty ? null : bits.join(' · ');
  }

  /* ----------------------------------------------------------- getting in */

  Widget _gettingIn(L l) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _sectionTitle(l('ac.gettingIn')),
          const SizedBox(height: 8),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.key_outlined, color: J.muted),
                  title: Text(_hasPassword ? l('ac.changePassword') : l('ac.setPassword')),
                  subtitle: _hasPassword
                      ? null
                      : Text(l('ac.setPasswordWhy'),
                          style: const TextStyle(fontSize: 12.5, height: 1.35)),
                  trailing: const Icon(Icons.chevron_right, color: J.muted),
                  onTap: _offerPassword,
                ),
                if (_sessions.isNotEmpty) ...[
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.devices_outlined, color: J.muted),
                    title: Text(l('ac.devices')),
                    subtitle: Text('${_sessions.length}',
                        style: const TextStyle(
                            fontSize: 12.5, fontFeatures: [FontFeature.tabularFigures()])),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.logout, color: J.danger),
                    title: Text(l('ac.signOutEverywhere'),
                        style: const TextStyle(color: J.danger)),
                    onTap: () async {
                      try {
                        await AppScope.of(context).api.revokeAllSessions();
                        await _load();
                      } on ApiError catch (e) {
                        if (mounted) setState(() => _error = L.of(context).error(e));
                      }
                    },
                  ),
                ],
              ],
            ),
          ),
        ],
      );

  /* ---------------------------------------------------------- preferences */

  Widget _prefs(L l, AppState app) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _sectionTitle(l('ac.preferences')),
          const SizedBox(height: 8),
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
        ],
      );
}

/* ------------------------------------------------------------------ sheets */

class _PasswordSheet extends StatefulWidget {
  const _PasswordSheet({required this.title, required this.note, required this.onSave});
  final String title, note;
  final Future<void> Function(String password) onSave;

  @override
  State<_PasswordSheet> createState() => _PasswordSheetState();
}

class _PasswordSheetState extends State<_PasswordSheet> {
  final _pw = TextEditingController();
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    _pw.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final l = L.of(context);
    if (_pw.text.length < 8) {
      setState(() => _error = l('ac.passwordShort'));
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.onSave(_pw.text);
      if (mounted) Navigator.of(context).pop();
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = L.of(context).error(e);
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return _SheetFrame(
      title: widget.title,
      children: [
        Text(widget.note, style: const TextStyle(color: J.muted, fontSize: 13.5, height: 1.4)),
        const SizedBox(height: 14),
        if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 10)],
        TextField(
          controller: _pw,
          obscureText: true,
          autofocus: true,
          decoration: InputDecoration(labelText: l('ac.newPassword')),
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _save, child: Text(l('common.save'))),
      ],
    );
  }
}

class _DetailsSheet extends StatefulWidget {
  const _DetailsSheet({required this.name, required this.email, required this.onSave});
  final String name, email;
  final Future<void> Function(String name, String email) onSave;

  @override
  State<_DetailsSheet> createState() => _DetailsSheetState();
}

class _DetailsSheetState extends State<_DetailsSheet> {
  late final _name = TextEditingController(text: widget.name);
  late final _email = TextEditingController(text: widget.email);
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.onSave(_name.text.trim(), _email.text.trim());
      if (mounted) Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = L.of(context).error(e);
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return _SheetFrame(
      title: l('ac.yourDetails'),
      children: [
        if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 10)],
        TextField(
          controller: _name,
          textCapitalization: TextCapitalization.words,
          decoration: InputDecoration(labelText: l('ac.name')),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          decoration: InputDecoration(labelText: l('ac.emailOptional')),
        ),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _save, child: Text(l('common.save'))),
      ],
    );
  }
}

class _PersonSheet extends StatefulWidget {
  const _PersonSheet({required this.person, required this.onSave});
  final SavedPassenger? person;
  final Future<void> Function(SavedPassenger p) onSave;

  @override
  State<_PersonSheet> createState() => _PersonSheetState();
}

class _PersonSheetState extends State<_PersonSheet> {
  late final _name = TextEditingController(text: widget.person?.fullName ?? '');
  late final _age = TextEditingController(
      text: (widget.person?.age ?? 0) > 0 ? '${widget.person!.age}' : '');
  late final _idNo = TextEditingController(text: widget.person?.idNumber ?? '');
  late String _gender = widget.person?.gender ?? '';
  String _error = '';
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _age.dispose();
    _idNo.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final l = L.of(context);
    if (_name.text.trim().isEmpty) {
      setState(() => _error = l('pax.needName'));
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await widget.onSave(SavedPassenger(
        id: widget.person?.id ?? '',
        fullName: _name.text.trim(),
        gender: _gender,
        age: int.tryParse(_age.text.trim()) ?? 0,
        idType: _idNo.text.trim().isEmpty ? '' : 'NID',
        idNumber: _idNo.text.trim(),
      ));
      if (mounted) Navigator.of(context).pop(true);
    } on ApiError catch (e) {
      if (mounted) {
        setState(() {
          _error = L.of(context).error(e);
          _busy = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return _SheetFrame(
      title: widget.person == null ? l('ac.addPerson') : l('ac.companions'),
      children: [
        if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 10)],
        TextField(
          controller: _name,
          autofocus: true,
          textCapitalization: TextCapitalization.words,
          decoration: InputDecoration(labelText: l('pax.name')),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: SegmentedButton<String>(
                segments: [
                  ButtonSegment(value: 'M', label: Text(l('pax.male'))),
                  ButtonSegment(value: 'F', label: Text(l('pax.female'))),
                ],
                selected: {_gender.isEmpty ? 'M' : _gender},
                onSelectionChanged: (v) => setState(() => _gender = v.first),
              ),
            ),
            const SizedBox(width: 10),
            SizedBox(
              width: 84,
              child: TextField(
                controller: _age,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(labelText: l('pax.age')),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _idNo,
          keyboardType: TextInputType.number,
          decoration: InputDecoration(labelText: l('ac.idNumber')),
        ),
        const SizedBox(height: 16),
        FilledButton(onPressed: _busy ? null : _save, child: Text(l('common.save'))),
      ],
    );
  }
}

/// The chrome every sheet on this screen shares: a title, a close, and room for
/// the keyboard that is about to cover half the phone.
class _SheetFrame extends StatelessWidget {
  const _SheetFrame({required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(title,
                        style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                    tooltip: l('common.close'),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}
