package app.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.List;

public final class MainActivity extends Activity {
    private static final String APP_HOST = "reader.local";
    private static final String APP_URL = "https://" + APP_HOST + "/index.html";
    private static final int FILE_CHOOSER_REQUEST = 41;

    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private Uri pendingBookUri;
    private String pendingBookMime;
    private final Object djvuLock = new Object();
    private DjvuDocument djvuDocument;
    private String djvuBookKey;

    private boolean readerMode;
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);
        applySystemBarInsets();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);

        webView.addJavascriptInterface(new ReaderSystemUi(), "ReaderSystemUi");
        webView.addJavascriptInterface(new ReaderDjvu(), "ReaderDjvu");
        webView.setWebViewClient(new ReaderWebViewClient());
        webView.setWebChromeClient(new ReaderWebChromeClient());
        openIntent(getIntent());
    }

    @SuppressWarnings("deprecation")
    private void applySystemBarInsets() {
        webView.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets insets = windowInsets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                left = insets.left;
                top = insets.top;
                right = insets.right;
                bottom = insets.bottom;
            } else {
                left = windowInsets.getSystemWindowInsetLeft();
                top = windowInsets.getSystemWindowInsetTop();
                right = windowInsets.getSystemWindowInsetRight();
                bottom = windowInsets.getSystemWindowInsetBottom();
            }

            ViewGroup.MarginLayoutParams layout = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            if (layout.leftMargin != left
                    || layout.topMargin != top
                    || layout.rightMargin != right
                    || layout.bottomMargin != bottom) {
                layout.setMargins(left, top, right, bottom);
                view.setLayoutParams(layout);
            }
            return windowInsets;
        });
        webView.requestApplyInsets();
    }

    @SuppressWarnings("deprecation")
    private void setReaderMode(boolean enabled) {
        readerMode = enabled;
        if (enabled) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                if (enabled) {
                    controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                    controller.setSystemBarsBehavior(
                            android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                } else {
                    controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                }
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
            if (enabled) {
                flags |= View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        webView.requestApplyInsets();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && readerMode) setReaderMode(true);
    }

    public final class ReaderSystemUi {
        @JavascriptInterface
        public void setReaderMode(boolean enabled) {
            webView.post(() -> MainActivity.this.setReaderMode(enabled));
        }

        @JavascriptInterface
        public void setTheme(String theme) {
            final int color;
            switch (theme) {
                case "dark":
                    color = android.graphics.Color.rgb(4, 15, 15);
                    break;
                case "night":
                    color = android.graphics.Color.rgb(13, 8, 5);
                    break;
                default:
                    color = android.graphics.Color.rgb(201, 251, 255);
                    break;
            }
            webView.post(() -> {
                getWindow().getDecorView().setBackgroundColor(color);
                getWindow().setStatusBarColor(color);
                getWindow().setNavigationBarColor(color);
            });
        }
    }


    public final class ReaderDjvu {
        @JavascriptInterface
        public String open(String bookKey, boolean importPendingFile) {
            JSONObject result = new JSONObject();
            synchronized (djvuLock) {
                try {
                    if (bookKey == null || bookKey.isBlank()) {
                        throw new IllegalArgumentException("The DjVu library key is missing");
                    }
                    File cached = djvuCacheFile(bookKey);
                    if (importPendingFile) cachePendingDjvu(cached);
                    if (!cached.isFile()) {
                        throw new IOException("The stored DjVu file is unavailable; import it again");
                    }

                    closeDjvuLocked();
                    DjvuDocument opened = new DjvuDocument(cached.getAbsolutePath());
                    djvuDocument = opened;
                    djvuBookKey = bookKey;
                    int[] firstPage = opened.getPageSize(0);
                    result.put("pageCount", opened.getPageCount());
                    result.put("width", firstPage[0]);
                    result.put("height", firstPage[1]);
                    result.put("toc", djvuOutline(opened.getOutline()));
                } catch (Exception error) {
                    closeDjvuLocked();
                    try {
                        result.put("error", errorMessage(error));
                    } catch (Exception ignored) {
                        return "{\"error\":\"Could not open the DjVu document\"}";
                    }
                }
            }
            return result.toString();
        }

        @JavascriptInterface
        public void close() {
            synchronized (djvuLock) {
                closeDjvuLocked();
            }
        }

        @JavascriptInterface
        public void delete(String bookKey) {
            if (bookKey == null || bookKey.isBlank()) return;
            synchronized (djvuLock) {
                if (bookKey.equals(djvuBookKey)) closeDjvuLocked();
                File cached = djvuCacheFile(bookKey);
                if (cached.isFile() && !cached.delete()) {
                    android.util.Log.w("ReaderDjVu", "Could not delete " + cached);
                }
            }
        }
    }

    private JSONArray djvuOutline(List<DjvuDocument.OutlineItem> items) throws JSONException {
        JSONArray result = new JSONArray();
        for (DjvuDocument.OutlineItem item : items) {
            JSONObject entry = new JSONObject();
            entry.put("label", item.label);
            if (item.pageIndex >= 0) entry.put("href", item.pageIndex);
            if (!item.subitems.isEmpty()) entry.put("subitems", djvuOutline(item.subitems));
            result.put(entry);
        }
        return result;
    }

    private void cachePendingDjvu(File target) throws IOException {
        Uri source = pendingBookUri;
        if (source == null) throw new IOException("The selected DjVu file is unavailable");
        File directory = target.getParentFile();
        if (directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
            throw new IOException("Could not create DjVu storage");
        }

        File temporary = File.createTempFile("import-", ".djvu", directory);
        boolean moved = false;
        try (InputStream input = getContentResolver().openInputStream(source);
             FileOutputStream output = new FileOutputStream(temporary)) {
            if (input == null) throw new IOException("The selected DjVu file cannot be read");
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            output.getFD().sync();
            if (target.isFile() && !target.delete()) {
                throw new IOException("Could not replace the stored DjVu file");
            }
            moved = temporary.renameTo(target);
            if (!moved) throw new IOException("Could not finish storing the DjVu file");
        } finally {
            if (!moved && temporary.isFile() && !temporary.delete()) {
                android.util.Log.w("ReaderDjVu", "Could not delete temporary file " + temporary);
            }
        }
    }

    private File djvuCacheFile(String bookKey) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(bookKey.getBytes(StandardCharsets.UTF_8));
            StringBuilder filename = new StringBuilder(digest.length * 2);
            for (byte value : digest) {
                int unsigned = value & 0xff;
                filename.append(Character.forDigit(unsigned >>> 4, 16));
                filename.append(Character.forDigit(unsigned & 0x0f, 16));
            }
            return new File(new File(getFilesDir(), "djvu"), filename + ".djvu");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private void closeDjvuLocked() {
        if (djvuDocument != null) djvuDocument.close();
        djvuDocument = null;
        djvuBookKey = null;
    }

    private String errorMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? error.getClass().getSimpleName() : message;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        openIntent(intent);
    }

    private void openIntent(Intent intent) {
        Uri uri = Intent.ACTION_VIEW.equals(intent.getAction()) ? intent.getData() : null;
        pendingBookUri = uri;
        pendingBookMime = uri == null ? null : getContentResolver().getType(uri);

        Uri.Builder url = Uri.parse(APP_URL).buildUpon();
        if (uri != null) {
            url.appendQueryParameter("open", "1");
            url.appendQueryParameter("name", displayName(uri));
            url.appendQueryParameter("type", pendingBookMime == null ? "" : pendingBookMime);
        }
        webView.loadUrl(url.build().toString());
    }

    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = getContentResolver().query(
                    uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) return cursor.getString(index);
                }
            } catch (RuntimeException ignored) {
                // Fall through to the last path segment when a provider rejects metadata queries.
            }
        }
        String segment = uri.getLastPathSegment();
        return segment == null || segment.isBlank() ? "book" : segment;
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) return;
        Uri result = resultCode == RESULT_OK && data != null ? data.getData() : null;
        pendingBookUri = result;
        pendingBookMime = result == null ? null : getContentResolver().getType(result);
        if (result != null && data != null
                && (data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
            try {
                getContentResolver().takePersistableUriPermission(
                        result, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // The decoder copies the file immediately when the provider does not persist grants.
            }
        }
        fileChooserCallback.onReceiveValue(result == null ? null : new Uri[]{result});
        fileChooserCallback = null;
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        synchronized (djvuLock) {
            closeDjvuLocked();
        }
        webView.stopLoading();
        webView.setWebChromeClient(null);
        webView.setWebViewClient(null);
        webView.destroy();
        super.onDestroy();
    }

    private final class ReaderWebChromeClient extends WebChromeClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams params
        ) {
            setReaderMode(false);
            if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = callback;
            pendingBookUri = null;
            pendingBookMime = null;

            Intent chooser = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/epub+zip",
                            "application/pdf",
                            "image/vnd.djvu",
                            "application/x-mobipocket-ebook",
                            "application/vnd.amazon.ebook",
                            "application/vnd.comicbook+zip",
                            "application/x-fictionbook+xml",
                            "application/x-zip-compressed-fb2",
                            "text/plain",
                            "text/html",
                            "application/octet-stream",
                    });
            try {
                startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                return true;
            } catch (RuntimeException error) {
                fileChooserCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
        }
    }

    private final class ReaderWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"https".equals(uri.getScheme()) || !APP_HOST.equals(uri.getHost())) return null;
            if ("/__book".equals(uri.getPath())) return pendingBookResponse();
            if ("/__djvu/page".equals(uri.getPath())) return djvuPageResponse(uri);
            if ("/__djvu/text".equals(uri.getPath())) return djvuTextResponse(uri);
            return assetResponse(uri.getPath());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (APP_HOST.equals(uri.getHost()) || "blob".equals(uri.getScheme())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (RuntimeException ignored) {
                // No installed activity handles the link; leave the reader in place.
            }
            return true;
        }
    }

    private WebResourceResponse pendingBookResponse() {
        if (pendingBookUri == null) return errorResponse(404, "No book is pending");
        try {
            InputStream stream = getContentResolver().openInputStream(pendingBookUri);
            if (stream == null) return errorResponse(404, "The book is unavailable");
            return response(pendingBookMime == null ? "application/octet-stream" : pendingBookMime, stream);
        } catch (IOException | SecurityException error) {
            return errorResponse(403, "The book cannot be opened");
        }
    }

    private WebResourceResponse djvuPageResponse(Uri uri) {
        try {
            int page = boundedQueryInteger(uri, "page", 0, 100_000);
            int width = boundedQueryInteger(uri, "width", 64, 4096);
            int height = boundedQueryInteger(uri, "height", 64, 4096);
            Bitmap bitmap;
            synchronized (djvuLock) {
                if (djvuDocument == null) return errorResponse(404, "No DjVu document is open");
                bitmap = djvuDocument.renderPage(page, width, height);
            }
            try {
                ByteArrayOutputStream encoded = new ByteArrayOutputStream(256 * 1024);
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 92, encoded)) {
                    return errorResponse(500, "Could not encode the DjVu page");
                }
                return response("image/jpeg", new ByteArrayInputStream(encoded.toByteArray()));
            } finally {
                bitmap.recycle();
            }
        } catch (RuntimeException error) {
            return errorResponse(500, errorMessage(error));
        }
    }

    private WebResourceResponse djvuTextResponse(Uri uri) {
        try {
            int page = boundedQueryInteger(uri, "page", 0, 100_000);
            DjvuDocument.TextPage textPage;
            synchronized (djvuLock) {
                if (djvuDocument == null) return errorResponse(404, "No DjVu document is open");
                textPage = djvuDocument.getPageText(page);
            }

            JSONArray words = new JSONArray();
            for (DjvuDocument.TextWord word : textPage.words) {
                JSONArray encodedWord = new JSONArray();
                encodedWord.put(word.text);
                encodedWord.put(word.left);
                encodedWord.put(word.bottom);
                encodedWord.put(word.right);
                encodedWord.put(word.top);
                words.put(encodedWord);
            }
            JSONObject result = new JSONObject();
            result.put("width", textPage.width);
            result.put("height", textPage.height);
            result.put("words", words);
            return response(
                    "application/json",
                    new ByteArrayInputStream(result.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (JSONException | RuntimeException error) {
            return errorResponse(500, errorMessage(error));
        }
    }

    private int boundedQueryInteger(Uri uri, String name, int minimum, int maximum) {
        String raw = uri.getQueryParameter(name);
        if (raw == null) throw new IllegalArgumentException("Missing DjVu page parameter: " + name);
        int value;
        try {
            value = Integer.parseInt(raw);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("Invalid DjVu page parameter: " + name, error);
        }
        if (value < minimum || value > maximum) {
            throw new IllegalArgumentException("DjVu page parameter is outside its allowed range: " + name);
        }
        return value;
    }

    private WebResourceResponse assetResponse(String path) {
        String relative = path == null || "/".equals(path) ? "index.html" : path.substring(1);
        if (relative.contains("..")) return errorResponse(403, "Invalid asset path");
        try {
            return response(mimeType(relative), getAssets().open("web/" + relative));
        } catch (IOException error) {
            return errorResponse(404, "Asset not found");
        }
    }

    private String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mjs") || lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".json")) return "application/json";
        String guessed = URLConnection.guessContentTypeFromName(path);
        if (guessed != null) return guessed;
        String extension = MimeTypeMap.getFileExtensionFromUrl(path);
        String androidGuess = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return androidGuess == null ? "application/octet-stream" : androidGuess;
    }

    private WebResourceResponse response(String mime, InputStream stream) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        return new WebResourceResponse(mime, null, 200, "OK", headers, stream);
    }

    private WebResourceResponse errorResponse(int status, String message) {
        Map<String, String> headers = Map.of("Cache-Control", "no-store");
        InputStream body = new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8));
        return new WebResourceResponse("text/plain", "UTF-8", status, message, headers, body);
    }
}
