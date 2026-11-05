/** Templates de runtime carregados como texto (loader `.txt` do esbuild). */
declare module '*.txt' {
  const content: string;
  export default content;
}
