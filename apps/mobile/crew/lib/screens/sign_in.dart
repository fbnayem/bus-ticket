import 'package:flutter/material.dart';
import 'package:jatra_core/jatra_core.dart';

import '../session.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _totp = TextEditingController();

  // The code field appears only once the platform says this account has one.
  // Showing it speculatively asks most people for something they do not have.
  bool _needCode = false;
  bool _busy = false;
  String _error = '';

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _totp.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = '';
    });
    try {
      await SessionScope.of(context).signIn(
        _email.text.trim(),
        _password.text,
        totp: _totp.text.trim(),
      );
    } on ApiError catch (e) {
      setState(() {
        if (e.code == 'mfa_required' || e.code == 'mfa_invalid' || e.code == 'mfa_replayed') {
          _needCode = true;
          _totp.clear();
        }
        _error = e.message;
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L.of(context);
    return Scaffold(
      backgroundColor: J.crew,
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 32, 20, 32),
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(l('app.crew'),
                    style: const TextStyle(
                        color: Colors.white, fontSize: 26, fontWeight: FontWeight.w700)),
                const LanguageToggle(onLight: true),
              ],
            ),
            const SizedBox(height: 6),
            Text(l('cr.signIn'),
                style: const TextStyle(color: J.crewInk, fontSize: 16)),
            const SizedBox(height: 24),
            Container(
              padding: const EdgeInsets.all(18),
              decoration: BoxDecoration(
                color: J.plate,
                borderRadius: BorderRadius.circular(J.radius),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (_error.isNotEmpty) ...[
                    ErrorNotice(_error),
                    const SizedBox(height: 14),
                  ],
                  TextField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autocorrect: false,
                    textCapitalization: TextCapitalization.none,
                    decoration: InputDecoration(labelText: l('cr.email')),
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    decoration: InputDecoration(labelText: l('cr.password')),
                    onSubmitted: (_) => _busy ? null : _submit(),
                  ),
                  if (_needCode) ...[
                    const SizedBox(height: 12),
                    TextField(
                      controller: _totp,
                      keyboardType: TextInputType.number,
                      maxLength: 6,
                      decoration: InputDecoration(
                        labelText: l('cr.code'),
                        counterText: '',
                      ),
                    ),
                  ],
                  const SizedBox(height: 18),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: Text(_busy ? l('cr.signingIn') : l('cr.signIn')),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
