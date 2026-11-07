// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'tiktok-wa-bot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '800M',
    },
  ],
}
