// Browser scripts ship as plain JS, types stripped.
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const EXPERIMENTAL = 'stripTypeScriptTypes';

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (String(message).includes(EXPERIMENTAL)) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export function stripTypes(src: string): string {
  return stripTypeScriptTypes(src, { mode: 'strip' });
}

/** Inline-script bytes the CSP hash covers: stripped, trimmed, `</script`
 *  neutralised so the script cannot end early. */
export function readInlineScript(absPath: string): string {
  return stripTypes(fs.readFileSync(absPath, 'utf8'))
    .trim()
    .replace(/<\/script/gi, '<\\/script');
}