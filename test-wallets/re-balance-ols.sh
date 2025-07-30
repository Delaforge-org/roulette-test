#!/usr/bin/env bash
set -euo pipefail

# --- Конфигурация ---
OLS_MINT="5ei1ggNH5vjdMVvXbAENiehBmwhHhB2v45ddTigVgdUM"
TICKER="OLS"
FEE_PAYER_WALLET="$HOME/.config/solana/id.json"
RPC_URL="https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM"

# --- Подготовка ---
cd "$(dirname "$0")"
WALLETS_DIR="$TICKER"
ADDRESS_FILE="$WALLETS_DIR/addresses.txt"
MAIN_WALLET_PUBKEY=$(solana-keygen pubkey "$FEE_PAYER_WALLET")

echo "--- Перебалансировка $TICKER (финальная версия) ---"
echo "Основной кошелек (плательщик комиссий): $MAIN_WALLET_PUBKEY"

# --- ФАЗА 1: Консолидация ---
echo -e "\n>>> ФАЗА 1: Сбор токенов..."

total_consolidated_balance=0
i=0
WALLETS_PER_GROUP=$(wc -l < "$ADDRESS_FILE")

for keypair_file in "$WALLETS_DIR"/"$TICKER"-wallet-*.json; do
    i=$((i+1))
    wallet_pubkey=$(solana-keygen pubkey "$keypair_file")
    echo -e "\n--- Проверка кошелька $i/$WALLETS_PER_GROUP ($wallet_pubkey) ---"

    wallet_ata=$(spl-token address --token "$OLS_MINT" --owner "$wallet_pubkey" --url "$RPC_URL" --verbose | grep "Associated token address:" | cut -d ' ' -f 4)
    echo "[1] Адрес ATA: '$wallet_ata'"
    echo "[2] Запрос данных аккаунта..."

    # Правильная обработка возможной ошибки "AccountNotFound"
    if account_info=$(solana account "$wallet_ata" --url "$RPC_URL" --output json 2>/dev/null); then
        # Успех: аккаунт существует. Извлекаем баланс.
        balance_value=$(echo "$account_info" | jq -r '.data.parsed.info.tokenAmount.uiAmount')
        
        if (( $(echo "$balance_value <= 0" | bc -l) )); then
            echo "    -> Баланс 0. Пропускаем."
            continue
        fi
        
        echo "    -> НАЙДЕН БАЛАНС: $balance_value"

        # Шаг 3: Переводим токены
        printf "[3] Перевод %s OLS на основной кошелек...\n" "$balance_value"
        spl-token transfer \
            --url "$RPC_URL" --fee-payer "$FEE_PAYER_WALLET" --owner "$keypair_file" \
            "$OLS_MINT" "$balance_value" "$MAIN_WALLET_PUBKEY" --allow-unfunded-recipient
        
        echo "    -> Перевод завершен."
        total_consolidated_balance=$(echo "$total_consolidated_balance + $balance_value" | bc)
    else
        # Ошибка: скорее всего, аккаунт не найден. Это нормально.
        echo "    -> Аккаунт не найден. Баланс 0. Пропускаем."
        continue
    fi
done

echo -e "\n>>> ФАЗА 1 ЗАВЕРШЕНА: Общий собранный баланс: $total_consolidated_balance OLS"

# --- ФАЗА 2: Равномерное перераспределение токенов ---
echo ""
echo ">>> ФАЗА 2: Перераспределение токенов..."

if (( $(echo "$total_consolidated_balance <= 0" | bc -l) )); then
    echo "Общий баланс равен 0 или меньше. Нечего перераспределять. Выход."
    exit 0
fi

amount_per_wallet=$(echo "scale=6; $total_consolidated_balance / $WALLETS_PER_GROUP" | bc)
echo "Каждый кошелек получит по $amount_per_wallet OLS."

i=0
while read -r recipient_pubkey; do
    i=$((i+1))
    printf "Перевод на кошелек %d/%d (%s...%s)...\n" "$i" "$WALLETS_PER_GROUP" "${recipient_pubkey:0:5}" "${recipient_pubkey: -5}"
    spl-token transfer \
        "$OLS_MINT" "$amount_per_wallet" "$recipient_pubkey" \
        --owner "$FEE_PAYER_WALLET" --fee-payer "$FEE_PAYER_WALLET" \
        --fund-recipient --url "$RPC_URL"
    echo "Перевод завершен."
done < "$ADDRESS_FILE"

echo ""
echo "🎉 Перебалансировка завершена!"