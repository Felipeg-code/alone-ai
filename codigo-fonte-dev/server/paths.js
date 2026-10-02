// paths.js — resolve recursos no .exe e no código-fonte.
const path = require('path');
const isPackaged = Boolean(process.pkg);
// server/ fica em codigo-fonte-dev/server; dados públicos ficam na raiz do pacote distribuído.
const baseDir = process.env.ALONE_BASE_DIR || process.env.RA_BOT_BASE_DIR || (isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..')); 
module.exports = {
  isPackaged, baseDir,
  dataDir: path.join(baseDir, 'data'),
  publicDir: path.join(baseDir, 'public'),
  audioDir: path.join(baseDir, 'audio'),
};
