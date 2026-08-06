import { cp, mkdir } from 'node:fs/promises'

const source = new URL('../node_modules/foliate-js/vendor/pdfjs/', import.meta.url)
const destination = new URL('../app/src/main/assets/web/assets/vendor/pdfjs/', import.meta.url)

await mkdir(destination, { recursive: true })
await cp(source, destination, { recursive: true })
