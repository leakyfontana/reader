cmake_minimum_required(VERSION 3.22.1)
project(reader_djvu LANGUAGES C CXX)

set(DJVU_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/djvulibre/libdjvu")
# DjVuLibre source: https://github.com/max-kammerer/djvulibre at
# fd7b8db8fffba96fd1f053797704355f2bfd7849 (GPL-2.0-or-later).

add_library(djvucore STATIC
    ${DJVU_ROOT}/JB2EncodeCodec.cpp
    ${DJVU_ROOT}/JB2Image.cpp
    ${DJVU_ROOT}/JPEGDecoder.cpp
    ${DJVU_ROOT}/MMRDecoder.cpp
    ${DJVU_ROOT}/MMX.cpp
    ${DJVU_ROOT}/UnicodeByteStream.cpp
    ${DJVU_ROOT}/XMLParser.cpp
    ${DJVU_ROOT}/XMLTags.cpp
    ${DJVU_ROOT}/ZPCodec.cpp
    ${DJVU_ROOT}/Arrays.cpp
    ${DJVU_ROOT}/atomic.cpp
    ${DJVU_ROOT}/BSByteStream.cpp
    ${DJVU_ROOT}/BSEncodeByteStream.cpp
    ${DJVU_ROOT}/ByteStream.cpp
    ${DJVU_ROOT}/DataPool.cpp
    ${DJVU_ROOT}/ddjvuapi.cpp
    ${DJVU_ROOT}/debug.cpp
    ${DJVU_ROOT}/DjVmDir.cpp
    ${DJVU_ROOT}/DjVmDir0.cpp
    ${DJVU_ROOT}/DjVmDoc.cpp
    ${DJVU_ROOT}/DjVmNav.cpp
    ${DJVU_ROOT}/DjVuAnno.cpp
    ${DJVU_ROOT}/DjVuDocEditor.cpp
    ${DJVU_ROOT}/DjVuDocument.cpp
    ${DJVU_ROOT}/DjVuDumpHelper.cpp
    ${DJVU_ROOT}/DjVuErrorList.cpp
    ${DJVU_ROOT}/DjVuFile.cpp
    ${DJVU_ROOT}/DjVuFileCache.cpp
    ${DJVU_ROOT}/DjVuGlobal.cpp
    ${DJVU_ROOT}/DjVuGlobalMemory.cpp
    ${DJVU_ROOT}/DjVuImage.cpp
    ${DJVU_ROOT}/DjVuInfo.cpp
    ${DJVU_ROOT}/DjVuMessage.cpp
    ${DJVU_ROOT}/DjVuMessageLite.cpp
    ${DJVU_ROOT}/DjVuNavDir.cpp
    ${DJVU_ROOT}/DjVuPalette.cpp
    ${DJVU_ROOT}/DjVuPort.cpp
    ${DJVU_ROOT}/DjVuText.cpp
    ${DJVU_ROOT}/DjVuToPS.cpp
    ${DJVU_ROOT}/GBitmap.cpp
    ${DJVU_ROOT}/GContainer.cpp
    ${DJVU_ROOT}/GException.cpp
    ${DJVU_ROOT}/GIFFManager.cpp
    ${DJVU_ROOT}/GMapAreas.cpp
    ${DJVU_ROOT}/GOS.cpp
    ${DJVU_ROOT}/GPixmap.cpp
    ${DJVU_ROOT}/GRect.cpp
    ${DJVU_ROOT}/GScaler.cpp
    ${DJVU_ROOT}/GSmartPointer.cpp
    ${DJVU_ROOT}/GString.cpp
    ${DJVU_ROOT}/GThreads.cpp
    ${DJVU_ROOT}/GUnicode.cpp
    ${DJVU_ROOT}/GURL.cpp
    ${DJVU_ROOT}/IFFByteStream.cpp
    ${DJVU_ROOT}/IW44EncodeCodec.cpp
    ${DJVU_ROOT}/IW44Image.cpp
    ${DJVU_ROOT}/miniexp.cpp
)

target_include_directories(djvucore PUBLIC ${DJVU_ROOT})
target_compile_features(djvucore PRIVATE cxx_std_17)
target_compile_definitions(djvucore PRIVATE
    HAVE_PTHREAD NO_LIBGCC_HOOKS HAVE_STDINT_H HAVE_NAMESPACES HAVE_STDINCLUDES
    HAS_WCHAR HAVE_WCHAR_H HAVE_MBSTATE_T HAS_MBSTATE UNIX
)

add_library(reader_djvu SHARED djvu_jni.cpp)
target_include_directories(reader_djvu PRIVATE ${DJVU_ROOT})
target_compile_features(reader_djvu PRIVATE cxx_std_17)
target_compile_options(reader_djvu PRIVATE -fexceptions -frtti)
target_link_libraries(reader_djvu PRIVATE djvucore android jnigraphics log m)

if(ANDROID_ABI STREQUAL "arm64-v8a" OR ANDROID_ABI STREQUAL "x86_64")
    target_link_options(reader_djvu PRIVATE "-Wl,-z,max-page-size=16384")
endif()
