import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(path.join(root, '.docs-check-'))
const sources = [
  { file: 'README.md', kind: 'markdown' },
  { file: 'docs/index.html', kind: 'html' },
]
const samples = []
const decodeHtml = (value) => value
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))

for (const source of sources) {
  const content = await readFile(path.join(root, source.file), 'utf8')
  if (source.kind === 'markdown') {
    const pattern = /^ {0,3}(\x60{3,}|~{3,})\s*(tsx|ts)([^\n]*)\n([\s\S]*?)\n {0,3}\1\s*$/gm
    for (const match of content.matchAll(pattern)) {
      samples.push({
        file: source.file,
        line: content.slice(0, match.index).split('\n').length,
        code: match[4],
        language: match[2],
        noCheck: /\bno-check\b/.test(match[3]),
      })
    }
    continue
  }

  const pattern = /<pre\b[^>]*>\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*<\/pre>/gi
  for (const match of content.matchAll(pattern)) {
    const attributes = match[1]
    const code = decodeHtml(match[2].replace(/<span\b[^>]*>|<\/span>/gi, ''))
    if (!/\b(?:import|export)\s+(?:[\w*{]|type\b)|\b(?:interface|type)\s+\w+/.test(code)) continue
    samples.push({
      file: source.file,
      line: content.slice(0, match.index).split('\n').length,
      code,
      language: /\btsx\b/i.test(attributes) ? 'tsx' : 'ts',
      noCheck: /\bno-check\b/i.test(attributes),
    })
  }
}

if (samples.length === 0) {
  console.error('No TypeScript documentation samples found.')
  process.exitCode = 1
} else {
  const checked = []
  const skipped = []
  for (const [index, sample] of samples.entries()) {
    if (sample.noCheck) {
      skipped.push(sample)
      continue
    }
    const extension = sample.language === 'tsx' ? 'tsx' : 'ts'
    const file = path.join(temp, String(index + 1).padStart(3, '0') + '.' + extension)
    await writeFile(file, sample.code + '\n')
    checked.push({ ...sample, path: file })
  }

  if (checked.length) {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    if (config.error) {
      console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
      process.exitCode = 1
    } else {
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
      const options = {
        ...parsed.options,
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        jsx: ts.JsxEmit.Preserve,
      }
      const program = ts.createProgram(checked.map((sample) => sample.path), options)
      const diagnostics = ts.getPreEmitDiagnostics(program)
      const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      if (errors.length) {
        for (const diagnostic of errors) {
          const current = checked.find((sample) => path.resolve(sample.path) === path.resolve(diagnostic.file?.fileName ?? ''))
          const position = diagnostic.file && diagnostic.start !== undefined
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            : null
          const line = current && position ? current.line + position.line : current?.line
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
          console.error((current?.file ?? diagnostic.file?.fileName ?? 'TypeScript') + ':' + (line ?? '') + ': ' + message)
        }
        console.error('Documentation typecheck failed: ' + errors.length + ' error(s) across ' + checked.length + ' sample(s).')
        process.exitCode = 1
      } else {
        console.log('Documentation typecheck passed: ' + checked.length + ' sample(s) checked against the built package.')
      }
    }
  }
  if (skipped.length) console.log('Skipped ' + skipped.length + ' explicitly marked no-check sample(s).')
  console.log('Found ' + samples.length + ' TypeScript sample(s); ' + checked.length + ' checked, ' + skipped.length + ' skipped.')
}

await rm(temp, { recursive: true, force: true })
