package app.reader;

import android.graphics.Bitmap;
import android.graphics.Color;

import java.io.Closeable;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class DjvuDocument implements Closeable {
    static final class OutlineItem {
        final String label;
        final int pageIndex;
        final List<OutlineItem> subitems = new ArrayList<>();

        private OutlineItem(String label, int pageIndex) {
            this.label = label;
            this.pageIndex = pageIndex;
        }
    }

    static final class TextWord {
        final String text;
        final int left;
        final int bottom;
        final int right;
        final int top;

        private TextWord(String text, int left, int bottom, int right, int top) {
            this.text = text;
            this.left = left;
            this.bottom = bottom;
            this.right = right;
            this.top = top;
        }
    }

    static final class TextPage {
        final int width;
        final int height;
        final List<TextWord> words;

        private TextPage(int width, int height, List<TextWord> words) {
            this.width = width;
            this.height = height;
            this.words = words;
        }
    }

    static {
        System.loadLibrary("reader_djvu");
    }

    private long context;
    private long document;
    private final int pageCount;

    DjvuDocument(String path) {
        long[] opened = nativeOpen(path);
        if (opened == null || opened.length != 3) {
            throw new IllegalStateException("DjVuLibre returned an invalid document handle");
        }
        context = opened[0];
        document = opened[1];
        pageCount = Math.toIntExact(opened[2]);
    }

    synchronized int getPageCount() {
        ensureOpen();
        return pageCount;
    }

    synchronized int[] getPageSize(int pageIndex) {
        ensurePage(pageIndex);
        int[] size = nativePageSize(context, document, pageIndex);
        if (size == null || size.length != 2 || size[0] <= 0 || size[1] <= 0) {
            throw new IllegalStateException("DjVuLibre returned an invalid page size");
        }
        return size;
    }

    synchronized List<OutlineItem> getOutline() {
        ensureOpen();
        Object[] outline = nativeOutline(context, document);
        if (outline == null
                || outline.length != 2
                || !(outline[0] instanceof byte[][])
                || !(outline[1] instanceof int[])) {
            throw new IllegalStateException("DjVuLibre returned an invalid document outline");
        }

        byte[][] labels = (byte[][]) outline[0];
        int[] locations = (int[]) outline[1];
        if (locations.length != labels.length * 2) {
            throw new IllegalStateException("DjVuLibre returned an invalid document outline");
        }

        List<OutlineItem> roots = new ArrayList<>();
        List<List<OutlineItem>> levels = new ArrayList<>();
        levels.add(roots);
        for (int index = 0; index < labels.length; index++) {
            int depth = locations[index * 2];
            int pageIndex = locations[(index * 2) + 1];
            if (labels[index] == null
                    || depth < 0
                    || depth >= levels.size()
                    || pageIndex < -1
                    || pageIndex >= pageCount) {
                throw new IllegalStateException("DjVuLibre returned an invalid document outline");
            }
            while (levels.size() > depth + 1) levels.remove(levels.size() - 1);
            OutlineItem item = new OutlineItem(
                    new String(labels[index], StandardCharsets.UTF_8),
                    pageIndex);
            levels.get(depth).add(item);
            levels.add(item.subitems);
        }
        return roots;
    }

    synchronized TextPage getPageText(int pageIndex) {
        ensurePage(pageIndex);
        int[] size = getPageSize(pageIndex);
        Object[] pageText = nativePageText(context, document, pageIndex);
        if (pageText == null
                || pageText.length != 2
                || !(pageText[0] instanceof byte[][])
                || !(pageText[1] instanceof int[])) {
            throw new IllegalStateException("DjVuLibre returned invalid page text");
        }

        byte[][] texts = (byte[][]) pageText[0];
        int[] bounds = (int[]) pageText[1];
        if (bounds.length != texts.length * 4) {
            throw new IllegalStateException("DjVuLibre returned invalid page text");
        }

        List<TextWord> words = new ArrayList<>(texts.length);
        for (int index = 0; index < texts.length; index++) {
            int left = bounds[index * 4];
            int bottom = bounds[(index * 4) + 1];
            int right = bounds[(index * 4) + 2];
            int top = bounds[(index * 4) + 3];
            if (texts[index] == null
                    || left < 0
                    || bottom < 0
                    || right <= left
                    || top <= bottom
                    || right > size[0]
                    || top > size[1]) {
                continue;
            }
            String text = new String(texts[index], StandardCharsets.UTF_8);
            if (text.isBlank()) continue;
            words.add(new TextWord(text, left, bottom, right, top));
        }
        return new TextPage(size[0], size[1], words);
    }


    synchronized Bitmap renderPage(int pageIndex, int maximumWidth, int maximumHeight) {
        ensurePage(pageIndex);
        int[] source = getPageSize(pageIndex);
        double scale = Math.min(
                (double) maximumWidth / source[0],
                (double) maximumHeight / source[1]);
        int width = Math.max(1, (int) Math.round(source[0] * scale));
        int height = Math.max(1, (int) Math.round(source[1] * scale));
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.WHITE);
        try {
            if (!nativeRender(context, document, pageIndex, bitmap)) {
                throw new IllegalStateException("DjVuLibre could not render page " + (pageIndex + 1));
            }
            return bitmap;
        } catch (RuntimeException error) {
            bitmap.recycle();
            throw error;
        }
    }

    @Override
    public synchronized void close() {
        if (context == 0 && document == 0) return;
        nativeClose(context, document);
        context = 0;
        document = 0;
    }

    private void ensureOpen() {
        if (context == 0 || document == 0) throw new IllegalStateException("The DjVu document is closed");
    }

    private void ensurePage(int pageIndex) {
        ensureOpen();
        if (pageIndex < 0 || pageIndex >= pageCount) {
            throw new IllegalArgumentException("DjVu page is outside the document");
        }
    }

    private static native long[] nativeOpen(String path);
    private static native int[] nativePageSize(long context, long document, int pageIndex);
    private static native Object[] nativeOutline(long context, long document);
    private static native Object[] nativePageText(long context, long document, int pageIndex);
    private static native boolean nativeRender(
            long context,
            long document,
            int pageIndex,
            Bitmap bitmap);
    private static native void nativeClose(long context, long document);
}
