// Resolve hook: redirect ratings.js's CDN OpenSkill import to the local install
// so the real ratings.js can run under Node without network imports.
const esmEntry = new URL('./node_modules/openskill/dist/index.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('https://esm.sh/openskill')) {
    return { url: esmEntry, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
