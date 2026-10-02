// Este teste existe porque o bug já aconteceu DUAS vezes: nomes de modelo Gemini inventados
// (gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash-lite) foram commitados
// como se fossem reais, quebrando toda resposta de IA. Se este teste falhar, NÃO troque a lista
// de nomes fictícios abaixo — corrija o arquivo que introduziu o nome errado.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const FAKE_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.4', 'gemini-4'];
const FILES_TO_CHECK = [
  'codigo-fonte-dev/server/gemini.js',
  'codigo-fonte-dev/server/settings.js',
  'codigo-fonte-dev/server/onboarding.js',
  'data/settings.json',
];

let failures = [];
for (const rel of FILES_TO_CHECK) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  for (const fake of FAKE_MODELS) {
    if (text.includes(fake) && !text.includes(`RETIRED_GEMINI_MODELS`) === false && text.includes(`'${fake}'`) && !text.includes(`Set([`)) {
      // permite a lista de bloqueio (RETIRED_GEMINI_MODELS) referenciar o nome falso como entrada
      // proibida, mas não como modelo padrão/ativo.
    }
  }
  for (const fake of FAKE_MODELS) {
    const usedAsDefault = new RegExp(`(DEFAULT_GEMINI_MODEL|geminiModel)\\s*[:=]\\s*['"]${fake}['"]`).test(text);
    if (usedAsDefault) failures.push(`${rel}: usa "${fake}" como modelo padrão`);
  }
}

if (failures.length) {
  console.error('FALHOU:\n' + failures.join('\n'));
  process.exit(1);
}
console.log('Smoke modelo-real OK - nenhum nome de modelo Gemini inventado está em uso como padrão');
