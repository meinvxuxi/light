// PM2 上线配置：npm i -g pm2 && pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [{
    name: 'light',
    script: 'server.js',
    cwd: __dirname + '/..',
    instances: 1,
    autorestart: true,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: '3000',
      HOST: '0.0.0.0',
      PERSIST_ACHIEVEMENTS: 'true',
      PERSIST_TIMELINE: 'true',
      PERSIST_SYNC: 'true',
      PERSIST_BOARD: 'true'
    }
  }]
};