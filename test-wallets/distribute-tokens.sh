#!/usr/bin/env bash
set -euo pipefail

# --- Настройка ---
# Убедитесь, что ваш solana CLI настроен на devnet и использует кошелек, 
# на котором есть все необходимые токены для раздачи.
# Пример:
# solana config set --url https://api.devnet.solana.com
# solana config set --keypair ~/.config/solana/id.json

# Перейти в директорию, где находится скрипт
cd "$(dirname "$0")"

WALLETS_PER_GROUP=50

# --- Конфигурация токенов ---
# Ассоциативный массив: ТИКЕР -> АДРЕС МИНТА
declare -A MINTS=(
  #[GRN]=DhsFPhLMN1Bq8YQorjZZrYkZoZGHZxc6eemS3zzW5SCu
  # [MAR]=E3GVbwcczoM6HJnWHR1NJ2bJbpB5kDDTYqNpusEUec8M # Временно исключен
  #[SAO]=GyGq8CNEJuY6Dmefjut2jBCEuVAaFyBHCiqdUboHKXcS
  # [LOI]=Fvmu22STa3mYx2bHQHMeiSGYYCjtuAsMLFsVpNWuRwcJ # Временно исключен
  # [USDC]=4FiYqUg9gw5wyQ2po9RGp3EXZns48ZUD4quMwq53sdwT # Временно исключен
  [OLS]=5ei1ggNH5vjdMVvXbAENiehBmwhHhB2v45ddTigVgdUM
)

# Ассоциативный массив: ТИКЕР -> ОБЩЕЕ КОЛИЧЕСТВО токенов для раздачи (в обычных единицах, не в лампортах)
declare -A TOTAL_SUPPLY=(
  #[GRN]=20000000
  # [MAR]=30000000 # Временно исключен
  #[SAO]=15000000
  # [LOI]=2500000 # Временно исключен
  # [USDC]=100000 # Временно исключен
  [OLS]=180000000
)

# Ассоциативный массив: ТИКЕР -> Количество знаков после запятой (DECIMALS)
declare -A DECIMALS=(
  #[GRN]=9
  # [MAR]=6 # Временно исключен
  #[SAO]=6
  # [LOI]=6 # Временно исключен
  # [USDC]=6 # Временно исключен
  [OLS]=6
)

echo "=== Начало раздачи токенов ==="

for ticker in "${!MINTS[@]}"; do
  mint=${MINTS[$ticker]}
  total_amount=${TOTAL_SUPPLY[$ticker]}
  decimals=${DECIMALS[$ticker]}
  
  # Вычисляем количество токенов на один кошелек
  amount_per_wallet=$((total_amount / WALLETS_PER_GROUP))

  # Конвертируем в базовые единицы (лампорты)
  base_unit_amount=$(echo "$amount_per_wallet * 10^$decimals" | bc)

  echo ""
  echo "=== Раздача токена $ticker ($mint) ==="
  echo "Всего для раздачи: $total_amount. На каждый из $WALLETS_PER_GROUP кошельков: $amount_per_wallet токенов ($base_unit_amount базовых единиц)."

  addr_file="$ticker/addresses.txt"
  if [[ ! -f "$addr_file" ]]; then
    echo "КРИТИЧЕСКАЯ ОШИБКА: Файл с адресами не найден: $addr_file" >&2
    echo "Сначала запустите generate-wallets.sh" >&2
    exit 1
  fi

  # Проверяем, существует ли файл-маркер о пополнении.
  # Если да, то пропускаем эту группу.
  if [[ -f "$ticker/.funded" ]]; then
    echo "--- Группа $ticker уже была пополнена, пропускаем. ---"
    continue
  fi

  num_wallets=$(wc -l < "$addr_file")
  i=0

  while read -r recipient; do
    i=$((i+1))
    printf "\nТранзакция %d/%d: Отправка %s $ticker на %s... " "$i" "$num_wallets" "$amount_per_wallet" "$recipient"
    
    # Выполняем перевод
    spl-token transfer \
      "$mint" \
      "$amount_per_wallet" \
      "$recipient" \
      --fund-recipient \
      --allow-unfunded-recipient \
      --url https://solana-devnet.api.syndica.io/api-key/4djv6PYW55oz2xsz6fbdJJgKe5oAwj6cf8nRDgPMuXr3npvTQ6oxRkg45Nw7wgEaE63AhewBW7MaSTeU8JPv3gK6TfkfXufPDoM \
      --fee-payer ~/.config/solana/id.json # Укажите здесь путь к вашему основному кошельку
      
    echo "OK"
    sleep 0.5 
  done < "$addr_file"

  # Создаем файл-маркер, чтобы не пополнять повторно
  touch "$ticker/.funded"

done

echo ""
echo "🎉 Раздача всех токенов завершена!"