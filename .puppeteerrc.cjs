const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Descarga el navegador en una carpeta .cache dentro de tu proyecto
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};