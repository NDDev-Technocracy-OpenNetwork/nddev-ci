import org.gradle.api.artifacts.dsl.LockMode

plugins {
    alias(libs.plugins.android.application) apply false
}

dependencyLocking {
    lockAllConfigurations()
    lockMode.set(LockMode.STRICT)
}
