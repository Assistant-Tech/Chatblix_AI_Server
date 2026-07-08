module.exports = {
  apps: [
    {
      name: 'chatblix-ai-backend',
      script: 'dist/main.js',
      cwd: __dirname,

      // Cluster across all available CPU cores.
      exec_mode: 'cluster',
      instances: 'max',

      env: {
        NODE_ENV: 'production',
        HOST: '10.66.66.1',
        PORT: 3000,
      },

      // Zero-downtime reloads: wait for app.listen() before swapping instances,
      // and give BullMQ workers time to finish in-flight jobs on shutdown.
      wait_ready: false,
      listen_timeout: 10000,
      kill_timeout: 15000,
      shutdown_with_message: false,

      // Restart policy.
      autorestart: true,
      max_restarts: 10,
      exp_backoff_restart_delay: 200,
      max_memory_restart: '768M',

      // Logs: one merged stream with timestamps instead of per-instance files.
      merge_logs: true,
      time: true,
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
    },
  ],
};
