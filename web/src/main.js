import { makeBook } from 'foliate-js/view.js'
import {
    bookId,
    deleteBook,
    listBooks,
    loadBook,
    persistStorage,
    saveBook,
    saveBookCover,
    saveBookProgress,
} from './library.js'

const SUPPORTED_EXTENSIONS = [
    '.epub', '.pdf', '.djvu', '.djv', '.mobi', '.prc', '.azw', '.azw3',
    '.fb2', '.fbz', '.fb2.zip', '.cbz',
    '.txt', '.text', '.md', '.html', '.htm', '.xhtml',
]
const THEME_CYCLE = ['light', 'dark', 'night']
const PREFERENCE_KEY = 'reader.preferences.v1'
const defaults = {
    theme: 'system',
    font: 'publisher',
    fontSize: 100,
    lineHeight: 1.5,
    hideControls: false,
}

const $ = selector => document.querySelector(selector)
const elements = {
    library: $('#library'),
    libraryEmpty: $('#library-empty'),
    libraryGrid: $('#library-grid'),
    openButton: $('#open-button'),
    readerShell: $('#reader-shell'),
    reader: $('#reader'),
    fileInput: $('#file-input'),
    title: $('#book-title'),
    progressText: $('#book-progress'),
    progressSlider: $('#progress-slider'),
    chaptersButton: $('#chapters-button'),
    chaptersDialog: $('#chapters-dialog'),
    chapterList: $('#chapter-list'),
    status: $('#status'),
    settings: $('#settings-dialog'),
    themeButton: $('#theme-button'),
    themeSelect: $('#theme-select'),
    fontSelect: $('#font-select'),
    fontSizeInput: $('#font-size-input'),
    fontSizeOutput: $('#font-size-output'),
    lineHeightInput: $('#line-height-input'),
    lineHeightOutput: $('#line-height-output'),
    hideControlsInput: $('#hide-controls-input'),
}

let preferences = loadPreferences()
let readerView = null
let currentKind = null
let statusTimer = null
let libraryBooks = []
let libraryCoverUrls = []
let hydratingCovers = false
let readerControlsVisible = true
let currentBookId = null
let currentBookStored = false
let pendingBookProgress = null
let progressSaveTimer = null
let progressSavePromise = Promise.resolve()
let currentProgressFraction = 0

function scheduleBookProgress(fraction) {
    if (!currentBookId || !currentBookStored || !Number.isFinite(fraction)) return
    pendingBookProgress = {
        id: currentBookId,
        fraction: Math.max(0, Math.min(1, fraction)),
    }
    clearTimeout(progressSaveTimer)
    progressSaveTimer = setTimeout(() => {
        progressSaveTimer = null
        void persistPendingBookProgress()
    }, 250)
}

function persistPendingBookProgress() {
    const progress = pendingBookProgress
    pendingBookProgress = null
    if (!progress) return progressSavePromise
    progressSavePromise = progressSavePromise
        .then(() => saveBookProgress(progress.id, progress.fraction))
        .catch(error => console.warn('Could not save reading progress', error))
    return progressSavePromise
}

async function flushBookProgress() {
    clearTimeout(progressSaveTimer)
    progressSaveTimer = null
    await persistPendingBookProgress()
}

function loadPreferences() {
    try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(PREFERENCE_KEY)) }
    } catch {
        return { ...defaults }
    }
}

function savePreferences() {
    localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences))
}

function resolvedTheme() {
    if (preferences.theme !== 'system') return preferences.theme
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function nextTheme(theme) {
    const index = THEME_CYCLE.indexOf(theme)
    return THEME_CYCLE[(index + 1) % THEME_CYCLE.length]
}

function fontFamily() {
    return {
        serif: "Georgia, 'Times New Roman', serif",
        sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        mono: "ui-monospace, 'SFMono-Regular', Consolas, monospace",
    }[preferences.font]
}

function bookStyles() {
    const theme = resolvedTheme()
    const family = fontFamily()
    const palettes = {
        light: { background: '#c9fbff', ink: '#040f0f', link: '#57737a' },
        dark: { background: '#040f0f', ink: '#c9fbff', link: '#85bdbf' },
        night: { background: '#0d0805', ink: '#efc58f', link: '#d79a5b' },
    }
    const palette = palettes[theme] ?? palettes.light
    return `
        :root { color-scheme: ${theme === 'light' ? 'light' : 'dark'}; }
        html {
            ${family ? `font-family: ${family} !important;` : ''}
            font-size: ${preferences.fontSize}% !important;
            background: ${palette.background} !important;
            color: ${palette.ink} !important;
        }
        body {
            background: ${palette.background} !important;
            color: ${palette.ink} !important;
        }
        body, p, li, blockquote, dd {
            line-height: ${preferences.lineHeight} !important;
        }
        a:link { color: ${palette.link}; }
        pre { white-space: pre-wrap !important; }
        img, svg, video { max-width: 100%; }
    `
}

function applyPreferences() {
    const theme = resolvedTheme()
    document.documentElement.dataset.theme = theme
    globalThis.ReaderSystemUi?.setTheme(theme)
    document.querySelector('meta[name="color-scheme"]').content = theme === 'light' ? 'light' : 'dark'

    elements.themeSelect.value = preferences.theme
    const upcomingTheme = nextTheme(theme)
    elements.themeButton.title = `Switch to ${upcomingTheme} theme`
    elements.themeButton.setAttribute('aria-label', `Switch to ${upcomingTheme} theme`)
    elements.fontSelect.value = preferences.font
    elements.fontSizeInput.value = String(preferences.fontSize)
    elements.fontSizeOutput.value = `${preferences.fontSize}%`
    elements.lineHeightInput.value = String(preferences.lineHeight)
    elements.lineHeightOutput.value = Number(preferences.lineHeight).toFixed(1)
    elements.hideControlsInput.checked = Boolean(preferences.hideControls)

    if (!preferences.hideControls) readerControlsVisible = true
    applyReaderControlVisibility()

    if (readerView) {
        readerView.classList.toggle('pdf', currentKind === 'pdf')
        readerView.renderer?.setStyles?.(bookStyles())
    }
}

function applyReaderControlVisibility() {
    const hidden = Boolean(readerView && preferences.hideControls && !readerControlsVisible)
    document.body.classList.toggle('reader-controls-hidden', hidden)
}

function setNativeReaderMode(enabled) {
    globalThis.ReaderSystemUi?.setReaderMode(Boolean(enabled))
}

function toggleReaderControls(event) {
    if (!preferences.hideControls || event.defaultPrevented) return
    if (event.target?.closest?.('a, button, input, select, textarea, label')) return
    const selection = event.currentTarget.getSelection?.()
    if (selection && !selection.isCollapsed) return
    readerControlsVisible = !readerControlsVisible
    applyReaderControlVisibility()
}

function listenForReaderTaps({ detail }) {
    const doc = detail.doc
    if (!doc) return
    let touchX = 0
    let touchY = 0
    let gestureMoved = false
    doc.addEventListener('touchstart', event => {
        const touch = event.changedTouches[0]
        touchX = touch.clientX
        touchY = touch.clientY
        gestureMoved = false
    }, { passive: true })
    doc.addEventListener('touchmove', event => {
        const touch = event.changedTouches[0]
        if (Math.hypot(touch.clientX - touchX, touch.clientY - touchY) >= 12) {
            gestureMoved = true
        }
    }, { passive: true })
    doc.addEventListener('click', event => {
        if (gestureMoved) {
            gestureMoved = false
            return
        }
        toggleReaderControls(event)
    })
}

function showStatus(message, isError = false, duration = 0) {
    clearTimeout(statusTimer)
    elements.status.textContent = message
    elements.status.classList.toggle('error', isError)
    elements.status.hidden = false
    if (duration) statusTimer = setTimeout(() => {
        elements.status.hidden = true
    }, duration)
}

function hideStatus() {
    clearTimeout(statusTimer)
    elements.status.hidden = true
}

function chooseBook() {
    elements.fileInput.click()
}

function bookFormat(name) {
    const lower = name.toLowerCase()
    if (lower.endsWith('.fb2.zip')) return 'FBZ'
    return lower.includes('.') ? lower.split('.').pop().toUpperCase() : 'BOOK'
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB']
    let value = bytes
    let unit = -1
    do {
        value /= 1024
        unit += 1
    } while (value >= 1024 && unit < units.length - 1)
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function createBookThumbnail(book) {
    if (book.cover instanceof Blob && book.cover.size > 0) {
        const frame = document.createElement('div')
        frame.className = 'book-cover'
        const image = document.createElement('img')
        const url = URL.createObjectURL(book.cover)
        libraryCoverUrls.push(url)
        image.src = url
        image.alt = ''
        frame.append(image)
        return frame
    }

    const spine = document.createElement('div')
    spine.className = 'book-spine'
    spine.ariaHidden = 'true'
    spine.textContent = bookFormat(book.name)
    return spine
}

async function hydrateMissingCovers(books) {
    const missing = books.filter(book => book.coverChecked !== true)
    if (hydratingCovers || missing.length === 0) return
    hydratingCovers = true
    let changed = false
    try {
        for (const book of missing) {
            let cover = null
            let publication = null
            try {
                const { file } = await loadBook(book.id)
                if (!['text', 'html'].includes(fileKind(file))) {
                    publication = await makeBook(file)
                    cover = await publication.getCover?.() ?? null
                }
            } catch (error) {
                console.warn(`Could not extract a cover from ${book.name}`, error)
            } finally {
                await publication?.destroy?.()
            }
            await saveBookCover(book.id, cover)
            changed = true
        }
    } finally {
        hydratingCovers = false
    }
    if (changed) await renderLibrary({ hydrateCovers: false })
}

function createBookCard(book) {
    const card = document.createElement('article')
    card.className = 'library-card'

    const openButton = document.createElement('button')
    openButton.className = 'library-book-button'
    openButton.type = 'button'
    openButton.setAttribute('aria-label', `Open ${book.title}`)
    openButton.addEventListener('click', () => openStoredBook(book.id))

    const title = document.createElement('strong')
    title.textContent = book.title
    const details = document.createElement('span')
    details.textContent = [book.author, bookFormat(book.name), formatBytes(book.size)]
        .filter(Boolean)
        .join(' · ')
    const progress = Math.max(0, Math.min(1, Number(book.progress) || 0))
    const finished = book.finished === true || progress >= 0.999
    const percentage = finished ? 100 : Math.min(99, Math.floor(progress * 100))
    const progressText = document.createElement('span')
    progressText.className = 'library-book-progress-text'
    progressText.textContent = finished ? 'Finished' : `${percentage}% read`
    const progressBar = document.createElement('progress')
    progressBar.className = 'library-book-progress'
    progressBar.max = 1
    progressBar.value = finished ? 1 : progress
    progressBar.setAttribute(
        'aria-label',
        finished ? `${book.title} finished` : `${percentage}% of ${book.title} read`,
    )
    openButton.append(title, details, progressText, progressBar)

    const removeButton = document.createElement('button')
    removeButton.className = 'icon-button remove-book-button'
    removeButton.type = 'button'
    removeButton.textContent = '×'
    removeButton.title = `Remove ${book.title}`
    removeButton.setAttribute('aria-label', `Remove ${book.title} from library`)
    removeButton.addEventListener('click', async () => {
        if (!confirm(`Remove “${book.title}” from this device?`)) return
        try {
            await deleteBook(book.id)
            if (isDjvuName(book.name)) globalThis.ReaderDjvu?.delete(book.id)
            await renderLibrary()
            showStatus(`Removed ${book.title} from the library.`, false, 2500)
        } catch (error) {
            showStatus(`Could not remove this book: ${error.message}`, true)
        }
    })

    card.append(createBookThumbnail(book), openButton, removeButton)
    return card
}

async function renderLibrary({ hydrateCovers = true } = {}) {
    for (const url of libraryCoverUrls) URL.revokeObjectURL(url)
    libraryCoverUrls = []
    libraryBooks = await listBooks()
    elements.libraryEmpty.hidden = libraryBooks.length > 0
    elements.libraryGrid.hidden = libraryBooks.length === 0
    elements.libraryGrid.replaceChildren(...libraryBooks.map(createBookCard))
    if (!readerView) {
        const count = libraryBooks.length
        elements.progressText.textContent = `${count} ${count === 1 ? 'book' : 'books'} on this device`
    }
    if (hydrateCovers) {
        void hydrateMissingCovers(libraryBooks).catch(error =>
            console.warn('Could not update library covers', error))
    }
}

async function showLibrary() {
    await closeCurrentBook()
    currentKind = null
    elements.library.hidden = false
    elements.readerShell.hidden = true
    readerControlsVisible = true
    applyReaderControlVisibility()
    setNativeReaderMode(false)
    elements.title.textContent = 'Reader'
    elements.openButton.textContent = ''
    elements.openButton.classList.add('plus-button')
    elements.openButton.title = 'Add a book'
    elements.openButton.setAttribute('aria-label', 'Add a book')
    document.title = 'Reader'
    await renderLibrary()
}

async function openStoredBook(id) {
    showStatus('Opening book…')
    try {
        const { metadata, file } = await loadBook(id)
        await openBook(file, { addToLibrary: false, initialProgress: metadata.progress })
    } catch (error) {
        showStatus(`Could not open this library book: ${error.message}`, true)
    }
}

function fileKind(file) {
    const name = file.name.toLowerCase()
    if (name.endsWith('.pdf')) return 'pdf'
    if (isDjvu(file)) return 'djvu'
    if (name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml')) return 'html'
    if (name.endsWith('.txt') || name.endsWith('.text') || name.endsWith('.md')) return 'text'
    return 'ebook'
}

function isSupported(file) {
    const name = file.name.toLowerCase()
    return SUPPORTED_EXTENSIONS.some(extension => name.endsWith(extension))
}

function isDjvu(file) {
    return isDjvuName(file.name) || file.type === 'image/vnd.djvu'
}

function isDjvuName(name) {
    return name.toLowerCase().endsWith('.djvu') || name.toLowerCase().endsWith('.djv')
}

function displayText(value) {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join(', ')
    if (typeof value === 'object') {
        if (value.name) return displayText(value.name)
        return displayText(Object.values(value)[0])
    }
    return String(value)
}

function createChapterList(items) {
    const list = document.createElement('ol')
    for (const item of items) {
        const row = document.createElement('li')
        const button = document.createElement('button')
        button.className = 'chapter-link'
        button.type = 'button'
        button.textContent = displayText(item.label) || 'Untitled chapter'
        const hasLocation = item.href != null
        button.disabled = !hasLocation
        if (hasLocation) {
            button.dataset.href = String(item.href)
            button.addEventListener('click', async () => {
                try {
                    await readerView?.goTo(item.href)
                    elements.chaptersDialog.close()
                } catch (error) {
                    showStatus(`Could not open this chapter: ${error.message}`, true)
                }
            })
        }
        row.append(button)
        if (item.subitems?.length) row.append(createChapterList(item.subitems))
        list.append(row)
    }
    return list
}

function renderChapters(toc) {
    const chapters = Array.isArray(toc) ? toc : []
    elements.chaptersButton.disabled = chapters.length === 0
    elements.chapterList.replaceChildren(
        ...(chapters.length ? [createChapterList(chapters)] : []),
    )
}

function titleFromFile(name) {
    return name
        .replace(/\.fb2\.zip$/i, '')
        .replace(/\.[^.]+$/, '')
        .replaceAll('_', ' ')
        .trim() || 'Untitled book'
}

function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
}

function documentShell(content, title) {
    return `<!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="Content-Security-Policy" content="default-src blob: data:; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; object-src 'none'">
            <title>${escapeHtml(title)}</title>
            <style>
                body { margin: 0 auto; max-width: 48rem; padding: 1rem 1.25rem 3rem; }
                p { margin: 0 0 0.9em; }
            </style>
        </head>
        <body>${content}</body>
        </html>`
}

function textSections(text) {
    const paragraphs = text.replaceAll('\r\n', '\n').split(/\n{2,}/)
    const sections = []
    let current = ''
    for (const paragraph of paragraphs) {
        const html = `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`
        if (current.length > 60_000) {
            sections.push(current)
            current = ''
        }
        current += html
    }
    if (current || !sections.length) sections.push(current || '<p></p>')
    return sections
}

function sanitizeHtml(source) {
    const parsed = new DOMParser().parseFromString(source, 'text/html')
    parsed.querySelectorAll('script, noscript, iframe, frame, object, embed, form, base, style, link').forEach(node => node.remove())
    for (const element of parsed.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase()
            const value = attribute.value.trim().toLowerCase()
            if (name.startsWith('on') || name === 'style') element.removeAttribute(attribute.name)
            if ((name === 'src' || name === 'poster') && !value.startsWith('data:')) {
                element.removeAttribute(attribute.name)
            }
            if (name === 'href' && value.startsWith('javascript:')) {
                element.removeAttribute(attribute.name)
            }
        }
    }
    return {
        title: parsed.title,
        content: parsed.body?.innerHTML || '<p></p>',
    }
}

function makeSimpleBook(parts, title, sourceSize) {
    const sections = parts.map((content, index) => {
        let url = null
        return {
            id: index,
            size: Math.max(1, Math.round(sourceSize / parts.length)),
            load: () => {
                if (!url) url = URL.createObjectURL(new Blob(
                    [documentShell(content, title)],
                    { type: 'text/html' },
                ))
                return url
            },
            unload: () => {
                if (url) URL.revokeObjectURL(url)
                url = null
            },
        }
    })
    return {
        metadata: { title },
        sections,
        splitTOCHref: href => [Number(href), null],
        getTOCFragment: document => document.documentElement,
        isExternal: href => /^https?:|^mailto:/i.test(href),
        destroy: () => sections.forEach(section => section.unload()),
    }
}

async function bookSource(file, kind) {
    if (kind === 'text') {
        return makeSimpleBook(textSections(await file.text()), titleFromFile(file.name), file.size)
    }
    if (kind === 'html') {
        const parsed = sanitizeHtml(await file.text())
        const title = parsed.title || titleFromFile(file.name)
        return makeSimpleBook([parsed.content], title, file.size)
    }
    return file
}

function djvuPageUrl(page, width, height, request) {
    const params = new URLSearchParams({ page, width, height, request })
    return `/__djvu/page?${params}`
}

async function openDjvuBook(file, addToLibrary, initialProgress) {
    const bridge = globalThis.ReaderDjvu
    if (!bridge?.open) throw new Error('DjVu reading requires the Android app')

    const id = bookId(file)
    let info
    try {
        info = JSON.parse(String(bridge.open(id, addToLibrary)))
    } catch (error) {
        throw new Error(`The DjVu decoder returned an invalid response: ${error.message}`)
    }
    if (info.error) throw new Error(info.error)
    if (!Number.isInteger(info.pageCount) || info.pageCount < 1) {
        throw new Error('The DjVu document has no readable pages')
    }

    const toc = Array.isArray(info.toc) ? info.toc : []
    const tocLocations = []
    const collectTocLocations = items => {
        for (const item of items) {
            const page = Number(item.href)
            if (Number.isInteger(page)) tocLocations.push({ item, page })
            if (Array.isArray(item.subitems)) collectTocLocations(item.subitems)
        }
    }
    collectTocLocations(toc)
    tocLocations.sort((left, right) => left.page - right.page)
    const tocItemAt = index => {
        let current = null
        for (const location of tocLocations) {
            if (location.page > index) break
            current = location.item
        }
        return current
    }

    const view = document.createElement('div')
    const canvas = document.createElement('canvas')
    const canvasContext = canvas.getContext('2d', { alpha: false })
    if (!canvasContext) throw new Error('This device cannot display DjVu pages')
    view.className = 'djvu-view'
    canvas.className = 'djvu-page'
    canvas.setAttribute('role', 'img')
    view.append(canvas)
    readerView = view
    elements.reader.replaceChildren(view)

    const pageCache = new Map()
    const pendingPages = new Map()
    const pageAbortController = new AbortController()
    const pageCacheLimit = 5
    let pageIndex = 0
    let renderRequest = 0
    let pageRequestSequence = 0
    let destroyed = false
    let resizeTimer = null
    let renderedWidth = 0
    let renderedHeight = 0

    const targetSize = () => {
        const scale = Math.max(1, devicePixelRatio || 1)
        return {
            width: Math.min(4096, Math.max(720, Math.round(innerWidth * scale))),
            height: Math.min(4096, Math.max(720, Math.round(innerHeight * scale))),
        }
    }
    const pageKey = (index, width, height) => `${index}:${width}x${height}`
    const cachedPage = key => {
        const cached = pageCache.get(key)
        if (!cached) return null
        pageCache.delete(key)
        pageCache.set(key, cached)
        return cached
    }
    const cachePage = (key, bitmap) => {
        pageCache.set(key, bitmap)
        while (pageCache.size > pageCacheLimit) {
            const oldestKey = pageCache.keys().next().value
            pageCache.get(oldestKey)?.close()
            pageCache.delete(oldestKey)
        }
        return bitmap
    }
    const loadPage = index => {
        if (destroyed) return Promise.reject(new Error('The DjVu document is closed'))
        if (index < 0 || index >= info.pageCount) return Promise.resolve(null)
        const { width, height } = targetSize()
        const key = pageKey(index, width, height)
        const cached = cachedPage(key)
        if (cached) return Promise.resolve(cached)
        if (pendingPages.has(key)) return pendingPages.get(key)

        const pending = (async () => {
            const request = `${index}-${++pageRequestSequence}`
            const response = await fetch(djvuPageUrl(index, width, height, request), {
                cache: 'no-store',
                signal: pageAbortController.signal,
            })
            if (!response.ok) {
                const message = await response.text()
                throw new Error(message || `Could not render DjVu page ${index + 1}`)
            }
            const bitmap = await createImageBitmap(await response.blob())
            if (destroyed) {
                bitmap.close()
                throw new Error('The DjVu document is closed')
            }
            return cachePage(key, bitmap)
        })().finally(() => pendingPages.delete(key))
        pendingPages.set(key, pending)
        return pending
    }
    const ignorePrefetchError = error => {
        if (error?.name !== 'AbortError' && !destroyed) {
            console.warn('Could not pre-render an adjacent DjVu page', error)
        }
    }
    const preRenderAround = (index, direction = 1) => {
        const candidates = [index + direction, index - direction, index + (2 * direction)]
            .filter((candidate, position, pages) =>
                candidate >= 0
                && candidate < info.pageCount
                && pages.indexOf(candidate) === position)
        if (!candidates.length) return Promise.resolve()
        const first = loadPage(candidates[0])
        first.then(() => {
            for (const candidate of candidates.slice(1)) {
                void loadPage(candidate).catch(ignorePrefetchError)
            }
        }).catch(ignorePrefetchError)
        return first
    }
    const renderPage = async index => {
        if (destroyed) throw new Error('The DjVu document is closed')
        const nextIndex = Math.max(0, Math.min(info.pageCount - 1, index))
        const direction = Math.sign(nextIndex - pageIndex) || 1
        const request = ++renderRequest
        const { width, height } = targetSize()
        renderedWidth = width
        renderedHeight = height
        const bitmap = await loadPage(nextIndex)
        if (!bitmap || request !== renderRequest || destroyed) return

        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvasContext.fillStyle = '#fff'
        canvasContext.fillRect(0, 0, canvas.width, canvas.height)
        canvasContext.drawImage(bitmap, 0, 0)
        canvas.setAttribute('aria-label', `Page ${nextIndex + 1} of ${info.pageCount}`)
        pageIndex = nextIndex
        const fraction = info.pageCount === 1 ? 0 : pageIndex / (info.pageCount - 1)
        updateLocation({
            detail: {
                fraction,
                pageItem: { label: `${pageIndex + 1} of ${info.pageCount}` },
                tocItem: tocItemAt(pageIndex),
            },
        })
        void preRenderAround(pageIndex, direction)
    }
    const navigate = index => renderPage(index).catch(error => showStatus(error.message, true))
    view.goLeft = () => navigate(pageIndex - 1)
    view.goRight = () => navigate(pageIndex + 1)
    view.goTo = target => {
        const index = Number(target)
        if (!Number.isInteger(index)) {
            return Promise.reject(new Error('This DjVu chapter has no page destination'))
        }
        return renderPage(index)
    }
    view.goToFraction = fraction => renderPage(Math.round(
        Math.max(0, Math.min(1, fraction)) * (info.pageCount - 1),
    ))

    const onResize = () => {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
            const { width, height } = targetSize()
            if (width !== renderedWidth || height !== renderedHeight) navigate(pageIndex)
        }, 180)
    }
    addEventListener('resize', onResize)

    let touchX = 0
    let touchY = 0
    let gestureMoved = false
    view.addEventListener('touchstart', event => {
        const touch = event.changedTouches[0]
        touchX = touch.clientX
        touchY = touch.clientY
        gestureMoved = false
    }, { passive: true })
    view.addEventListener('touchmove', event => {
        const touch = event.changedTouches[0]
        if (Math.hypot(touch.clientX - touchX, touch.clientY - touchY) >= 12) {
            gestureMoved = true
        }
    }, { passive: true })
    view.addEventListener('touchend', event => {
        const touch = event.changedTouches[0]
        const horizontal = touch.clientX - touchX
        const vertical = touch.clientY - touchY
        if (Math.abs(horizontal) < 56 || Math.abs(horizontal) <= Math.abs(vertical)) return
        gestureMoved = true
        if (horizontal < 0) view.goRight()
        else view.goLeft()
    }, { passive: true })
    view.addEventListener('click', event => {
        if (gestureMoved) {
            gestureMoved = false
            return
        }
        toggleReaderControls(event)
    })

    const title = titleFromFile(file.name)
    view.book = {
        metadata: { title },
        toc,
        destroy: () => {
            destroyed = true
            renderRequest += 1
            pageAbortController.abort()
            clearTimeout(resizeTimer)
            removeEventListener('resize', onResize)
            for (const bitmap of pageCache.values()) bitmap.close()
            pageCache.clear()
            bridge.close()
        },
    }

    const initialPage = Math.round(initialProgress * (info.pageCount - 1))
    await renderPage(initialPage)
    const adjacentPage = initialPage < info.pageCount - 1 ? initialPage + 1 : initialPage - 1
    if (adjacentPage >= 0) await loadPage(adjacentPage)
    renderChapters(toc)

    let cover = null
    if (addToLibrary) {
        try {
            const response = await fetch(djvuPageUrl(0, 300, 420, `cover-${Date.now()}`), {
                cache: 'no-store',
            })
            if (response.ok) cover = await response.blob()
        } catch (error) {
            console.warn(`Could not extract a DjVu cover from ${file.name}`, error)
        }
    }

    let storageError = null
    if (addToLibrary) {
        try {
            await saveBook(file, { title, author: '', cover })
            currentBookStored = true
            scheduleBookProgress(currentProgressFraction)
            await renderLibrary()
        } catch (error) {
            storageError = error
            console.error('Could not save the DjVu book to the library', error)
        }
    }

    elements.library.hidden = true
    elements.readerShell.hidden = false
    readerControlsVisible = true
    applyReaderControlVisibility()
    setNativeReaderMode(true)
    applyPreferences()
    elements.title.textContent = title
    elements.openButton.textContent = '←'
    elements.openButton.classList.remove('plus-button')
    elements.openButton.title = 'Back to library'
    elements.openButton.setAttribute('aria-label', 'Back to library')
    document.title = `${title} — Reader`
    if (storageError) {
        showStatus(`Book opened, but could not be saved to the library: ${storageError.message}`, true)
    } else {
        hideStatus()
    }
}

async function closeCurrentBook() {
    if (elements.chaptersDialog.open) elements.chaptersDialog.close()
    renderChapters([])
    await flushBookProgress()
    if (readerView) {
        try {
            await readerView.book?.destroy?.()
        } catch (error) {
            console.warn('Could not release the previous book', error)
        }
        readerView.remove()
        readerView = null
        elements.reader.replaceChildren()
    }
    currentBookId = null
    currentBookStored = false
    currentProgressFraction = 0
}

function goToReadingFraction(view, fraction) {
    const clamped = Math.max(0, Math.min(1, fraction))
    const sectionCount = view?.isFixedLayout ? view.book?.sections?.length : 0
    if (sectionCount) return view.goTo(Math.round(clamped * (sectionCount - 1)))
    return view?.goToFraction(clamped)
}

async function openBook(file, { addToLibrary = true, initialProgress = null } = {}) {
    if (!file) return
    if (!isSupported(file)) {
        showStatus(
            'Unsupported file. Choose EPUB, PDF, DjVu, MOBI, AZW/AZW3, FB2/FBZ, CBZ, TXT, or HTML.',
            true,
        )
        return
    }

    showStatus(`Opening ${file.name}…`)
    await closeCurrentBook()
    currentKind = fileKind(file)
    currentBookId = bookId(file)
    const libraryRecord = libraryBooks.find(book => book.id === currentBookId)
    const resumeProgress = Math.max(0, Math.min(
        1,
        Number.isFinite(initialProgress) ? initialProgress : Number(libraryRecord?.progress) || 0,
    ))
    currentProgressFraction = resumeProgress
    currentBookStored = !addToLibrary || Boolean(libraryRecord)

    if (currentKind === 'djvu') {
        try {
            await openDjvuBook(file, addToLibrary, resumeProgress)
        } catch (error) {
            console.error(error)
            try {
                await showLibrary()
            } catch (libraryError) {
                console.error('Could not restore the library', libraryError)
            }
            showStatus(readableError(error), true)
        }
        return
    }

    const view = document.createElement('foliate-view')
    readerView = view
    elements.reader.replaceChildren(view)
    view.addEventListener('relocate', updateLocation)
    view.addEventListener('load', listenForReaderTaps)

    try {
        await view.open(await bookSource(file, currentKind))
        elements.library.hidden = true
        elements.readerShell.hidden = false
        readerControlsVisible = true
        applyReaderControlVisibility()
        setNativeReaderMode(true)
        applyPreferences()
        await view.renderer.next()
        if (resumeProgress > 0) await goToReadingFraction(view, resumeProgress)

        renderChapters(view.book?.toc)
        const metadata = view.book?.metadata || {}
        const title = displayText(metadata.title) || titleFromFile(file.name)
        const author = displayText(metadata.author)
        let cover = null
        try {
            cover = await view.book?.getCover?.() ?? null
        } catch (error) {
            console.warn(`Could not extract a cover from ${file.name}`, error)
        }
        let storageError = null
        if (addToLibrary) {
            try {
                await saveBook(file, { title, author, cover })
                currentBookStored = true
                scheduleBookProgress(currentProgressFraction)
                await renderLibrary()
            } catch (error) {
                storageError = error
                console.error('Could not save the book to the library', error)
            }
        }

        elements.title.textContent = title
        elements.openButton.textContent = '←'
        elements.openButton.classList.remove('plus-button')
        elements.openButton.title = 'Back to library'
        elements.openButton.setAttribute('aria-label', 'Back to library')
        document.title = `${title} — Reader`
        if (storageError) {
            showStatus(`Book opened, but could not be saved to the library: ${storageError.message}`, true)
        } else {
            hideStatus()
        }
    } catch (error) {
        console.error(error)
        try {
            await showLibrary()
        } catch (libraryError) {
            console.error('Could not restore the library', libraryError)
        }
        showStatus(readableError(error), true)
    }
}

function readableError(error) {
    const name = error?.name || error?.constructor?.name
    if (name === 'UnsupportedTypeError') return 'This file is not a supported or valid ebook.'
    if (name === 'NotFoundError') return 'The selected book is empty or unavailable.'
    return `Could not open this book${error?.message ? `: ${error.message}` : '.'}`
}

function updateLocation({ detail }) {
    const sectionIndex = detail.section?.current
    const sectionCount = detail.section?.total
    const fixedLayoutLocation = readerView?.isFixedLayout
        && Number.isInteger(sectionIndex)
        && Number.isInteger(sectionCount)
        && sectionCount > 0
    const fraction = fixedLayoutLocation
        ? (sectionCount === 1 ? 0 : sectionIndex / (sectionCount - 1))
        : (Number.isFinite(detail.fraction) ? detail.fraction : 0)
    elements.progressSlider.value = String(fraction)
    currentProgressFraction = fraction
    scheduleBookProgress(fraction)
    const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)))
    const fixedPage = fixedLayoutLocation ? `${sectionIndex + 1} of ${sectionCount}` : null
    const page = detail.pageItem?.label || fixedPage || detail.location?.current
    elements.progressText.textContent = page ? `${percent}% · Page ${page}` : `${percent}% read`
    const currentHref = detail.tocItem?.href
    for (const button of elements.chapterList.querySelectorAll('[data-href]')) {
        if (currentHref != null && button.dataset.href === String(currentHref)) {
            button.setAttribute('aria-current', 'location')
        } else {
            button.removeAttribute('aria-current')
        }
    }
}

function updatePreference(name, value) {
    preferences[name] = value
    savePreferences()
    applyPreferences()
}

elements.openButton.addEventListener('click', () => {
    if (readerView) {
        showLibrary().catch(error => showStatus(`Could not open the library: ${error.message}`, true))
    } else {
        chooseBook()
    }
})
$('#library-empty-button').addEventListener('click', chooseBook)
$('#previous-button').addEventListener('click', () => readerView?.goLeft())
$('#next-button').addEventListener('click', () => readerView?.goRight())
$('#settings-button').addEventListener('click', () => elements.settings.showModal())
elements.settings.addEventListener('click', event => {
    if (event.target !== elements.settings) return
    const bounds = elements.settings.getBoundingClientRect()
    const outside = event.clientX < bounds.left
        || event.clientX > bounds.right
        || event.clientY < bounds.top
        || event.clientY > bounds.bottom
    if (outside) elements.settings.close()
})
$('#chapters-button').addEventListener('click', () => {
    if (!elements.chaptersButton.disabled) elements.chaptersDialog.showModal()
})
elements.themeButton.addEventListener('click', () => {
    updatePreference('theme', nextTheme(resolvedTheme()))
})

const navigateToSliderPosition = event =>
    goToReadingFraction(readerView, Number(event.target.value))?.catch(console.error)
elements.progressSlider.addEventListener('input', event => {
    if (currentKind !== 'djvu') navigateToSliderPosition(event)
})
elements.progressSlider.addEventListener('change', event => {
    if (currentKind === 'djvu') navigateToSliderPosition(event)
})
elements.fileInput.addEventListener('change', event => {
    openBook(event.target.files?.[0])
    event.target.value = ''
})
elements.themeSelect.addEventListener('change', event => updatePreference('theme', event.target.value))
elements.fontSelect.addEventListener('change', event => updatePreference('font', event.target.value))
elements.fontSizeInput.addEventListener('input', event => updatePreference('fontSize', Number(event.target.value)))
elements.lineHeightInput.addEventListener('input', event => updatePreference('lineHeight', Number(event.target.value)))
elements.hideControlsInput.addEventListener('change', event =>
    updatePreference('hideControls', event.target.checked))

addEventListener('keydown', event => {
    if (!readerView || elements.settings.open) return
    if (event.key === 'Escape' && !readerControlsVisible) {
        readerControlsVisible = true
        applyReaderControlVisibility()
        return
    }
    if (event.key === 'ArrowLeft') readerView.goLeft()
    if (event.key === 'ArrowRight') readerView.goRight()
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preferences.theme === 'system') applyPreferences()
})

async function openPendingAndroidBook() {
    const params = new URLSearchParams(location.search)
    if (params.get('open') !== '1') return
    try {
        const response = await fetch('/__book', { cache: 'no-store' })
        if (!response.ok) throw new Error(await response.text())
        const blob = await response.blob()
        const name = params.get('name') || 'book'
        const type = params.get('type') || blob.type
        await openBook(new File([blob], name, { type }))
    } catch (error) {
        showStatus(`Could not receive the shared book: ${error.message}`, true)
    }
}

async function initializeApp() {
    applyPreferences()
    await persistStorage()
    try {
        await renderLibrary()
    } catch (error) {
        showStatus(`Could not load the library: ${error.message}`, true)
    }
    await openPendingAndroidBook()
}

initializeApp()
