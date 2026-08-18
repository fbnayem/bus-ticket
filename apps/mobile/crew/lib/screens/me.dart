import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

/// The crew member's own account.
///
/// Passengers got all of this a release ago — change your details, change your
/// password, see where you are signed in, sign out everywhere. Staff had none
/// of it, which meant a driver who thought somebody had their phone had no way
/// to act on it except telephoning the office in the morning.
class MeScreen extends StatefulWidget {
  const MeScreen({super.key});

  @override
  State<MeScreen> createState() => _MeScreenState();
}

class _MeScreenState extends State<MeScreen> {
  List<StaffSessionInfo> _sessions = const [];
  String _error = '';
  String _note = '';

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  Future<void> _loadSessions() async {
    final session = SessionScope.read(context);
    try {
      final s = await session.api.sessions();
      if (mounted) setState(() => _sessions = s);
    } on ApiError {
      // A session list that will not load is not worth an error banner over
      // the whole screen. Everything else here still works.
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final session = SessionScope.of(context);
    final me = session.identity;
    if (me == null) return const SizedBox.shrink();

    return Scaffold(
      appBar: AppBar(backgroundColor: J.crew, title: Text(l('me.title'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
        children: [
          if (_error.isNotEmpty) ...[ErrorNotice(_error), const SizedBox(height: 12)],
          if (_note.isNotEmpty) ...[
            Card(
              color: J.okTint,
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle_outline, color: J.ok),
                    const SizedBox(width: 10),
                    Expanded(child: Text(_note)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],

          Card(
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(me.fullName,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  Text(me.email, style: const TextStyle(color: J.muted)),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final r in me.roles) Pill(l('cr.role.$r'))],
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 14),

          _section(l('me.details')),
          Card(
            child: ListTile(
              leading: const Icon(Icons.badge_outlined, color: J.crew),
              title: Text(l('me.details')),
              subtitle: Text(l('me.emailFixed')),
              trailing: const Icon(Icons.chevron_right),
              onTap: _editDetails,
            ),
          ),

          const SizedBox(height: 14),
          _section(l('me.security')),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.lock_outline, color: J.crew),
                  title: Text(l('me.changePassword')),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _changePassword,
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.devices_outlined, color: J.crew),
                  title: Text(l('me.sessions')),
                  subtitle: Text('${_sessions.length}'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _showSessions,
                ),
              ],
            ),
          ),

          const SizedBox(height: 14),
          _section(l('me.language')),
          const Card(
            child: Padding(
              padding: EdgeInsets.all(14),
              child: Align(alignment: Alignment.centerLeft, child: LanguageToggle()),
            ),
          ),

          const SizedBox(height: 22),
          OutlinedButton.icon(
            onPressed: () => session.signOut(),
            icon: const Icon(Icons.logout),
            style: OutlinedButton.styleFrom(
              foregroundColor: J.danger,
              side: const BorderSide(color: J.danger),
              minimumSize: const Size.fromHeight(48),
            ),
            label: Text(l('me.signOut')),
          ),
        ],
      ),
    );
  }

  Widget _section(String s) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 4, 4, 8),
        child: Text(s, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
      );

  Future<void> _editDetails() async {
    final l = L.of(context);
    final session = SessionScope.read(context);
    final me = session.identity;
    if (me == null) return;

    final result = await showDialog<(String, String)>(
      context: context,
      builder: (_) => _TwoFieldDialog(
        title: l('me.details'),
        firstLabel: l('me.name'),
        firstInitial: me.fullName,
        secondLabel: l('me.phone'),
        secondKeyboard: TextInputType.phone,
        confirm: l('me.save'),
      ),
    );
    if (result == null) return;
    try {
      await session.api.updateProfile(fullName: result.$1, phone: result.$2);
      // Re-read rather than assume: the server decides what was accepted.
      await session.restore();
      if (mounted) setState(() => _note = l('me.saved'));
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _changePassword() async {
    final l = L.of(context);
    final session = SessionScope.read(context);

    final result = await showDialog<(String, String)>(
      context: context,
      builder: (_) => _TwoFieldDialog(
        title: l('me.changePassword'),
        firstLabel: l('me.currentPassword'),
        firstObscure: true,
        secondLabel: l('me.newPassword'),
        secondObscure: true,
        confirm: l('me.save'),
      ),
    );
    if (result == null) return;
    try {
      await session.api.changePassword(result.$1, result.$2);
      if (mounted) {
        setState(() {
          _note = l('me.passwordChanged');
          _error = '';
        });
      }
      await _loadSessions();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _showSessions() async {
    final l = L.of(context);
    final session = SessionScope.read(context);
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      backgroundColor: J.plate,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(16),
          children: [
            Text(l('me.sessions'),
                style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            for (final s in _sessions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(s.current ? Icons.smartphone : Icons.devices_other,
                    color: s.current ? J.ok : J.muted),
                title: Text(s.current ? l('me.thisPhone') : (s.userAgent.isEmpty ? '—' : s.userAgent),
                    maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(dateTimeOf(s.issuedAt, l.lang)),
              ),
            const SizedBox(height: 8),
            // Everywhere else, not everywhere: somebody acting on a lost phone
            // should not also lock themselves out of the one in their hand.
            OutlinedButton(
              onPressed: () async {
                Navigator.of(ctx).pop();
                try {
                  await session.api.signOutEverywhereElse();
                  if (mounted) setState(() => _note = l('me.signedOutOthers'));
                  await _loadSessions();
                } on ApiError catch (e) {
                  if (mounted) setState(() => _error = e.message);
                }
              },
              child: Text(l('me.signOutOthers')),
            ),
          ],
        ),
      ),
    );
  }
}

/// Two fields and a confirm, owning its own controllers.
///
/// Creating controllers in the caller and disposing them after `showDialog`
/// returns crashes with `_dependents.isEmpty is not true` — the route is still
/// animating out while its fields are still listening. The dialog has to own
/// them so they die with it.
class _TwoFieldDialog extends StatefulWidget {
  const _TwoFieldDialog({
    required this.title,
    required this.firstLabel,
    required this.secondLabel,
    required this.confirm,
    this.firstInitial = '',
    this.firstObscure = false,
    this.secondObscure = false,
    this.secondKeyboard,
  });

  final String title, firstLabel, secondLabel, confirm, firstInitial;
  final bool firstObscure, secondObscure;
  final TextInputType? secondKeyboard;

  @override
  State<_TwoFieldDialog> createState() => _TwoFieldDialogState();
}

class _TwoFieldDialogState extends State<_TwoFieldDialog> {
  late final _first = TextEditingController(text: widget.firstInitial);
  final _second = TextEditingController();

  @override
  void dispose() {
    _first.dispose();
    _second.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _first,
            obscureText: widget.firstObscure,
            textCapitalization:
                widget.firstObscure ? TextCapitalization.none : TextCapitalization.words,
            decoration: InputDecoration(labelText: widget.firstLabel),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _second,
            obscureText: widget.secondObscure,
            keyboardType: widget.secondKeyboard,
            decoration: InputDecoration(labelText: widget.secondLabel),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l('common.cancel')),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.of(context).pop((_first.text.trim(), _second.text.trim())),
          child: Text(widget.confirm),
        ),
      ],
    );
  }
}
