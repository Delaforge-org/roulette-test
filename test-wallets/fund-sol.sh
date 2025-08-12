#!/usr/bin/env bash
set -euo pipefail

# Добавляем стандартный путь установки Solana в PATH
export PATH="${HOME}/.local/share/solana/install/active_release/bin:${PATH}"

# --- Настройка ---
# Убедитесь, что ваш solana CLI настроен на devnet и использует кошелек,
# с которого будет идти оплата за транзакции.
# Пример:
# solana config set --url https://api.devnet.solana.com
# solana config set --keypair ~/.config/solana/id.json

# Перейти в директорию, где находится скрипт
cd "$(dirname "$0")"

# Сумма в SOL для отправки на каждый кошелек
AMOUNT=0.05

# Новые группы кошельков, на которые нужно отправить SOL
TICKERS=(GRN MAR SAO LOI USDC OLS)

echo "=== Начало пополнения кошельков на $AMOUNT SOL ==="

for ticker in "${TICKERS[@]}"; do
  echo ""
  echo "== Пополнение кошельков в группе $ticker =="
  
  ADDR_FILE="$ticker/addresses.txt"
  if [[ ! -f "$ADDR_FILE" ]]; then
    echo "ОШИБКА: Файл адресов не найден: $ADDR_FILE" >&2
    echo "Пожалуйста, сначала запустите ./generate-wallets.sh" >&2
    exit 1
  fi

  num_wallets=$(wc -l < "$ADDR_FILE")
  i=0

  while read -r addr; do
    i=$((i+1))
    printf "Транзакция %d/%d: Отправка %s SOL на %s... " "$i" "$num_wallets" "$AMOUNT" "$addr"
    
    # Отправляем SOL, используя RPC Syndica
    solana transfer \
      "$addr" \
      "$AMOUNT" \
      --allow-unfunded-recipient \
      --url https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM \
      --fee-payer ~/.config/solana/id.json # ВАЖНО: Укажите здесь путь к вашему основному кошельку-плательщику

    echo "OK"
    sleep 1 # Небольшая задержка для стабильности
  done < "$ADDR_FILE"
done

echo ""
echo "✅ Пополнение всех 300 кошельков на $AMOUNT SOL завершено!"