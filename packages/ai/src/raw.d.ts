/** Vite/Vitest `?raw` imports (bundled text files such as the built-in SKILL.md files). */
declare module '*?raw' {
  const text: string;
  export default text;
}
