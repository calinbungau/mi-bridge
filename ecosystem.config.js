// pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'mi-bridge',
    script: 'mi-bridge.js',
    args: '-c config.yaml',
    cwd: __dirname,
    instances: 1,            // o singură conexiune SSH per login MI!
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 60000,    // spec: așteaptă 1 min înainte de reconectare
    max_memory_restart: '200M',
    kill_timeout: 3000,
    env: { NODE_ENV: 'production' },
    time: true,              // timestamp pe fiecare linie de log
    out_file: 'logs/out.log',
    error_file: 'logs/err.log',
    merge_logs: true,
  }],
};
