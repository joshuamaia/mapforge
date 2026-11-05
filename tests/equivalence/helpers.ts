import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { executeMappings } from '../../src/app/core/mapping-engine/engine';
import { JsonValue } from '../../src/app/core/models/json.model';
import { ProjectDocument } from '../../src/app/core/models/project.model';
import { FieldNode } from '../../src/app/core/models/schema.model';
import { parseStructure } from '../../src/app/core/parsers/structure';
import { GeneratedFile } from '../../src/app/core/code-generators/types';
import { getterName, javaType, setterName } from '../../src/app/core/code-generators/java-model';
import { TypeNamer } from '../../src/app/core/code-generators/plan';

export function engineOutput(doc: ProjectDocument, input?: JsonValue): JsonValue {
  const data = input ?? (JSON.parse(doc.sampleData) as JsonValue);
  return executeMappings({ source: data, mappings: doc.mappings, scopes: doc.scopes }).output;
}

/** Remove nulos e objetos vazios: em POJO, ausente e null são indistinguíveis. */
export function normalize(value: JsonValue | undefined): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => normalize(v) ?? null);
  if (typeof value === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const v = normalize(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

// ---------------------------------------------------------------- TypeScript

/** Faz a checagem de tipos em modo strict; devolve as mensagens de erro. */
export function typeCheck(code: string, extraFiles: Record<string, string> = {}): string[] {
  const fileName = '/generated/mapper.ts';
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  const virtual: Record<string, string> = { [fileName]: code, ...extraFiles };
  host.getSourceFile = (name, version) =>
    virtual[name] !== undefined
      ? ts.createSourceFile(name, virtual[name], version, true)
      : original(name, version);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (name) => virtual[name] ?? readFile(name);
  host.fileExists = (name) => virtual[name] !== undefined || fileExists(name);
  const program = ts.createProgram([fileName, ...Object.keys(extraFiles)], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) =>
        ts.flattenDiagnosticMessageText(d.messageText, '\n') +
        (d.start !== undefined && d.file
          ? ` @${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
          : ''),
    );
}

/** Executa o TypeScript gerado (transpilado) e devolve a função exportada. */
export function loadGeneratedTs(code: string): Record<string, (...args: unknown[]) => unknown> {
  const js = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
    },
  }).outputText;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  // Apenas nos testes: o aplicativo nunca executa código dinâmico.
  const run = new Function('exports', 'require', js);
  run(exports, (id: string) => {
    if (id === '@angular/core') return { Injectable: () => () => undefined };
    throw new Error(`Módulo inesperado: ${id}`);
  });
  return exports;
}

// ---------------------------------------------------------------- Java

export const javaAvailable = (() => {
  try {
    return spawnSync('javac', ['-version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
})();

const JAR_CACHE = resolve('tests/equivalence/.java-cache');
const MAPSTRUCT_VERSION = '1.6.3';

/** Baixa os jars do MapStruct uma vez. Sem rede, os testes correspondentes são ignorados. */
export async function mapstructJars(): Promise<{ api: string; processor: string } | null> {
  mkdirSync(JAR_CACHE, { recursive: true });
  const get = async (artifact: string): Promise<string> => {
    const file = join(JAR_CACHE, `${artifact}-${MAPSTRUCT_VERSION}.jar`);
    if (!existsSync(file)) {
      const url = `https://repo1.maven.org/maven2/org/mapstruct/${artifact}/${MAPSTRUCT_VERSION}/${artifact}-${MAPSTRUCT_VERSION}.jar`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    return file;
  };
  try {
    return { api: await get('mapstruct'), processor: await get('mapstruct-processor') };
  } catch {
    return null;
  }
}

export interface JavaProject {
  dir: string;
  cleanup(): void;
}

/** Separa várias classes de nível superior em arquivos, como o javac exige para as públicas. */
function writeSource(dir: string, pkg: string, name: string, content: string): void {
  const target = join(dir, ...pkg.split('.'));
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, name), content);
}

export function withoutPackage(file: GeneratedFile): GeneratedFile {
  return { ...file, content: file.content.replace(/^package [^;]+;\s*/m, '') };
}

const pkgOf = (content: string): string => /^package ([^;]+);/m.exec(content)?.[1] ?? '';

let varCounter = 0;

/** Constrói o objeto de entrada em Java a partir do JSON, usando os setters reais. */
export function javaObjectExpr(
  value: JsonValue | undefined,
  node: FieldNode,
  namer: TypeNamer,
  fromJava: boolean,
): string {
  if (value === null || value === undefined) return 'null';
  const type = javaType(node, namer, fromJava);
  const build = (cls: string, children: FieldNode[], data: { [k: string]: JsonValue }): string => {
    const o = `o${++varCounter}`;
    const sets = children
      .filter((c) => data[c.name] !== undefined && data[c.name] !== null)
      .map((c) => `${o}.${setterName(c)}(${javaObjectExpr(data[c.name], c, namer, fromJava)});`);
    return `((java.util.function.Supplier<${cls}>) () -> { ${cls} ${o} = new ${cls}(); ${sets.join(' ')} return ${o}; }).get()`;
  };
  if (node.type === 'object') {
    return build(namer.nameOf(node), node.children ?? [], value as { [k: string]: JsonValue });
  }
  if (node.type === 'array') {
    const children = node.children ?? [];
    const items = (value as JsonValue[]).map((v) => {
      if (children.length && children[0].name === '[*]')
        return javaObjectExpr(v, children[0], namer, fromJava);
      return build(namer.nameOf(node), children, v as { [k: string]: JsonValue });
    });
    const element = /^List<(.*)>$/.exec(type)?.[1] ?? 'Object';
    return `new java.util.ArrayList<${element}>(java.util.Arrays.<${element}>asList(${items.join(', ')}))`;
  }
  if (typeof value === 'string') {
    if (node.type === 'date') return `java.time.LocalDate.parse(${JSON.stringify(value)})`;
    if (node.type === 'datetime') {
      return type === 'OffsetDateTime'
        ? `java.time.OffsetDateTime.parse(${JSON.stringify(value)})`
        : `java.time.LocalDateTime.parse(${JSON.stringify(value)})`;
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  const n = value as number;
  switch (type) {
    case 'Long':
      return `${Math.trunc(n)}L`;
    case 'Integer':
    case 'int':
      return `${Math.trunc(n)}`;
    case 'BigDecimal':
      return `new java.math.BigDecimal("${n}")`;
    case 'Double':
    case 'double':
      return `${n}d`;
    default:
      return `${n}d`;
  }
}

/** Serializador mínimo por reflexão, só para o teste. */
const JSON_PRINTER = `
  static String toJson(Object v) throws Exception {
    if (v == null) return "null";
    if (v instanceof String || v instanceof java.time.temporal.Temporal || v instanceof Enum<?>) {
      String text = v instanceof java.time.LocalDateTime t ? t.format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss"))
          : v instanceof java.time.OffsetDateTime o ? o.format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX"))
          : String.valueOf(v);
      return "\\"" + text.replace("\\\\", "\\\\\\\\").replace("\\"", "\\\\\\"") + "\\"";
    }
    if (v instanceof Number || v instanceof Boolean) {
      if (v instanceof java.math.BigDecimal b) return String.valueOf(b.doubleValue());
      return String.valueOf(v);
    }
    if (v instanceof java.util.Collection<?> c) {
      StringBuilder b = new StringBuilder("[");
      boolean first = true;
      for (Object x : c) { if (!first) b.append(','); first = false; b.append(toJson(x)); }
      return b.append(']').toString();
    }
    StringBuilder b = new StringBuilder("{");
    boolean first = true;
    java.lang.reflect.Field[] fields = v.getClass().getDeclaredFields();
    for (java.lang.reflect.Field f : fields) {
      if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
      f.setAccessible(true);
      Object x = f.get(v);
      if (x == null) continue;
      if (!first) b.append(','); first = false;
      b.append('"').append(f.getName()).append("\\":").append(toJson(x));
    }
    return b.append('}').toString();
  }
`;

export interface JavaRunInput {
  files: GeneratedFile[];
  mapperCall: (source: string) => string;
  doc: ProjectDocument;
  input: JsonValue;
  classpath?: string[];
  processorPath?: string;
}

/** Compila com javac e executa; devolve o JSON produzido. */
export function compileAndRunJava(run: JavaRunInput): JsonValue {
  const dir = mkdtempSync(join(tmpdir(), 'mapforge-java-'));
  try {
    const src = join(dir, 'src');
    const out = join(dir, 'out');
    mkdirSync(src);
    mkdirSync(out);
    const pkg = pkgOf(run.files[0].content);
    for (const f of run.files) writeSource(src, pkgOf(f.content), f.name, f.content);
    // Classes Java importadas pelo usuário entram como foram declaradas.
    let extra = 0;
    for (const side of [run.doc.source, run.doc.target]) {
      if (side.format === 'java') {
        const text = side.text.replace(/@NotNull\s*/g, '').replace(/@NotBlank\s*/g, '');
        writeSource(src, pkgOf(text), `${side.rootName}.java`, text);
        extra++;
      }
    }
    void extra;
    const source = parseStructure(run.doc.source);
    const target = parseStructure(run.doc.target);
    const namer = new TypeNamer(source.root, target.root, source.rootName, target.rootName);
    const expr = javaObjectExpr(
      run.input,
      source.root as FieldNode,
      namer,
      run.doc.source.format === 'java',
    );
    const harness = `${pkg ? `package ${pkg};\n` : ''}
import java.math.BigDecimal;
import java.time.*;
import java.util.*;

public class Harness {
${JSON_PRINTER}
  public static void main(String[] args) throws Exception {
    var source = ${expr};
    System.out.print(toJson(${run.mapperCall('source')}));
  }
}
`;
    writeSource(src, pkg, 'Harness.java', harness);
    const list = join(dir, 'sources.txt');
    const sources = walk(src);
    writeFileSync(list, sources.map((s) => `"${s.replace(/\\/g, '/')}"`).join('\n'));
    const sep = process.platform === 'win32' ? ';' : ':';
    const cp = (run.classpath ?? []).join(sep);
    const args = ['-nowarn', '-d', out, '-encoding', 'UTF-8'];
    if (cp) args.push('-cp', cp);
    if (run.processorPath) args.push('-processorpath', run.processorPath, '-s', out);
    else args.push('-proc:none');
    args.push(`@${list}`);
    const javac = spawnSync('javac', args, { encoding: 'utf8' });
    if (javac.status !== 0) {
      throw new Error(
        `javac falhou:\n${javac.stdout}\n${javac.stderr}\n\n--- código ---\n${run.files.map((f) => `// ${f.name}\n${f.content}`).join('\n')}`,
      );
    }
    const main = pkg ? `${pkg}.Harness` : 'Harness';
    const output = execFileSync(
      'java',
      ['-Dstdout.encoding=UTF-8', '-cp', [out, ...(run.classpath ?? [])].join(sep), main],
      { encoding: 'utf8' },
    );
    return JSON.parse(output) as JsonValue;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walk(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
