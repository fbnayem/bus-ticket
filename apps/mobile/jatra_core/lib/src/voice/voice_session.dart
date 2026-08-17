import 'dart:async';

import 'package:flutter_tts/flutter_tts.dart';
import 'package:speech_to_text/speech_to_text.dart';

import 'intent.dart';

/// The microphone and the voice, wrapped thinly.
///
/// Everything that decides anything lives in `intent.dart`, which is pure Dart
/// and tested. This file only does the two things that need a device: hear, and
/// speak. Keeping the split sharp is what makes the feature testable at all —
/// a microphone cannot be driven in CI, and speech recognition is somebody
/// else's software.
///
/// Recognition is the phone's own engine. Nothing spoken is sent anywhere by
/// this app, and the Bangla model is whichever one the handset already carries
/// — which is also why [bestLocale] has to be asked rather than assumed. Plenty
/// of cheap Android handsets in this market have no Bangla recogniser at all,
/// and a feature that silently listens in the wrong language is worse than one
/// that says it cannot.
class VoiceSession {
  VoiceSession({SpeechToText? speech, FlutterTts? tts})
      : _speech = speech ?? SpeechToText(),
        _tts = tts ?? FlutterTts();

  final SpeechToText _speech;
  final FlutterTts _tts;

  bool _ready = false;
  String _locale = '';

  bool get ready => _ready;
  bool get listening => _speech.isListening;

  /// The locale recognition will actually run in. Empty until [start].
  String get locale => _locale;

  /// True when the phone can hear Bangla. When false the app still works, in
  /// English, and says so rather than pretending.
  bool get bangla => _locale.toLowerCase().startsWith('bn');

  /// Asks for the microphone and works out which language this phone can hear.
  ///
  /// Returns false when permission is refused or no engine exists. The caller
  /// must treat that as "voice is unavailable on this phone" and keep every
  /// tap-driven path working — voice is an addition to this app, never a
  /// requirement of it.
  Future<bool> start({bool preferBangla = true}) async {
    if (_ready) return true;
    try {
      _ready = await _speech.initialize(
        onError: (_) {},
        onStatus: (_) {},
        debugLogging: false,
      );
    } catch (_) {
      _ready = false;
    }
    if (!_ready) return false;

    _locale = await _pickLocale(preferBangla);
    try {
      await _tts.setLanguage(bangla ? 'bn-BD' : 'en-US');
      await _tts.setSpeechRate(0.45); // the default gabbles in both languages
      await _tts.awaitSpeakCompletion(true);
    } catch (_) {
      // Speaking is a courtesy. A phone with no voice for this language still
      // gets every read-back on screen, which is where the binding one lives.
    }
    return true;
  }

  Future<String> _pickLocale(bool preferBangla) async {
    try {
      final locales = await _speech.locales();
      if (preferBangla) {
        for (final l in locales) {
          if (l.localeId.toLowerCase().startsWith('bn')) return l.localeId;
        }
      }
      for (final l in locales) {
        if (l.localeId.toLowerCase().startsWith('en')) return l.localeId;
      }
      final system = await _speech.systemLocale();
      return system?.localeId ?? '';
    } catch (_) {
      return '';
    }
  }

  /// Listens once and returns what was understood.
  ///
  /// Always completes: a phone that hears nothing returns [VoiceAction.none]
  /// rather than leaving the caller waiting, because the screen that asked has
  /// a countdown on it.
  Future<VoiceIntent> listenOnce({
    Duration limit = const Duration(seconds: 7),
    void Function(String partial)? onPartial,
    DateTime? now,
  }) async {
    if (!_ready && !await start()) return const VoiceIntent.none('');

    final done = Completer<String>();
    var last = '';

    try {
      await _speech.listen(
        listenOptions: SpeechListenOptions(
          localeId: _locale.isEmpty ? null : _locale,
          listenMode: ListenMode.dictation,
          partialResults: true,
          cancelOnError: true,
          listenFor: limit,
          // Three seconds of quiet ends the turn. Longer and the app feels
          // deaf; shorter and it cuts people off mid-place-name.
          pauseFor: const Duration(seconds: 3),
        ),
        onResult: (r) {
          last = r.recognizedWords;
          onPartial?.call(last);
          if (r.finalResult && !done.isCompleted) done.complete(last);
        },
      );
    } catch (_) {
      return const VoiceIntent.none('');
    }

    // The engine does not always deliver a final result — a silent room can
    // leave it listening until the limit. Whatever partial text exists at that
    // point is still the best answer available.
    final heard = await done.future.timeout(
      limit + const Duration(seconds: 2),
      onTimeout: () => last,
    );
    await stop();
    return parseVoice(heard, now: now ?? DateTime.now());
  }

  Future<void> stop() async {
    try {
      await _speech.stop();
    } catch (_) {/* already stopped */}
  }

  Future<void> cancel() async {
    try {
      await _speech.cancel();
    } catch (_) {/* already cancelled */}
  }

  /// Reads a line out. Never used for anything secret: no PIN, no one-time
  /// code, no card number is ever passed to this.
  Future<void> say(String text) async {
    if (text.trim().isEmpty) return;
    try {
      await _tts.stop();
      await _tts.speak(text);
    } catch (_) {/* silent phone; the screen still says it */}
  }

  Future<void> hush() async {
    try {
      await _tts.stop();
    } catch (_) {}
  }

  Future<void> dispose() async {
    await cancel();
    await hush();
  }
}
