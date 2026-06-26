#!/bin/bash
# Script de sync para cron. Ejecuta tsx con las variables del proyecto.
# Agregar al cron con: crontab -e
#
# Ejemplo — cada 30 min de 7:00 a 23:00:
#   */30 7-22 * * * /Users/fran/Desktop/bv-mcp-atc/mcp/atc/sync-cron.sh >> /Users/fran/Desktop/bv-mcp-atc/mcp/atc/sync.log 2>&1

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Cargar nvm si existe (necesario cuando cron no tiene PATH completo)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" --no-use

exec npx tsx src/sync.ts
