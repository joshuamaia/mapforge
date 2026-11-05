let counter = 0;

/** Identificador único local. Não precisa ser criptográfico. */
export function newId(prefix = 'id'): string {
  counter++;
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}_${random}`;
}
