# Repository Guidelines

## Project Overview

Reader is a local-first Android ebook reader. A vanilla JavaScript frontend uses `foliate-js` to render EPUB, PDF, MOBI/AZW, FB2, CBZ, text, and HTML books; a small Java `WebView` host packages that frontend as the Android app. There is no backend: books, covers, and preferences remain in browser storage on the device.

## Architecture & Data Flow

1. Authored UI code starts at `web/index.html` and `web/src/main.js`. `web/src/library.js` owns browser persistence.
2. Vite builds `web/` into the generated `app/src/main/assets/web/` directory. `scripts/copy-foliate-assets.mjs` then copies the PDF.js worker and support files required by Foliate.
3. `MainActivity` loads `https://reader.local/index.html` in a `WebView`. Its `WebViewClient` intercepts that host and serves files from the APK assets; this is not a network server.
4. Books arrive through the web file picker or an Android `ACTION_VIEW` intent. For an intent, Java exposes the pending `ContentResolver` stream at `/__book`; `main.js` fetches it and constructs a `File`.
5. `main.js` passes native ebook formats to `<foliate-view>` and adapts text/HTML into synthetic Foliate sections. Foliate `load` and `relocate` events drive reader taps, chapter state, and progress UI.
6. `web/src/library.js` stores metadata and full book files in IndexedDB database `reader.library`; reading preferences use `localStorage` key `reader.preferences.v1`. The optional `ReaderSystemUi` JavaScript bridge controls Android theme colors and immersive reader mode.

Keep web behavior usable both in a normal browser and in the Android host. Native-only calls must remain guarded, for example `globalThis.ReaderSystemUi?.setReaderMode(...)`.

## Key Directories

| Path | Purpose |
| --- | --- |
| `web/` | Authored HTML, CSS, and JavaScript frontend. |
| `web/src/` | Reader orchestration (`main.js`), IndexedDB API (`library.js`), and styles. |
| `app/src/main/java/app/reader/` | Native Android `WebView`, file-intent, asset-serving, and JS-bridge code. |
| `app/src/main/res/` | Android theme and launcher resources. |
| `scripts/` | Node build helpers, currently PDF.js asset copying. |
| `gradle/wrapper/` | Pinned Gradle wrapper configuration. |
| `app/src/main/assets/web/` | Generated Vite output. Never edit it directly; builds empty and recreate it. |
| `app/build/` | Generated Android outputs and reports. Never treat these as source. |

## Development Commands

Use the repository wrappers and lockfiles:

```sh
npm ci                       # Install the exact JavaScript dependency tree
npm run dev                  # Vite dev server on http://127.0.0.1:5173
npm run build                # Build web assets and copy Foliate PDF.js assets
npm run preview              # Serve the production web build locally
./gradlew assembleDebug      # Build the Android APK, including the web build
./gradlew lint               # Run Android Gradle Plugin lint
./gradlew assembleRelease    # Build the R8-minified release variant
```

Android `preBuild` depends on Gradle tasks that run `npm ci` and `npm run build`. A browser dev server cannot exercise Android intents, asset interception, system bars, or the JavaScript bridge.

## Code Conventions & Common Patterns

- JavaScript uses ES modules, four-space indentation, single quotes, no semicolons, `camelCase` functions/variables, and `UPPER_SNAKE_CASE` constants. Prefer `const`; use `let` only for mutable state.
- The frontend is framework-free. Reuse direct DOM APIs, the cached `elements` map, module-level state, and `addEventListener`; do not introduce a second UI or state-management pattern for a local change.
- Async work uses `async`/`await`. IndexedDB requests are promisified by `requestResult()` and transactions by `transactionDone()`; await transaction completion before reporting a write as successful.
- User-recoverable failures go through `showStatus(...)`; diagnostic detail goes to `console.error`/`console.warn`. Catch only when recovery or a documented fallback exists.
- Keep untrusted book content constrained. Reuse the existing HTML sanitization path, restrictive Content Security Policy, and external-link handling rather than injecting raw markup or relaxing CSP.
- Persistent book data belongs behind exports in `web/src/library.js`; preferences belong in the versioned local-storage object. Schema changes require an IndexedDB version upgrade and migration.
- Java uses four-space indentation, braces on the declaration line, `camelCase` members, and `UPPER_SNAKE_CASE` constants. `MainActivity` contains small private inner `WebViewClient`/`WebChromeClient` classes; no dependency-injection framework is present.
- CSS uses custom properties for design tokens, `:root[data-theme='…']` variants, kebab-case classes, safe-area insets, and accessible 44px-or-larger controls. Preserve semantic HTML, ARIA labels/live regions, and keyboard behavior.
- Edit `web/`, not the generated APK assets. Keep `package.json` and `package-lock.json` synchronized because Gradle installs with `npm ci`.

## Important Files

| File | Role |
| --- | --- |
| `web/src/main.js` | Application state, library/reader views, Foliate setup, format adaptation, settings, and Android book handoff. |
| `web/src/library.js` | IndexedDB schema and book/cover CRUD. |
| `web/index.html` | UI shell, dialogs, accessibility attributes, and CSP. |
| `web/src/styles.css` | Theme tokens and responsive reader/library layout. |
| `app/src/main/java/app/reader/MainActivity.java` | Android entry point, local asset responses, file chooser/intents, and native bridge. |
| `app/src/main/AndroidManifest.xml` | Activity registration and supported document MIME intents. |
| `vite.config.js` | `web/` root, ES2022 output, generated asset destination, and Foliate PDF URL transform. |
| `app/build.gradle.kts` | Android SDK settings and Gradle-to-npm build integration. |
| `scripts/copy-foliate-assets.mjs` | Copies Foliate's PDF.js runtime assets after Vite builds. |

## Runtime/Tooling Preferences

- Use **npm**, not Bun, pnpm, or Yarn. `package-lock.json` is lockfile version 3.
- `package.json` does not pin Node itself. The currently locked Vite 7.3.6 requires Node `^20.19.0 || >=22.12.0`; use a compatible Node release.
- Node files are ES modules (`"type": "module"`). Vite targets ES2022.
- Run Gradle with JDK 17 and use `./gradlew`; the wrapper pins Gradle 8.14.3. Android Gradle Plugin is 8.11.1, compile/target SDK is 35, and min SDK is 26.
- `foliate-js` is pinned to a Git commit in `package.json`. Treat upgrades as API migrations and recheck every supported book format plus PDF worker loading.

## Testing & QA

No authored unit, integration, instrumentation, or end-to-end tests exist. There is no JavaScript test/lint script, coverage tool, CI workflow, or numerical coverage threshold. `./gradlew test` and `connectedCheck` are not meaningful proof while their source sets are empty.

Minimum verification by change type:

- Web logic or styling: run `npm run build`, then use `npm run dev` or `npm run preview` and exercise the changed path with a representative book.
- Persistence or parsing: verify add, close, reopen, delete, and affected format behavior; include malformed/unsupported input when relevant.
- Android bridge, intents, manifest, or asset serving: run `./gradlew lint assembleDebug`, install/run the APK, and exercise both the system file picker and `ACTION_VIEW` path.
- PDF/build-pipeline changes: confirm the generated PDF.js worker/assets load in the packaged Android app, not only in Vite development mode.

Add tests only around observable behavior, using `app/src/test/` or `app/src/androidTest/` for Android when a runner is introduced. Do not edit or cite generated reports under `app/build/` as test sources.
