const DATABASE_NAME = 'reader.library'
const DATABASE_VERSION = 1
const METADATA_STORE = 'metadata'
const FILE_STORE = 'files'

let databasePromise

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
    })
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', resolve, { once: true })
        transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
        transaction.addEventListener('error', () => reject(transaction.error), { once: true })
    })
}

function openDatabase() {
    if (databasePromise) return databasePromise
    databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
        request.addEventListener('upgradeneeded', () => {
            const database = request.result
            if (!database.objectStoreNames.contains(METADATA_STORE)) {
                database.createObjectStore(METADATA_STORE, { keyPath: 'id' })
            }
            if (!database.objectStoreNames.contains(FILE_STORE)) {
                database.createObjectStore(FILE_STORE, { keyPath: 'id' })
            }
        })
        request.addEventListener('success', () => resolve(request.result), { once: true })
        request.addEventListener('error', () => reject(request.error), { once: true })
        request.addEventListener('blocked', () => reject(new Error('The library database is blocked')), { once: true })
    })
    return databasePromise
}

function idForFile(file) {
    return `${file.name.trim().toLocaleLowerCase()}\u0000${file.size}\u0000${file.type}`
}

export function bookId(file) {
    return idForFile(file)
}

export async function persistStorage() {
    try {
        return await navigator.storage?.persist?.() ?? false
    } catch {
        return false
    }
}

export async function listBooks() {
    const database = await openDatabase()
    const transaction = database.transaction(METADATA_STORE, 'readonly')
    const books = await requestResult(transaction.objectStore(METADATA_STORE).getAll())
    return books.sort((left, right) => right.addedAt - left.addedAt)
}

export async function saveBook(file, details) {
    const database = await openDatabase()
    const transaction = database.transaction([METADATA_STORE, FILE_STORE], 'readwrite')
    const done = transactionDone(transaction)
    const metadataStore = transaction.objectStore(METADATA_STORE)
    const previous = await requestResult(metadataStore.get(idForFile(file)))
    const progress = Number.isFinite(previous?.progress)
        ? Math.max(0, Math.min(1, previous.progress))
        : 0
    const record = {
        id: idForFile(file),
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        addedAt: previous?.addedAt ?? Date.now(),
        title: details.title,
        author: details.author,
        cover: details.cover ?? null,
        coverChecked: true,
        progress,
        finished: previous?.finished === true,
        location: previous?.location ?? null,
        lastReadAt: previous?.lastReadAt ?? null,
    }
    metadataStore.put(record)
    transaction.objectStore(FILE_STORE).put({ id: record.id, file })
    await done
    return record
}

export async function saveBookCover(id, cover) {
    const database = await openDatabase()
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(METADATA_STORE)
    const metadata = await requestResult(store.get(id))
    if (!metadata) throw new Error('The stored book metadata is unavailable')
    store.put({ ...metadata, cover: cover ?? null, coverChecked: true })
    await done
}

export async function saveBookFinished(id, finished = true) {
    const database = await openDatabase()
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(METADATA_STORE)
    const metadata = await requestResult(store.get(id))
    if (!metadata) throw new Error('The stored book metadata is unavailable')
    store.put({
        ...metadata,
        finished: Boolean(finished),
    })
    await done
}

export async function saveBookProgress(id, fraction, location = null) {
    const database = await openDatabase()
    const transaction = database.transaction(METADATA_STORE, 'readwrite')
    const done = transactionDone(transaction)
    const store = transaction.objectStore(METADATA_STORE)
    const metadata = await requestResult(store.get(id))
    if (!metadata) throw new Error('The stored book metadata is unavailable')
    const progress = Math.max(0, Math.min(1, Number(fraction) || 0))
    store.put({
        ...metadata,
        progress,
        location: location != null ? String(location) : (metadata.location ?? null),
        finished: metadata.finished === true,
        lastReadAt: Date.now(),
    })
    await done
}

export async function loadBook(id) {
    const database = await openDatabase()
    const transaction = database.transaction([METADATA_STORE, FILE_STORE], 'readonly')
    const metadataRequest = transaction.objectStore(METADATA_STORE).get(id)
    const fileRequest = transaction.objectStore(FILE_STORE).get(id)
    const [metadata, stored] = await Promise.all([
        requestResult(metadataRequest),
        requestResult(fileRequest),
    ])
    if (!metadata || !stored?.file) throw new Error('The stored book is unavailable')
    const file = stored.file instanceof File
        ? stored.file
        : new File([stored.file], metadata.name, {
            type: metadata.type,
            lastModified: metadata.lastModified,
        })
    return { metadata, file }
}

export async function deleteBook(id) {
    const database = await openDatabase()
    const transaction = database.transaction([METADATA_STORE, FILE_STORE], 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore(METADATA_STORE).delete(id)
    transaction.objectStore(FILE_STORE).delete(id)
    await done
}
