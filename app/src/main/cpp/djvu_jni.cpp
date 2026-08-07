#include <android/bitmap.h>
#include <android/log.h>
#include <jni.h>

#include <cstring>
#include <cstdint>
#include <string>
#include <unistd.h>
#include <vector>

#include "ddjvuapi.h"
#include "miniexp.h"

namespace {
constexpr const char *TAG = "ReaderDjVu";

void throwRuntime(JNIEnv *env, const std::string &message) {
    if (env->ExceptionCheck()) return;
    jclass exception = env->FindClass("java/lang/RuntimeException");
    if (exception) env->ThrowNew(exception, message.c_str());
}

bool drainMessages(JNIEnv *env, ddjvu_context_t *context, bool wait) {
    if (wait) ddjvu_message_wait(context);
    bool failed = false;
    std::string error;
    while (const ddjvu_message_t *message = ddjvu_message_peek(context)) {
        if (message->m_any.tag == DDJVU_ERROR) {
            failed = true;
            error = message->m_error.message ? message->m_error.message : "DjVu decoding failed";
            __android_log_print(ANDROID_LOG_ERROR, TAG, "%s", error.c_str());
        }
        ddjvu_message_pop(context);
    }
    if (failed) throwRuntime(env, error);
    return failed;
}

bool waitForDocument(JNIEnv *env, ddjvu_context_t *context, ddjvu_document_t *document) {
    ddjvu_status_t status;
    while ((status = ddjvu_document_decoding_status(document)) < DDJVU_JOB_OK) {
        if (drainMessages(env, context, true)) return false;
    }
    if (status != DDJVU_JOB_OK) {
        drainMessages(env, context, false);
        if (!env->ExceptionCheck()) throwRuntime(env, "DjVu document decoding failed");
        return false;
    }
    return true;
}

bool waitForPage(JNIEnv *env, ddjvu_context_t *context, ddjvu_page_t *page) {
    ddjvu_status_t status;
    while ((status = ddjvu_page_decoding_status(page)) < DDJVU_JOB_OK) {
        if (drainMessages(env, context, true)) return false;
    }
    if (status != DDJVU_JOB_OK) {
        drainMessages(env, context, false);
        if (!env->ExceptionCheck()) throwRuntime(env, "DjVu page decoding failed");
        return false;
    }
    return true;
}

bool readPageInfo(JNIEnv *env, ddjvu_context_t *context, ddjvu_document_t *document,
                  int pageIndex, ddjvu_pageinfo_t *info) {
    ddjvu_status_t status;
    while ((status = ddjvu_document_get_pageinfo(document, pageIndex, info)) < DDJVU_JOB_OK) {
        if (drainMessages(env, context, true)) return false;
    }
    if (status != DDJVU_JOB_OK) {
        drainMessages(env, context, false);
        if (!env->ExceptionCheck()) throwRuntime(env, "Could not read DjVu page information");
        return false;
    }
    return true;
}

inline ddjvu_context_t *contextFrom(jlong value) {
    return reinterpret_cast<ddjvu_context_t *>(static_cast<intptr_t>(value));
}

inline ddjvu_document_t *documentFrom(jlong value) {
    return reinterpret_cast<ddjvu_document_t *>(static_cast<intptr_t>(value));
}
struct OutlineEntry {
    std::string label;
    int depth;
    int pageIndex;
};

struct TextWord {
    std::string text;
    int left;
    int bottom;
    int right;
    int top;
};

int outlinePage(ddjvu_document_t *document, const char *url) {
    if (!url || !*url) return -1;
    const char *target = url[0] == '#' ? url + 1 : url;
    if (!*target) return -1;
    return ddjvu_document_search_pageno(document, target);
}

void appendOutlineEntries(ddjvu_document_t *document, miniexp_t items, int depth,
                          std::vector<OutlineEntry> *entries) {
    while (miniexp_consp(items)) {
        miniexp_t item = miniexp_car(items);
        miniexp_t label = miniexp_nth(0, item);
        miniexp_t url = miniexp_nth(1, item);
        const char *labelText = miniexp_to_str(label);
        const char *urlText = miniexp_to_str(url);
        if (labelText && urlText) {
            entries->push_back({labelText, depth, outlinePage(document, urlText)});
            appendOutlineEntries(document, miniexp_cddr(item), depth + 1, entries);
        }
        items = miniexp_cdr(items);
    }
}

void appendTextWords(miniexp_t expression, std::vector<TextWord> *words) {
    if (!miniexp_consp(expression)) return;
    const char *type = miniexp_to_name(miniexp_car(expression));
    if (type && std::strcmp(type, "word") == 0) {
        if (miniexp_length(expression) < 6) return;
        miniexp_t left = miniexp_nth(1, expression);
        miniexp_t bottom = miniexp_nth(2, expression);
        miniexp_t right = miniexp_nth(3, expression);
        miniexp_t top = miniexp_nth(4, expression);
        miniexp_t text = miniexp_nth(5, expression);
        if (!miniexp_numberp(left)
            || !miniexp_numberp(bottom)
            || !miniexp_numberp(right)
            || !miniexp_numberp(top)
            || !miniexp_stringp(text)) {
            return;
        }
        const char *value = miniexp_to_str(text);
        if (!value || !*value) return;
        words->push_back({
            value,
            miniexp_to_int(left),
            miniexp_to_int(bottom),
            miniexp_to_int(right),
            miniexp_to_int(top),
        });
        return;
    }

    for (miniexp_t items = miniexp_cdr(expression);
         miniexp_consp(items);
         items = miniexp_cdr(items)) {
        appendTextWords(miniexp_car(items), words);
    }
}

jobjectArray makeOutlineResult(JNIEnv *env, const std::vector<OutlineEntry> &entries) {
    jclass objectClass = env->FindClass("java/lang/Object");
    jclass byteArrayClass = env->FindClass("[B");
    if (!objectClass || !byteArrayClass) return nullptr;

    const jsize count = static_cast<jsize>(entries.size());
    jobjectArray result = env->NewObjectArray(2, objectClass, nullptr);
    jobjectArray labels = env->NewObjectArray(count, byteArrayClass, nullptr);
    jintArray locations = env->NewIntArray(count * 2);
    if (!result || !labels || !locations) return nullptr;

    std::vector<jint> locationValues(entries.size() * 2);
    for (jsize index = 0; index < count; index++) {
        const OutlineEntry &entry = entries[index];
        jbyteArray label = env->NewByteArray(static_cast<jsize>(entry.label.size()));
        if (!label) return nullptr;
        env->SetByteArrayRegion(
                label,
                0,
                static_cast<jsize>(entry.label.size()),
                reinterpret_cast<const jbyte *>(entry.label.data()));
        env->SetObjectArrayElement(labels, index, label);
        env->DeleteLocalRef(label);
        locationValues[index * 2] = entry.depth;
        locationValues[(index * 2) + 1] = entry.pageIndex;
    }
    env->SetIntArrayRegion(locations, 0, count * 2, locationValues.data());
    env->SetObjectArrayElement(result, 0, labels);
    env->SetObjectArrayElement(result, 1, locations);
    env->DeleteLocalRef(labels);
    env->DeleteLocalRef(locations);
    return result;
}

jobjectArray makeTextResult(JNIEnv *env, const std::vector<TextWord> &words) {
    jclass objectClass = env->FindClass("java/lang/Object");
    jclass byteArrayClass = env->FindClass("[B");
    if (!objectClass || !byteArrayClass) return nullptr;

    const jsize count = static_cast<jsize>(words.size());
    jobjectArray result = env->NewObjectArray(2, objectClass, nullptr);
    jobjectArray texts = env->NewObjectArray(count, byteArrayClass, nullptr);
    jintArray bounds = env->NewIntArray(count * 4);
    if (!result || !texts || !bounds) return nullptr;

    std::vector<jint> boundValues(words.size() * 4);
    for (jsize index = 0; index < count; index++) {
        const TextWord &word = words[index];
        jbyteArray text = env->NewByteArray(static_cast<jsize>(word.text.size()));
        if (!text) return nullptr;
        env->SetByteArrayRegion(
                text,
                0,
                static_cast<jsize>(word.text.size()),
                reinterpret_cast<const jbyte *>(word.text.data()));
        env->SetObjectArrayElement(texts, index, text);
        env->DeleteLocalRef(text);
        boundValues[index * 4] = word.left;
        boundValues[(index * 4) + 1] = word.bottom;
        boundValues[(index * 4) + 2] = word.right;
        boundValues[(index * 4) + 3] = word.top;
    }
    env->SetIntArrayRegion(bounds, 0, count * 4, boundValues.data());
    env->SetObjectArrayElement(result, 0, texts);
    env->SetObjectArrayElement(result, 1, bounds);
    env->DeleteLocalRef(texts);
    env->DeleteLocalRef(bounds);
    return result;
}

}  // namespace

extern "C" JNIEXPORT jlongArray JNICALL
Java_app_reader_DjvuDocument_nativeOpen(JNIEnv *env, jclass, jstring path) {
    const char *filename = env->GetStringUTFChars(path, nullptr);
    if (!filename) return nullptr;

    ddjvu_context_t *context = ddjvu_context_create("Reader");
    if (!context) {
        env->ReleaseStringUTFChars(path, filename);
        throwRuntime(env, "Could not create the DjVu decoder");
        return nullptr;
    }

    ddjvu_document_t *document = ddjvu_document_create_by_filename_utf8(context, filename, 0);
    env->ReleaseStringUTFChars(path, filename);
    if (!document || !waitForDocument(env, context, document)) {
        if (document) ddjvu_document_release(document);
        ddjvu_context_release(context);
        if (!env->ExceptionCheck()) throwRuntime(env, "Could not open the DjVu document");
        return nullptr;
    }

    const int pageCount = ddjvu_document_get_pagenum(document);
    if (pageCount <= 0) {
        ddjvu_document_release(document);
        ddjvu_context_release(context);
        throwRuntime(env, "The DjVu document has no pages");
        return nullptr;
    }

    jlong values[3] = {
        static_cast<jlong>(reinterpret_cast<intptr_t>(context)),
        static_cast<jlong>(reinterpret_cast<intptr_t>(document)),
        static_cast<jlong>(pageCount),
    };
    jlongArray result = env->NewLongArray(3);
    if (result) env->SetLongArrayRegion(result, 0, 3, values);
    return result;
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_app_reader_DjvuDocument_nativeOutline(JNIEnv *env, jclass, jlong contextValue,
                                            jlong documentValue) {
    ddjvu_context_t *context = contextFrom(contextValue);
    ddjvu_document_t *document = documentFrom(documentValue);
    miniexp_t outline;
    while ((outline = ddjvu_document_get_outline(document)) == miniexp_dummy) {
        if (drainMessages(env, context, true)) return nullptr;
    }

    std::vector<OutlineEntry> entries;
    if (outline != miniexp_nil) {
        const char *root = miniexp_to_name(miniexp_car(outline));
        if (!root || std::string(root) != "bookmarks") {
            ddjvu_miniexp_release(document, outline);
            throwRuntime(env, "Could not read the DjVu document outline");
            return nullptr;
        }
        appendOutlineEntries(document, miniexp_cdr(outline), 0, &entries);
        ddjvu_miniexp_release(document, outline);
    }
    return makeOutlineResult(env, entries);
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_app_reader_DjvuDocument_nativePageText(JNIEnv *env, jclass, jlong contextValue,
                                            jlong documentValue, jint pageIndex) {
    ddjvu_context_t *context = contextFrom(contextValue);
    ddjvu_document_t *document = documentFrom(documentValue);
    miniexp_t text;
    while ((text = ddjvu_document_get_pagetext(document, pageIndex, "word")) == miniexp_dummy) {
        if (drainMessages(env, context, true)) return nullptr;
    }

    std::vector<TextWord> words;
    if (text != miniexp_nil) {
        if (!miniexp_consp(text)) {
            const char *status = miniexp_to_name(text);
            throwRuntime(
                    env,
                    status
                        ? std::string("Could not read DjVu page text: ") + status
                        : "Could not read DjVu page text");
            return nullptr;
        }
        appendTextWords(text, &words);
        ddjvu_miniexp_release(document, text);
    }
    return makeTextResult(env, words);
}

extern "C" JNIEXPORT jintArray JNICALL
Java_app_reader_DjvuDocument_nativePageSize(JNIEnv *env, jclass, jlong contextValue,
                                             jlong documentValue, jint pageIndex) {
    ddjvu_pageinfo_t info{};
    if (!readPageInfo(env, contextFrom(contextValue), documentFrom(documentValue), pageIndex, &info)) {
        return nullptr;
    }
    jint values[2] = {static_cast<jint>(info.width), static_cast<jint>(info.height)};
    jintArray result = env->NewIntArray(2);
    if (result) env->SetIntArrayRegion(result, 0, 2, values);
    return result;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_app_reader_DjvuDocument_nativeRender(JNIEnv *env, jclass, jlong contextValue,
                                           jlong documentValue, jint pageIndex, jobject bitmap) {
    ddjvu_context_t *context = contextFrom(contextValue);
    ddjvu_document_t *document = documentFrom(documentValue);
    ddjvu_page_t *page = ddjvu_page_create_by_pageno(document, pageIndex);
    if (!page) {
        throwRuntime(env, "Could not create the DjVu page");
        return JNI_FALSE;
    }
    if (!waitForPage(env, context, page)) {
        ddjvu_page_release(page);
        return JNI_FALSE;
    }

    AndroidBitmapInfo bitmapInfo{};
    void *pixels = nullptr;
    if (AndroidBitmap_getInfo(env, bitmap, &bitmapInfo) != ANDROID_BITMAP_RESULT_SUCCESS ||
        bitmapInfo.format != ANDROID_BITMAP_FORMAT_RGBA_8888 ||
        AndroidBitmap_lockPixels(env, bitmap, &pixels) != ANDROID_BITMAP_RESULT_SUCCESS) {
        ddjvu_page_release(page);
        throwRuntime(env, "Could not access the DjVu page bitmap");
        return JNI_FALSE;
    }

    ddjvu_rect_t pageRect{0, 0, bitmapInfo.width, bitmapInfo.height};
    ddjvu_rect_t targetRect{0, 0, bitmapInfo.width, bitmapInfo.height};
    unsigned int masks[4] = {0x000000ff, 0x0000ff00, 0x00ff0000, 0xff000000};
    ddjvu_format_t *format = ddjvu_format_create(DDJVU_FORMAT_RGBMASK32, 4, masks);
    ddjvu_format_set_row_order(format, TRUE);
    ddjvu_format_set_y_direction(format, TRUE);
    const int rendered = ddjvu_page_render(
        page, DDJVU_RENDER_COLOR, &pageRect, &targetRect, format, bitmapInfo.stride,
        static_cast<char *>(pixels));
    const ddjvu_page_type_t pageType = ddjvu_page_get_type(page);

    ddjvu_format_release(format);
    AndroidBitmap_unlockPixels(env, bitmap);
    ddjvu_page_release(page);
    if (!rendered && pageType != DDJVU_PAGETYPE_UNKNOWN) {
        throwRuntime(env, "DjVuLibre could not render this page");
        return JNI_FALSE;
    }
    return JNI_TRUE;
}

extern "C" JNIEXPORT void JNICALL
Java_app_reader_DjvuDocument_nativeClose(JNIEnv *, jclass, jlong contextValue, jlong documentValue) {
    if (documentValue) ddjvu_document_release(documentFrom(documentValue));
    if (contextValue) ddjvu_context_release(contextFrom(contextValue));
}
