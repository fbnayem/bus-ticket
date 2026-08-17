import 'package:flutter/material.dart';

/// The same painted-board palette the web product uses, carried over token for
/// token so a passenger who books on the site and opens the app does not feel
/// they have changed companies.
///
/// Two things are deliberate and worth not "fixing" later:
///
///   The corner radius is 4, not 16. A painted enamel plate has a small radius;
///   a large one reads as a SaaS dashboard, which this is not.
///
///   Separation is a drawn rule plus ground, not a shadow. Elevation is kept
///   for things that genuinely float, so it still means something when it
///   appears. A 1px hairline also vanishes on a cheap Android LCD in daylight,
///   which is the screen this is actually used on, so the rules are heavier
///   than a desktop design would choose.
abstract final class J {
  static const field = Color(0xFF0B4A38);
  static const field600 = Color(0xFF0E5B45);
  static const fieldTint = Color(0xFFE3EDE8);

  static const mark = Color(0xFFFFB300);
  static const mark600 = Color(0xFFE8A200);
  static const markInk = Color(0xFF1E1500);
  static const markTint = Color(0xFFFFF4DA);

  static const ground = Color(0xFFEEF1EC);
  static const plate = Color(0xFFFFFFFF);
  static const plate2 = Color(0xFFF6F8F5);

  static const ink = Color(0xFF10201A);
  static const ink2 = Color(0xFF37473F);
  static const muted = Color(0xFF64726A);

  static const rule = Color(0xFFC9D0C6);
  static const ruleStrong = Color(0xFF9FAC9B);

  static const ok = Color(0xFF0F7A4E);
  static const okTint = Color(0xFFE1F0E6);
  static const inflight = Color(0xFF4F55BD);
  static const inflightTint = Color(0xFFE9EAFA);
  static const warn = Color(0xFF8A4A00);
  static const warnTint = Color(0xFFF6E6D2);
  static const danger = Color(0xFFB01B0F);
  static const dangerTint = Color(0xFFF8E3E0);

  /// A seat TYPE, not a status, so it is kept out of the semantic four and
  /// composes with them instead of competing.
  static const plum = Color(0xFF8E2F72);

  /// A seat nobody can buy.
  ///
  /// This used to be `plate2` — one shade off the white a free seat is painted.
  /// Nine steps out of 255, on the one screen whose entire job is "which of
  /// these can I have". The strikethrough was doing all the work, and a
  /// strikethrough is thin. This is a solid fill far enough down that the
  /// answer survives sunlight, a cheap LCD and a colour-blind reader.
  static const seatSold = Color(0xFFD5DBD3);
  static const seatSoldLine = Color(0xFFAEB9AA);
  static const seatSoldInk = Color(0xFF5C6961);

  /// Third-party marks. Quarantined from the semantics on purpose: an orange
  /// Nagad tile is a brand, not a warning.
  static const bkash = Color(0xFFE2136E);
  static const nagad = Color(0xFFEE7623);

  /// The crew app's own chrome. Graphite rather than mid-slate, which read as
  /// "disabled" on a phone held at arm's length in sunlight.
  static const crew = Color(0xFF2C3138);
  static const crewInk = Color(0xFFC6CEDA);

  static const radius = 4.0;
  static const radiusSm = 2.0;
}

BorderRadius get _r => BorderRadius.circular(J.radius);

ThemeData jatraTheme({Color seed = J.field}) {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    scaffoldBackgroundColor: J.ground,
    colorScheme: ColorScheme.fromSeed(
      seedColor: seed,
      brightness: Brightness.light,
    ).copyWith(
      primary: seed,
      surface: J.plate,
      onSurface: J.ink,
      error: J.danger,
    ),
  );

  // Anek is the web product's superfamily: Latin and Bangla share vertical
  // metrics and a skeleton, so a bilingual line does not wobble. Where the
  // font is not bundled the platform's own Bengali face is used, which is
  // correct on a Bangladeshi handset and one less megabyte in the download.
  const family = 'Anek';

  return base.copyWith(
    textTheme: base.textTheme.apply(
      fontFamily: family,
      bodyColor: J.ink,
      displayColor: J.ink,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: J.field,
      foregroundColor: Colors.white,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: family, fontSize: 19, fontWeight: FontWeight.w600, color: Colors.white,
      ),
    ),
    cardTheme: CardThemeData(
      color: J.plate,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: _r,
        side: const BorderSide(color: J.rule),
      ),
    ),
    dividerTheme: const DividerThemeData(color: J.rule, thickness: 1, space: 1),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: seed,
        foregroundColor: Colors.white,
        // 52 high. A thumb on a moving bus is not a mouse, and 40 is the size
        // that makes people tap twice.
        minimumSize: const Size.fromHeight(52),
        textStyle: const TextStyle(fontFamily: family, fontSize: 17, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: _r),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: J.ink,
        minimumSize: const Size.fromHeight(48),
        side: const BorderSide(color: J.ruleStrong),
        textStyle: const TextStyle(fontFamily: family, fontSize: 16, fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: _r),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: seed,
        textStyle: const TextStyle(fontFamily: family, fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: J.plate,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
      border: OutlineInputBorder(borderRadius: _r, borderSide: const BorderSide(color: J.rule)),
      enabledBorder: OutlineInputBorder(borderRadius: _r, borderSide: const BorderSide(color: J.rule)),
      focusedBorder: OutlineInputBorder(
          borderRadius: _r, borderSide: BorderSide(color: seed, width: 2)),
      errorBorder: OutlineInputBorder(borderRadius: _r, borderSide: const BorderSide(color: J.danger)),
      labelStyle: const TextStyle(color: J.ink2, fontFamily: family),
      hintStyle: const TextStyle(color: J.muted, fontFamily: family),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: J.ink,
      contentTextStyle: const TextStyle(color: Colors.white, fontFamily: family, fontSize: 15),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: _r),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: J.plate,
      indicatorColor: J.fieldTint,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      height: 68,
      labelTextStyle: WidgetStatePropertyAll(
        TextStyle(fontFamily: family, fontSize: 12, fontWeight: FontWeight.w600, color: J.ink2),
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: J.plate2,
      side: const BorderSide(color: J.rule),
      labelStyle: const TextStyle(fontFamily: family, fontSize: 13, color: J.ink2),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(J.radiusSm)),
    ),
  );
}
