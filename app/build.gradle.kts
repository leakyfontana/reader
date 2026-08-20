import org.gradle.api.tasks.Exec

plugins {
    id("com.android.application")
}

android {
    namespace = "app.reader"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.reader"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                cppFlags += listOf("-std=c++17")
            }
        }
    }

    flavorDimensions += "channel"
    productFlavors {
        create("normal") {
            dimension = "channel"
        }
        create("beta") {
            dimension = "channel"
            applicationIdSuffix = ".beta"
            versionNameSuffix = "-beta"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    ndkVersion = "27.2.12479018"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

val npmInstall by tasks.registering(Exec::class) {
    workingDir = rootDir
    commandLine("npm", "ci")
    inputs.files(rootProject.file("package.json"), rootProject.file("package-lock.json"))
    outputs.dir(rootProject.file("node_modules"))
}

val buildWeb by tasks.registering(Exec::class) {
    dependsOn(npmInstall)
    workingDir = rootDir
    commandLine("npm", "run", "build")
    inputs.dir(rootProject.file("web"))
    inputs.file(rootProject.file("vite.config.js"))
    inputs.file(rootProject.file("scripts/copy-foliate-assets.mjs"))
    outputs.dir(project.file("src/main/assets/web"))
}

tasks.named("preBuild").configure {
    dependsOn(buildWeb)
}
