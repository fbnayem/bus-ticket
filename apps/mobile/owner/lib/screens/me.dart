import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

/// The owner's own account: who they are, the language the app speaks, and the
/// way out. Deliberately spare — the owner app exists to read the fleet, not to
/// administer people; staff and roles are managed in the web ERP.
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    final session = SessionScope.of(context);
    final me = session.identity;
    if (me == null) return const SizedBox.shrink();

    return Scaffold(
      appBar: AppBar(backgroundColor: J.owner, title: Text(l('me.title'))),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(14, 14, 14, 32),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: J.plate,
              borderRadius: BorderRadius.circular(J.radius),
              border: Border.all(color: J.rule),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(me.fullName,
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(me.email, style: const TextStyle(color: J.muted)),
                const Divider(height: 22),
                KeyValue(l('me.role'), _roles(me.roles)),
              ],
            ),
          ),
          const SizedBox(height: 18),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(l('common.language'), style: const TextStyle(fontWeight: FontWeight.w600)),
              const LanguageToggle(),
            ],
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: () => session.signOut(),
            icon: const Icon(Icons.logout, color: J.danger),
            label: Text(l('me.signOut'), style: const TextStyle(color: J.danger)),
            style: OutlinedButton.styleFrom(side: const BorderSide(color: J.danger)),
          ),
        ],
      ),
    );
  }

  static const _roleLabel = {
    'OPERATOR_OWNER': 'Owner', 'OPERATOR_MANAGER': 'Manager', 'ACCOUNTANT': 'Accountant',
  };

  String _roles(List<String> roles) =>
      roles.map((r) => _roleLabel[r] ?? r).join(', ');
}
