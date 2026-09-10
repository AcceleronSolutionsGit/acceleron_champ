module.exports = {
  apps: [
    {
      name: "acceleron-champ-tool",

      cwd: "/srv/www/htdocs/acceleron_champ",

      script: "server/dist/index.js",

      instances: 1,

      exec_mode: "fork",

      autorestart: true,

      watch: false,

      max_memory_restart: "500M",

      env: {
        NODE_ENV: "development",
        PORT: 8081
      },

      env_production: {
        NODE_ENV: "production",
        PORT: 8081
      },

      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
      log_file: "./logs/combined.log",

      time: true
    }
  ]
};
