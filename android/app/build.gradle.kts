import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Offline fallback: the web app from the repo root, bundled as assets.
val webAssets = layout.buildDirectory.dir("webassets")
val copyWeb by tasks.registering(Sync::class) {
    from(rootDir.parentFile) { include("index.html", "css/**", "js/**", "data/**", "songs/**") }
    into(webAssets)
}

// Release signing: -PaplusSigning=/path/keystore.properties (storeFile, storePassword, keyAlias, keyPassword).
val signingProps = (findProperty("aplusSigning") as String?)?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}

android {
    namespace = "org.abacusplus.piano"
    compileSdk = 34
    defaultConfig {
        applicationId = "org.abacusplus.piano"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    signingConfigs {
        if (signingProps != null) create("release") {
            storeFile = file(signingProps.getProperty("storeFile"))
            storePassword = signingProps.getProperty("storePassword")
            keyAlias = signingProps.getProperty("keyAlias")
            keyPassword = signingProps.getProperty("keyPassword")
        }
    }
    buildTypes {
        release { signingConfig = signingConfigs.findByName("release") }
    }
    sourceSets["main"].assets.srcDir(webAssets)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}
