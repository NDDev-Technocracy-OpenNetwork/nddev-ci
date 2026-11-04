import org.gradle.api.artifacts.dsl.LockMode

plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "com.nddev.ci.fixture"
    compileSdk = libs.versions.compile.sdk.get().toInt()
    buildToolsVersion = libs.versions.build.tools.get()

    defaultConfig {
        applicationId = "com.nddev.ci.fixture"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
}

dependencies {
    testImplementation(libs.junit)
}

dependencyLocking {
    lockAllConfigurations()
    lockMode.set(LockMode.STRICT)
}
