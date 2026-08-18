import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "bd.jatra.jatra_crew"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "bd.jatra.jatra_crew"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Release signing.
    //
    // The key lives in android/key.properties, which is NOT in this repository
    // — a signing key in version control is a signing key everybody who has
    // ever cloned the repo can publish updates with, and it cannot be revoked
    // without orphaning every phone that already has the app.
    //
    // Set it up once with android/keystore.md next to this file. Without it,
    // `flutter build apk --release` still works and still signs with the debug
    // key, which is the right trade for a developer building on a laptop: it
    // fails loudly at upload time rather than silently producing an unsigned
    // artifact somebody ships.
    val keyProps = Properties()
    val keyPropsFile = rootProject.file("key.properties")
    val haveReleaseKey = keyPropsFile.exists()
    if (haveReleaseKey) {
        keyPropsFile.inputStream().use { keyProps.load(it) }
    }

    signingConfigs {
        if (haveReleaseKey) {
            create("release") {
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
                storeFile = file(keyProps.getProperty("storeFile"))
                storePassword = keyProps.getProperty("storePassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (haveReleaseKey) {
                signingConfigs.getByName("release")
            } else {
                // Says so, rather than pretending. A build log that reads
                // "signed with the debug key" is the difference between finding
                // this at your desk and finding it at the Play console.
                logger.lifecycle("WARNING: no android/key.properties - this " +
                    "release build is signed with the DEBUG key and cannot be published")
                signingConfigs.getByName("debug")
            }
            // Dart is already compiled AOT; this is the Java/Kotlin shim and the
            // resources. Shrinking without a rules file is how a release build
            // dies on a reflective call that debug never touched, so it is off
            // deliberately rather than by omission.
            isMinifyEnabled = false
            isShrinkResources = false
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
