#include <android/bitmap.h>
#include <android/log.h>
#include <jni.h>

#include <cstdint>
#include <string>
#include <unistd.h>

#include "ddjvuapi.h"

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
