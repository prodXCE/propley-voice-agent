module.exports = {
  apps: [
    {
      name: "propley-voice-agent",
      script: "./dist/index.js",
      args: "start",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};