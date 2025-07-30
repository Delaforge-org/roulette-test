#!/usr/bin/env bash
set -euo pipefail

# Перейти в директорию, где находится скрипт
cd "$(dirname "$0")"

echo "=== Проверка и генерация недостающих кошельков ==="

# Группы кошельков, которые должны существовать
tickers_to_generate=(GRN MAR SAO LOI USDC OLS)
WALLETS_PER_TICKER=50

# Для каждого тикера
for ticker in "${tickers_to_generate[@]}"; do
  if [ -d "$ticker" ]; then
    echo "-> Директория для группы $ticker уже существует, пропускаем."
  else
    echo "== Генерация для группы $ticker =="
    mkdir -p "$ticker"
    addr_file="$ticker/addresses.txt"
    : > "$addr_file"  # обнуляем файл адресов

    # Генерируем 50 keypair’ов
    for i in $(seq 1 $WALLETS_PER_TICKER); do
      keypath="$ticker/$ticker-wallet-$i.json"
      solana-keygen new \
        --no-bip39-passphrase \
        --outfile "$keypath" \
        --force >/dev/null
      pubkey=$(solana-keygen pubkey "$keypath")
      echo "$pubkey" >> "$addr_file"
    done

    echo "-> $ticker: создано $WALLETS_PER_TICKER кошельков, адреса сохранены в $addr_file"
  fi
done

echo ""
echo "=== Генерация кошельков завершена. ==="