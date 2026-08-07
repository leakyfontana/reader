import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { unzipSync } from 'fflate'

const SOURCE_SHA256 = '7d749f6e2c39e6970e4997839dcf6e42fd281f3c2fae0171d2192bae8cfa4b51'
const SOURCE_URL = 'https://en-word.net/downloads/english-wordnet-2025-json.zip'
const BUCKET_NAMES = ['0', ...'abcdefghijklmnopqrstuvwxyz']
const PARTS_OF_SPEECH = {
    n: 'n',
    v: 'v',
    a: 'a',
    s: 'a',
    r: 'r',
}
const NOTICE = `Open English WordNet 2025

Copyright (c) 2019-present, The Open English WordNet Team.
Source: ${SOURCE_URL}
Source SHA-256: ${SOURCE_SHA256}
Project: https://en-word.net/
License: Creative Commons Attribution 4.0 International
License URL: https://creativecommons.org/licenses/by/4.0/

Reader converts the source JSON into letter-bucketed lookup files, removes lexical
relations that are not displayed, and retains lemmas, inflected forms,
pronunciations, parts of speech, definitions, examples, and synonyms.

This resource is derived from Princeton WordNet under the WordNet License and
further developed under the Creative Commons Attribution 4.0 International
License. You may share and adapt this resource providing attribution is given
to both Princeton WordNet and the Open English WordNet team.

WordNet license notice

Open English WordNet Copyright by the Open English WordNet team.

Permission to use, copy, modify and distribute this software and database and
its documentation for any purpose and without fee or royalty is hereby granted,
provided that you agree to comply with the following copyright notice and
statements, including the disclaimer, and that the same appear on all copies of
the software, database and documentation, including modifications that you make
for internal use or for distribution.

WordNet 3.1 Copyright 2011 by Princeton University. All rights reserved.

THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES
NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT
NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF
MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY
PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

The name of Princeton University or Princeton may not be used in advertising or
publicity pertaining to distribution of the software and/or database. Title to
copyright in this software, database and any associated documentation shall at
all times remain with Princeton University and LICENSEE agrees to preserve same.
`

const archivePath = process.argv[2]
if (!archivePath) {
    throw new Error('Usage: node scripts/build-dictionary.mjs <english-wordnet-2025-json.zip>')
}

const normalizeKey = value => String(value)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US')

const bucketName = value => {
    const initial = normalizeKey(value)
        .normalize('NFD')
        .replace(/\p{M}/gu, '')[0]
    return initial >= 'a' && initial <= 'z' ? initial : '0'
}

const decodeJson = (archive, name) => {
    const contents = archive[name]
    if (!contents) throw new Error(`The source archive is missing ${name}`)
    return JSON.parse(new TextDecoder().decode(contents))
}

const addUnique = (values, value) => {
    if (value && !values.some(current => JSON.stringify(current) === JSON.stringify(value))) {
        values.push(value)
    }
}

const source = await readFile(resolve(archivePath))
const digest = createHash('sha256').update(source).digest('hex')
if (digest !== SOURCE_SHA256) {
    throw new Error(`Unexpected Open English WordNet archive SHA-256: ${digest}`)
}

const archive = unzipSync(new Uint8Array(source))
const synsets = new Map()
const synsetFiles = Object.keys(archive)
    .filter(name => /^(?:adj|adv|noun|verb)\..+\.json$/.test(name))
    .sort()

for (const name of synsetFiles) {
    for (const [id, synset] of Object.entries(decodeJson(archive, name))) {
        const definitions = Array.isArray(synset.definition) ? synset.definition : []
        if (!definitions.length) continue
        synsets.set(id, [
            PARTS_OF_SPEECH[synset.partOfSpeech] ?? synset.partOfSpeech,
            definitions.join('; '),
            Array.isArray(synset.example) ? synset.example : [],
            Array.isArray(synset.members) ? synset.members : [],
        ])
    }
}

const entriesByBucket = new Map(BUCKET_NAMES.map(name => [name, new Map()]))
const aliasesByBucket = new Map(BUCKET_NAMES.map(name => [name, new Map()]))
const seenSynsetsByLemma = new Map()
const entryFiles = Object.keys(archive)
    .filter(name => /^entries-(?:0|[a-z])\.json$/.test(name))
    .sort()

const addAlias = (form, lemma) => {
    const normalizedForm = normalizeKey(form)
    if (!normalizedForm || normalizedForm === lemma) return
    const aliases = aliasesByBucket.get(bucketName(normalizedForm))
    const lemmas = aliases.get(normalizedForm) ?? new Set()
    lemmas.add(lemma)
    aliases.set(normalizedForm, lemmas)
}

for (const name of entryFiles) {
    for (const [displayLemma, parts] of Object.entries(decodeJson(archive, name))) {
        const lemma = normalizeKey(displayLemma)
        if (!lemma) continue
        const entries = entriesByBucket.get(bucketName(lemma))
        const record = entries.get(lemma) ?? [[], []]
        const seenSynsets = seenSynsetsByLemma.get(lemma) ?? new Set()

        for (const part of Object.values(parts)) {
            for (const pronunciation of part.pronunciation ?? []) {
                const value = String(pronunciation.value ?? '').trim()
                if (!value) continue
                addUnique(record[0], pronunciation.variety
                    ? [value, String(pronunciation.variety)]
                    : [value])
            }
            for (const form of part.form ?? []) addAlias(form, lemma)
            for (const sense of part.sense ?? []) {
                if (seenSynsets.has(sense.synset)) continue
                const synset = synsets.get(sense.synset)
                if (!synset) continue
                const synonyms = synset[3]
                    .map(member => String(member).replaceAll('_', ' '))
                    .filter(member => normalizeKey(member) !== lemma)
                const compactSense = [synset[0], synset[1]]
                if (synset[2].length || synonyms.length) compactSense.push(synset[2])
                if (synonyms.length) compactSense.push(synonyms)
                seenSynsets.add(sense.synset)
                record[1].push(compactSense)
            }
        }
        if (record[1].length) entries.set(lemma, record)
        seenSynsetsByLemma.set(lemma, seenSynsets)
    }
}

const outputDirectory = new URL('../web/public/dictionary/', import.meta.url)
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const manifest = {
    version: 1,
    format: 'gzip-json-letter-buckets-v1',
    source: 'Open English WordNet 2025',
    sourceUrl: SOURCE_URL,
    sourceSha256: SOURCE_SHA256,
    license: 'CC BY 4.0 and the Princeton WordNet License',
    buckets: {},
}

for (const name of BUCKET_NAMES) {
    const entries = Object.fromEntries([...entriesByBucket.get(name)].sort(([left], [right]) =>
        left.localeCompare(right, 'en')))
    const aliases = Object.fromEntries([...aliasesByBucket.get(name)]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([form, lemmas]) => {
            const values = [...lemmas].sort((left, right) => left.localeCompare(right, 'en'))
            return [form, values.length === 1 ? values[0] : values]
        }))
    const contents = JSON.stringify({ version: 1, entries, aliases })
    const compressed = gzipSync(contents, { level: 9 })
    await writeFile(new URL(`${name}.dict`, outputDirectory), compressed)
    manifest.buckets[name] = {
        entries: Object.keys(entries).length,
        aliases: Object.keys(aliases).length,
        bytes: Buffer.byteLength(contents),
        compressedBytes: compressed.byteLength,
    }
}

await writeFile(
    new URL('manifest.json', outputDirectory),
    `${JSON.stringify(manifest, null, 2)}\n`,
)
await writeFile(new URL('NOTICE.txt', outputDirectory), NOTICE)

const totalEntries = Object.values(manifest.buckets)
    .reduce((sum, bucket) => sum + bucket.entries, 0)
const totalAliases = Object.values(manifest.buckets)
    .reduce((sum, bucket) => sum + bucket.aliases, 0)
const totalBytes = Object.values(manifest.buckets)
    .reduce((sum, bucket) => sum + bucket.bytes, 0)
const totalCompressedBytes = Object.values(manifest.buckets)
    .reduce((sum, bucket) => sum + bucket.compressedBytes, 0)
console.log(
    `Wrote ${totalEntries} entries and ${totalAliases} aliases `
    + `(${totalBytes} bytes raw, ${totalCompressedBytes} bytes compressed)`,
)
