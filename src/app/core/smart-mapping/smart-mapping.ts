import { Mapping } from '../models/mapping.model';
import { FieldNode, FieldType } from '../models/schema.model';
import { countWildcards, parsePathOrEmpty } from '../mapping-engine/path';
import { flattenFields } from '../parsers/structure';
import { typeCompatibility } from '../validators/type-compat';
import { DEFAULT_SYNONYMS, SynonymGroup } from './synonyms';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface MappingSuggestion {
  id: string;
  sourcePath: string;
  targetPath: string;
  sourceType: FieldType;
  targetType: FieldType;
  level: ConfidenceLevel;
  /** Pontuação ordinal usada só para ordenar; não é uma probabilidade. */
  rank: number;
  /** Regras que produziram a sugestão, em linguagem natural. */
  reasons: string[];
  /** Há outra correspondência equivalente: nunca deve ser aceita em lote. */
  ambiguous: boolean;
  alternatives: string[];
}

/** Divide `nomeCompleto`, `nome_completo`, `nome-completo` e `HTTPStatus` em palavras normalizadas. */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.$]+/)
    .map(normalizeWord)
    .filter((w) => w.length > 0);
}

function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Índice para consulta rápida de sinônimos, separando ligações fortes e fracas. */
class SynonymIndex {
  private readonly strong = new Map<string, Set<string>>();
  private readonly weak = new Map<string, Set<string>>();

  constructor(groups: readonly SynonymGroup[]) {
    for (const group of groups) {
      const terms = group.terms.map(normalizeWord).filter((t) => t !== '');
      const target = group.weak ? this.weak : this.strong;
      for (const a of terms) {
        const set = target.get(a) ?? new Set<string>();
        for (const b of terms) if (a !== b) set.add(b);
        target.set(a, set);
      }
    }
  }

  relation(a: string, b: string): 'same' | 'strong' | 'weak' | null {
    if (a === b) return 'same';
    if (this.strong.get(a)?.has(b)) return 'strong';
    if (this.weak.get(a)?.has(b)) return 'weak';
    return null;
  }
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

interface NameMatch {
  rule: 'exact' | 'normalized' | 'synonym' | 'partial-synonym' | 'similar' | 'weak-synonym';
  /** Pontos determinísticos da regra. */
  points: number;
  reason: string;
}

/** Empareia palavras dos dois nomes; devolve quantas casaram e de que forma. */
function matchWords(
  a: string[],
  b: string[],
  index: SynonymIndex,
): { matched: number; usedSynonym: boolean; usedWeak: boolean } {
  const remaining = [...b];
  let matched = 0;
  let usedSynonym = false;
  let usedWeak = false;
  // Primeiro as relações exatas e fortes, para o sinônimo fraco não consumir uma palavra melhor.
  const pending: string[] = [];
  for (const wa of a) {
    const i = remaining.findIndex((wb) => {
      const rel = index.relation(wa, wb);
      return rel === 'same' || rel === 'strong';
    });
    if (i >= 0) {
      if (index.relation(wa, remaining[i]) === 'strong') usedSynonym = true;
      remaining.splice(i, 1);
      matched++;
    } else {
      pending.push(wa);
    }
  }
  for (const wa of pending) {
    const i = remaining.findIndex((wb) => index.relation(wa, wb) === 'weak');
    if (i >= 0) {
      remaining.splice(i, 1);
      matched++;
      usedWeak = true;
    }
  }
  return { matched, usedSynonym, usedWeak };
}

function compareNames(
  sourceName: string,
  targetName: string,
  index: SynonymIndex,
): NameMatch | null {
  if (sourceName === targetName) {
    return { rule: 'exact', points: 100, reason: `Nomes idênticos: "${sourceName}".` };
  }
  const a = splitWords(sourceName);
  const b = splitWords(targetName);
  if (a.length === 0 || b.length === 0) return null;
  if (a.join('') === b.join('')) {
    return {
      rule: 'normalized',
      points: 90,
      reason: 'Mesmo nome após normalizar camelCase, snake_case, kebab-case e maiúsculas.',
    };
  }
  const { matched, usedSynonym, usedWeak } = matchWords(a, b, index);
  const longest = Math.max(a.length, b.length);
  if (matched === longest) {
    if (usedWeak) {
      return {
        rule: 'weak-synonym',
        points: 40,
        reason: 'Palavras relacionadas por sinônimo fraco: a equivalência precisa de confirmação.',
      };
    }
    return {
      rule: 'synonym',
      points: usedSynonym ? 80 : 85,
      reason: usedSynonym
        ? `Todas as palavras equivalem por sinônimo (${a.join(' ')} → ${b.join(' ')}).`
        : 'As mesmas palavras em outra ordem.',
    };
  }
  if (matched > 0 && !usedWeak && matched >= Math.ceil(longest / 2)) {
    return {
      rule: 'partial-synonym',
      points: 45,
      reason: `${matched} de ${longest} palavras equivalentes (${a.join(' ')} → ${b.join(' ')}).`,
    };
  }
  const joinedA = a.join('');
  const joinedB = b.join('');
  const distance = levenshtein(joinedA, joinedB);
  const size = Math.max(joinedA.length, joinedB.length);
  if (size >= 4 && distance <= Math.floor(size / 4)) {
    return {
      rule: 'similar',
      points: 55,
      reason: `Nomes parecidos: diferença de ${distance} ${distance === 1 ? 'letra' : 'letras'}.`,
    };
  }
  return null;
}

function parentWords(path: string): string[] {
  return parsePathOrEmpty(path)
    .slice(0, -1)
    .flatMap((s) => (s.kind === 'prop' ? splitWords(s.name) : []));
}

function fieldName(node: FieldNode, path: string): string {
  if (node.name !== '[*]') return node.name;
  // Item primitivo de lista: usa o nome do array.
  const segs = parsePathOrEmpty(path).filter((s) => s.kind === 'prop');
  const last = segs[segs.length - 1];
  return last && last.kind === 'prop' ? last.name : node.name;
}

export interface SmartMappingOptions {
  synonyms?: readonly SynonymGroup[];
  existing?: readonly Mapping[];
}

const isMappable = (n: FieldNode): boolean =>
  n.type !== 'object' && !(n.type === 'array' && (n.children?.length ?? 0) > 0);

/**
 * Sugere correspondências por regras determinísticas e explicáveis. O nível resulta das regras
 * aplicadas: nomes iguais ou sinônimos fortes com tipos compatíveis dão confiança alta; sinônimo
 * fraco nunca passa de baixa. Nada é aplicado sem o aceite do usuário.
 */
export function suggestMappings(
  sourceRoot: FieldNode | null,
  targetRoot: FieldNode | null,
  options: SmartMappingOptions = {},
): MappingSuggestion[] {
  const index = new SynonymIndex(options.synonyms ?? DEFAULT_SYNONYMS);
  const existing = options.existing ?? [];
  const mappedTargets = new Set(existing.map((m) => m.targetPath));
  const mappedSources = new Set(existing.map((m) => m.sourcePath));
  const sources = flattenFields(sourceRoot).filter(
    (n) => isMappable(n) && !mappedSources.has(n.path),
  );
  const targets = flattenFields(targetRoot).filter(
    (n) => isMappable(n) && !mappedTargets.has(n.path),
  );

  const candidates: MappingSuggestion[] = [];
  for (const t of targets) {
    const tWords = parentWords(t.path);
    const tDepth = countWildcards(parsePathOrEmpty(t.path));
    for (const s of sources) {
      const nameMatch = compareNames(fieldName(s, s.path), fieldName(t, t.path), index);
      if (!nameMatch) continue;
      const compat = typeCompatibility(s.type, t.type);
      if (compat === 'incompatible') continue;
      const reasons = [nameMatch.reason];
      let points = nameMatch.points;
      if (compat === 'exact') reasons.push(`Tipos compatíveis (${s.type}).`);
      else {
        points -= 15;
        reasons.push(`Tipos diferentes exigem conversão (${s.type} → ${t.type}).`);
      }
      const sWords = parentWords(s.path);
      if (sWords.length > 0 && tWords.length > 0) {
        if (matchWords(sWords, tWords, index).matched > 0) {
          points += 8;
          reasons.push('Os caminhos hierárquicos são equivalentes.');
        } else {
          points -= 8;
          reasons.push('Os objetos pais têm nomes diferentes.');
        }
      }
      const sDepth = countWildcards(parsePathOrEmpty(s.path));
      if (sDepth === tDepth && sDepth > 0) {
        points += 5;
        reasons.push('Mesmo nível de array.');
      } else if (sDepth !== tDepth) {
        points -= 25;
        reasons.push('Níveis de array diferentes: pode exigir agregação.');
      }
      const level = levelOf(nameMatch, points, compat === 'exact', sDepth === tDepth);
      candidates.push({
        id: `${s.path}=>${t.path}`,
        sourcePath: s.path,
        targetPath: t.path,
        sourceType: s.type,
        targetType: t.type,
        level,
        rank: points,
        reasons,
        ambiguous: false,
        alternatives: [],
      });
    }
  }
  return resolveAssignments(candidates);
}

function levelOf(
  match: NameMatch,
  points: number,
  sameType: boolean,
  sameDepth: boolean,
): ConfidenceLevel {
  if (match.rule === 'weak-synonym') return 'low';
  if (!sameDepth) return 'low';
  if (points >= 75 && (sameType || match.rule === 'exact' || match.rule === 'normalized'))
    return 'high';
  if (points >= 50) return 'medium';
  return 'low';
}

/** Mantém o melhor candidato de cada destino, sem repetir origem, e marca os empates. */
function resolveAssignments(candidates: MappingSuggestion[]): MappingSuggestion[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      b.rank - a.rank ||
      a.targetPath.localeCompare(b.targetPath) ||
      a.sourcePath.localeCompare(b.sourcePath),
  );
  const usedSources = new Set<string>();
  const usedTargets = new Set<string>();
  const result: MappingSuggestion[] = [];
  for (const c of sorted) {
    if (usedSources.has(c.sourcePath) || usedTargets.has(c.targetPath)) continue;
    usedSources.add(c.sourcePath);
    usedTargets.add(c.targetPath);
    const rivals = sorted.filter(
      (o) =>
        o !== c &&
        o.rank === c.rank &&
        (o.targetPath === c.targetPath || o.sourcePath === c.sourcePath),
    );
    const alternatives = rivals.map((o) =>
      o.targetPath === c.targetPath ? o.sourcePath : o.targetPath,
    );
    const ambiguous = rivals.length > 0;
    result.push({
      ...c,
      ambiguous,
      alternatives,
      level: ambiguous && c.level === 'high' ? 'medium' : c.level,
      reasons: ambiguous
        ? [...c.reasons, `Ambíguo: empata com ${alternatives.join(', ')}. Confirme a escolha.`]
        : c.reasons,
    });
  }
  return result;
}
