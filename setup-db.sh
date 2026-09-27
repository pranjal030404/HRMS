#!/usr/bin/env bash
# Creates the hrms database + app user on the SYSTEM MySQL/MariaDB (port 3306).
# Run with:  sudo bash setup-db.sh
# If you use the bundled user-level instance (port 3307), this is not needed.
set -e
mysql -e "CREATE DATABASE IF NOT EXISTS hrms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -e "CREATE USER IF NOT EXISTS 'hrms_app'@'localhost' IDENTIFIED BY 'HrmsApp@2026';"
mysql -e "CREATE USER IF NOT EXISTS 'hrms_app'@'127.0.0.1' IDENTIFIED BY 'HrmsApp@2026';"
mysql -e "GRANT ALL PRIVILEGES ON hrms.* TO 'hrms_app'@'localhost'; GRANT ALL PRIVILEGES ON hrms.* TO 'hrms_app'@'127.0.0.1'; FLUSH PRIVILEGES;"
echo "✔ Database 'hrms' and user 'hrms_app' ready."
echo "→ Make sure backend/.env has DB_PORT=3306, then run: cd backend && npm run db:migrate && npm run db:seed"
