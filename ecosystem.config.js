module.exports = {
  apps: [
    {
      name: 'roulette-loop',
      script: 'test-orchestrator.js',
      // Эта строка - ключ к решению. Она заставляет PM2 работать 
      // в той же директории, где лежит этот файл.
      cwd: __dirname,
      watch: false,
      autorestart: true,
      // --- ФИНАЛЬНОЕ ИСПРАВЛЕНИЕ ---
      // Отключаем APM от PM2, который ломает require() на сервере
      pmx: false,
    },
  ],
}; 