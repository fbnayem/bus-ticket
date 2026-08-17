/// The spine both Jatra applications sit on.
///
/// One rule governs everything exported here, and it is the platform's rule
/// rather than this package's: **every sales channel calls the same inventory
/// service.** These apps hold no seat state, decide no availability, and
/// reserve nothing locally. They ask, and they draw the answer.
library;

export 'src/api/client.dart';
export 'src/api/crew_api.dart';
export 'src/api/passenger_api.dart';
export 'src/format.dart';
export 'src/i18n.dart';
export 'src/models.dart';
export 'src/place_picker.dart';
export 'src/voice/intent.dart';
export 'src/voice/voice_session.dart';
export 'src/store.dart';
export 'src/theme.dart';
export 'src/widgets.dart';
