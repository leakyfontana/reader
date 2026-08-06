import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [{
        name: 'foliate-android-patches',
        enforce: 'pre',
        transform(code, id) {
            if (id.endsWith('/foliate-js/paginator.js')) {
                return code.replace(
                    `#onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return`,
                    `#onTouchEnd() {
        const touchMoved = this.#touchScrolled
        this.#touchScrolled = false
        if (this.scrolled || !touchMoved) return`,
                )
            }
            if (!id.endsWith('/foliate-js/pdf.js')) return null
            return code
                .replace(
                    'new URL(`vendor/pdfjs/${path}`, import.meta.url)',
                    'new URL(/* @vite-ignore */ `vendor/pdfjs/${path}`, import.meta.url)',
                )
                .replace(
                    'const onZoom = ({ doc, scale }) => render(page, doc, scale)',
                    `let rendering = false
    let renderedScale
    let requestedScale
    const onZoom = ({ doc, scale }) => {
        requestedScale = scale
        if (rendering || scale === renderedScale) return
        rendering = true
        const draw = async () => {
            try {
                while (requestedScale !== renderedScale) {
                    const nextScale = requestedScale
                    await render(page, doc, nextScale)
                    renderedScale = nextScale
                }
            } finally {
                rendering = false
            }
        }
        void draw().catch(console.error)
    }`,
                )
        },
    }],
    root: 'web',
    base: './',
    build: {
        outDir: '../app/src/main/assets/web',
        emptyOutDir: true,
        target: 'es2022',
    },
})
