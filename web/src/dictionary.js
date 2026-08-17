const BUCKET_CACHE_LIMIT = 4
const PARTS_OF_SPEECH = {
    n: 'Noun',
    v: 'Verb',
    a: 'Adjective',
    r: 'Adverb',
}

const bucketCache = new Map()

export function normalizeLookupTerm(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u00ad/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/[‐‑‒–—]/g, '-')
        .replace(/(\p{L})-\s+(\p{L})/gu, '$1$2')
        .replaceAll('_', ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
        .toLocaleLowerCase('en-US')
}

export function lookupTermFromSelection(value) {
    const term = normalizeLookupTerm(value)
    if (!term || term.length > 80 || term.split(' ').length > 6) return null
    return term
}

function bucketName(value) {
    const initial = value
        .normalize('NFD')
        .replace(/\p{M}/gu, '')[0]
    return initial >= 'a' && initial <= 'z' ? initial : '0'
}

async function decodeBucket(response) {
    if (response.headers.get('content-encoding') === 'gzip') return response.json()
    if (!response.body || typeof DecompressionStream !== 'function') {
        throw new Error('This browser cannot decompress the dictionary data')
    }
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'))
    return new Response(stream).json()
}

function loadBucket(name) {
    const cached = bucketCache.get(name)
    if (cached) {
        bucketCache.delete(name)
        bucketCache.set(name, cached)
        return cached
    }

    const pending = fetch(`/dictionary/${name}.dict`, { cache: 'force-cache' })
        .then(response => {
            if (!response.ok) throw new Error(`Dictionary data is unavailable (${response.status})`)
            return decodeBucket(response)
        })
        .then(bucket => {
            if (bucket?.version !== 1 || !bucket.entries || !bucket.aliases) {
                throw new Error('Dictionary data has an unsupported format')
            }
            return bucket
        })
        .catch(error => {
            if (bucketCache.get(name) === pending) bucketCache.delete(name)
            throw error
        })
    bucketCache.set(name, pending)
    while (bucketCache.size > BUCKET_CACHE_LIMIT) {
        bucketCache.delete(bucketCache.keys().next().value)
    }
    return pending
}

function addCandidate(candidates, value) {
    if (value && !candidates.includes(value)) candidates.push(value)
}

function inflectionCandidates(term) {
    const words = term.split(' ')
    const word = words.pop()
    const prefix = words.length ? `${words.join(' ')} ` : ''
    const candidates = []
    const addStem = stem => addCandidate(candidates, `${prefix}${stem}`)
    const replaceSuffix = (suffix, replacement) => {
        if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
            addStem(`${word.slice(0, -suffix.length)}${replacement}`)
        }
    }

    for (const [suffix, replacement] of [
        ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'],
        ['men', 'man'], ['ies', 'y'], ['ves', 'f'], ['ves', 'fe'], ['s', ''],
        ['ied', 'y'], ['ies', 'y'], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', ''],
        ['est', ''], ['est', 'e'], ['er', ''], ['er', 'e'],
    ]) replaceSuffix(suffix, replacement)

    for (const suffix of ['ed', 'ing', 'er', 'est']) {
        if (!word.endsWith(suffix)) continue
        const stem = word.slice(0, -suffix.length)
        if (stem.length > 2 && stem.at(-1) === stem.at(-2)) addStem(stem.slice(0, -1))
    }
    return candidates
}

function aliasValues(value) {
    if (!value) return []
    return Array.isArray(value) ? value : [value]
}

async function resolveLemmas(term) {
    const lemmas = []
    const initialBucket = await loadBucket(bucketName(term))
    if (initialBucket.entries[term]) addCandidate(lemmas, term)
    for (const lemma of aliasValues(initialBucket.aliases[term])) addCandidate(lemmas, lemma)

    if (term.includes('-')) {
        const unhyphenated = term.replaceAll('-', '')
        const unhyphenatedBucket = await loadBucket(bucketName(unhyphenated))
        if (unhyphenatedBucket.entries[unhyphenated]) addCandidate(lemmas, unhyphenated)
        for (const lemma of aliasValues(unhyphenatedBucket.aliases[unhyphenated])) {
            addCandidate(lemmas, lemma)
        }
    }

    if (!lemmas.length) {
        const candidates = inflectionCandidates(term)
        if (term.includes('-')) {
            const unhyphenated = term.replaceAll('-', '')
            for (const cand of inflectionCandidates(unhyphenated)) {
                addCandidate(candidates, cand)
            }
        }
        for (const candidate of candidates) {
            const bucket = await loadBucket(bucketName(candidate))
            if (bucket.entries[candidate]) addCandidate(lemmas, candidate)
            for (const lemma of aliasValues(bucket.aliases[candidate])) addCandidate(lemmas, lemma)
            if (lemmas.length >= 4) break
        }
    }
    return lemmas
}

function expandRecord(lemma, record) {
    return {
        lemma,
        pronunciations: record[0].map(([value, variety]) => ({ value, variety: variety ?? null })),
        senses: record[1].map(sense => ({
            partOfSpeech: PARTS_OF_SPEECH[sense[0]] ?? sense[0],
            definition: sense[1],
            examples: sense[2] ?? [],
            synonyms: sense[3] ?? [],
        })),
    }
}

export async function lookupDictionary(value) {
    const term = normalizeLookupTerm(value)
    if (!term) return { term, matches: [] }

    const lemmas = await resolveLemmas(term)
    const matches = []
    for (const lemma of lemmas) {
        const bucket = await loadBucket(bucketName(lemma))
        const record = bucket.entries[lemma]
        if (record) matches.push(expandRecord(lemma, record))
    }
    return { term, matches }
}
